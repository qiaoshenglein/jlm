// 代理出网：零依赖的 CONNECT 隧道 + 代理池调度。
// 之所以写在 server 层：边缘运行时不给了原始套接字，而「换出口防限流」恰恰只在自建部署上有意义。
// functions/proxy.mjs 管策略与池子状态，这个文件只管真正的那根线。
import net from 'node:net';
import tls from 'node:tls';
import dns from 'node:dns/promises';
import { gunzipSync, inflateSync, inflateRawSync, brotliDecompressSync } from 'node:zlib';
import { QUOTE_HOSTS } from '../functions/quotes.mjs';
import { setQuoteFetch } from '../functions/transport.mjs';
import {
  PROXY_DEFAULTS, addProxies, allowPrivateProxy, directReady, evictProxy, isPrivateHost,
  markProxyFail, markProxyOk, needsNewList, noteDirectFail, noteDirectOk, noteProbe, notePull,
  noteServed, parseProxyAddress, proxyCandidates, proxyPolicy, proxyStatus, setProxyRuntime,
} from '../functions/proxy.mjs';

const MAX_BYTES = 8 * 1024 * 1024;          // 单条行情响应远小于这个数，超了就是异常
const MAX_ATTEMPTS = 3;                      // 一次请求最多试几个出口（ latency 上限 = 3 × totalMs）
const BLOCKED_STATUS = new Set([403, 407, 418, 429]); // 上游按出口封/限流的状态码：换一个再试
const DIAL_TIMEOUT_CACHE_MS = 5 * 60_000;
// 活性检测打的是真实行情接口（和线上同一条路径），所以「这个代理能用」= 「这个代理能取到行情」
const PROBE_URL = 'https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=1&po=1&np=1&fltt=2&invt=2&fid=f6&fs=m:1+t:2&fields=f2,f12,f14';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36';
const allowedHosts = new Set(QUOTE_HOSTS.map((host) => String(host).toLowerCase()));

// DNS 结果缓存：代理域名往往轮换很快，但每次请求都查一遍 DNS 会把延迟翻倍
const dnsCache = new Map();

function fail(code, cause) {
  const error = new Error(code);
  error.proxyCause = cause ? String(cause).slice(0, 120) : null;
  return error;
}

/** 代理主机名解析出来的 IP 也必须不是内网——字面量检查挡不住 www.internal.example.com */
async function resolveProxyHost(host) {
  if (allowPrivateProxy()) return { ok: true, addresses: [] };
  if (net.isIP(host)) return isPrivateHost(host) ? { ok: false, reason: 'proxy_private_ip' } : { ok: true, addresses: [host] };
  const hit = dnsCache.get(host);
  if (hit && Date.now() - hit.at < DIAL_TIMEOUT_CACHE_MS) return hit.value;
  let value;
  try {
    const rows = await dns.lookup(host, { all: true, verbatim: true });
    const addresses = rows.map((row) => row.address);
    const bad = !addresses.length || addresses.some((address) => isPrivateHost(address));
    value = bad ? { ok: false, reason: 'proxy_resolves_private' } : { ok: true, addresses };
  } catch {
    value = { ok: false, reason: 'proxy_dns_failed' };
  }
  dnsCache.set(host, { at: Date.now(), value });
  return value;
}

const connectSocket = (opts) => new Promise((resolve, reject) => {
  const socket = net.connect(opts);
  const onError = (error) => { socket.destroy(); reject(error); };
  socket.once('error', onError);
  socket.once('connect', () => { socket.removeListener('error', onError); resolve(socket); });
});

const upgradeTls = (socket, opts) => new Promise((resolve, reject) => {
  const secure = tls.connect({ socket, ...opts }, () => resolve(secure));
  secure.once('error', reject);
});

const writeAll = (socket, text) => new Promise((resolve, reject) => {
  socket.write(text, (error) => (error ? reject(error) : resolve()));
});

/** 读到 EOF：请求头里带了 connection: close，所以上游会自己收尾，不用猜 Content-Length */
function readToEnd(socket, limit, deadline) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let timer = null;
    const done = (fn) => () => {
      clearTimeout(timer);
      socket.removeAllListeners('data');
      socket.removeAllListeners('end');
      socket.removeAllListeners('error');
      socket.removeAllListeners('close');
      fn();
    };
    timer = setTimeout(() => { socket.destroy(); done(() => reject(fail('proxy_timeout')))(); }, Math.max(200, deadline - Date.now()));
    socket.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) { socket.destroy(); done(() => reject(fail('proxy_too_large')))(); return; }
      chunks.push(chunk);
    });
    socket.once('end', done(() => resolve(Buffer.concat(chunks))));
    socket.once('error', done(() => reject(fail('proxy_socket_error'))));
    // 有些实现对 connection: close 回完数据就直接 close，不发 end
    socket.once('close', () => { if (chunks.length) done(() => resolve(Buffer.concat(chunks)))(); });
  });
}

function readHead(socket, deadline) {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const cleanup = () => {
      socket.removeAllListeners('data');
      socket.removeAllListeners('end');
      socket.removeAllListeners('error');
      clearTimeout(timer);
    };
    const timer = setTimeout(() => { cleanup(); reject(fail('proxy_timeout')); }, Math.max(200, deadline - Date.now()));
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const index = buffer.indexOf('\r\n\r\n');
      if (buffer.length > 64 * 1024) { cleanup(); reject(fail('proxy_head_too_large')); return; }
      if (index < 0) return;
      cleanup();
      const head = buffer.subarray(0, index).toString('latin1').toLowerCase();
      // 隧道回执后面可能已经跟着 TLS 的第一段字节：塞回流里，交给下一层读，丢了握手就断了
      const rest = buffer.subarray(index + 4);
      if (rest.length) socket.unshift(rest);
      resolve({ head, socket });
    });
    socket.once('end', () => { cleanup(); reject(fail('proxy_closed')); });
    socket.once('error', () => { cleanup(); reject(fail('proxy_socket_error')); });
  });
}

const decodeBody = (body, encoding) => {
  try {
    if (encoding === 'gzip' || encoding === 'x-gzip') return gunzipSync(body);
    if (encoding === 'deflate') {
      try { return inflateSync(body); } catch { return inflateRawSync(body); }
    }
    if (encoding === 'br') return brotliDecompressSync(body);
  } catch { /* 解不出来就按原文交给上层，形状不对自然会被判定为源不可用 */ }
  return body;
};

function dechunk(body) {
  const out = [];
  let offset = 0;
  while (offset < body.length) {
    const line = body.indexOf('\r\n', offset);
    if (line < 0) break;
    const size = Number.parseInt(body.subarray(offset, line).toString('latin1').split(';')[0], 16);
    if (!Number.isFinite(size)) break;
    if (size === 0) break;
    out.push(body.subarray(line + 2, line + 2 + size));
    offset = line + 2 + size + 2;
  }
  return Buffer.concat(out);
}

function toResponse(raw, deadline) {
  if (Date.now() > deadline) throw fail('proxy_timeout');
  const index = raw.indexOf('\r\n\r\n');
  if (index < 0) throw fail('proxy_shape');
  const head = raw.subarray(0, index).toString('latin1');
  const status = Number.parseInt(head.split(' ')[1] ?? '', 10) || 0;
  const headers = {};
  for (const line of head.split('\r\n').slice(1)) {
    const at = line.indexOf(':');
    if (at > 0) headers[line.slice(0, at).trim().toLowerCase()] = line.slice(at + 1).trim();
  }
  let body = raw.subarray(index + 4);
  if (/transfer-encoding:\s*chunked/i.test(head)) body = dechunk(body);
  body = decodeBody(body, String(headers['content-encoding'] ?? '').toLowerCase());
  return new Response(body, { status: status || 599, headers: { 'content-type': headers['content-type'] ?? 'application/octet-stream' } });
}

/** 经手一个代理：建隧道 → 发请求 → 拿响应。任何一步不对都抛错，由调用方记账换下一个 */
async function viaProxy(target, addr, policy, opts) {
  const proxy = parseProxyAddress(addr);
  if (!proxy) throw fail('proxy_bad_address');
  const dial = await resolveProxyHost(proxy.host);
  if (!dial.ok) throw fail(dial.reason);

  const deadline = Date.now() + Math.max(policy.totalMs, policy.connectMs + 1_000);
  const targetPort = target.port || (target.protocol === 'https:' ? 443 : 80);
  let socket = null;
  const kill = () => { try { socket?.destroy(); } catch { /* 已经断了 */ } };
  // 每一段都可能卡住（代理收下连接却不回东西），所以整条路径共用一个截止时间
  const within = (promise) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { kill(); reject(fail('proxy_timeout')); }, Math.max(120, deadline - Date.now()));
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });

  try {
    socket = await within(connectSocket({ host: proxy.host, port: proxy.port, timeout: policy.connectMs }));
    if (policy.protocol === 'https') socket = await within(upgradeTls(socket, { servername: proxy.host, ALPNProtocols: ['http/1.1'] }));

    if (target.protocol === 'http:') {
      // 明文目标不需要隧道，直接发绝对 URI（这是 http 代理的标准用法）
      await within(writeAll(socket, requestLine(target, opts, { absolute: true })));
      return toResponse(await readToEnd(socket, MAX_BYTES, deadline), deadline);
    }

    const connectReq = `CONNECT ${target.hostname}:${targetPort} HTTP/1.1\r\nhost: ${target.hostname}:${targetPort}\r\n\r\n`;
    await within(writeAll(socket, connectReq));
    const tunnel = await readHead(socket, deadline);
    if (!/^http\/1\.[0-9] 2\d\d/i.test(tunnel.head)) {
      const code = Number.parseInt(tunnel.head.split(' ')[1] ?? '', 10) || 0;
      // 407 = 这个代理要凭据；403 = 代理拒绝转发。两者都说明这个出口不能用
      throw fail(code ? `tunnel_${code}` : 'tunnel_failed');
    }
    socket = await within(upgradeTls(tunnel.socket, { servername: target.hostname, ALPNProtocols: ['http/1.1'] }));
    await within(writeAll(socket, requestLine(target, opts, { absolute: false })));
    return toResponse(await readToEnd(socket, MAX_BYTES, deadline), deadline);
  } finally {
    kill();
  }
}

function requestLine(target, opts, { absolute }) {
  const path = absolute ? target.toString() : `${target.pathname}${target.search}`;
  const lines = [
    `GET ${path} HTTP/1.1`,
    `host: ${target.hostname}`,
    `user-agent: ${opts.headers?.['user-agent'] ?? UA}`,
    `accept: ${opts.headers?.accept ?? '*/*'}`,
    'connection: close',
  ];
  for (const [key, value] of Object.entries(opts.headers ?? {})) {
    if (!['host', 'user-agent', 'accept', 'connection', 'content-length'].includes(key.toLowerCase())) lines.push(`${key}: ${value}`);
  }
  return `${lines.join('\r\n')}\r\n\r\n`;
}

async function direct(target, opts) {
  const response = await fetch(target.toString(), {
    headers: { 'user-agent': UA, accept: '*/*', ...(opts.headers ?? {}) },
    signal: AbortSignal.timeout(opts.ms ?? 5_000),
  });
  return response;
}

/** 行情层的唯一出网口：默认直连，直连不行（或明确被限流）才按池子轮换出口 */
export async function quoteRequest(url, opts = {}, policyOf = proxyPolicy) {
  const target = new URL(url);
  if (target.protocol !== 'http:' && target.protocol !== 'https:') throw fail('proxy_target_scheme');
  // 第二道 SSRF 闸：即便有人绕过了行情源的域名白名单，出网主机也只能是这几家
  if (!allowedHosts.has(target.hostname.toLowerCase()) && !(allowPrivateProxy() && net.isIP(target.hostname))) {
    throw fail('proxy_target_not_allowed');
  }
  const policy = { ...PROXY_DEFAULTS, ...(policyOf?.() ?? {}) };
  if (!policy.enabled) return direct(target, opts);

  const now = () => Date.now();
  if (directReady(policy, now())) {
    try {
      const response = await direct(target, opts);
      // 403/429 是「这个出口被限流了」的典型签名：换代理再试，而不是把错误交给行情层
      if (!BLOCKED_STATUS.has(response.status)) { noteDirectOk(now()); return response; }
      noteDirectFail(`direct_${response.status}`, now());
    } catch (error) {
      noteDirectFail(error?.cause?.code ?? error?.message ?? 'direct_failed', now());
    }
  }
  if (!policy.manual?.length && !policy.apiUrl && !proxyCandidates(policy).length) throw fail('proxy_pool_empty');

  addProxies(policy.manual ?? [], { nowMs: now(), source: 'manual' });
  if (needsNewList(policy, now())) await pullProxies({ policyOf: () => policy });

  let lastError = null;
  for (let round = 0; round < 2; round += 1) {
    const list = proxyCandidates(policy).slice(0, MAX_ATTEMPTS);
    for (const addr of list) {
      const started = Date.now();
      try {
        const response = await viaProxy(target, addr, policy, opts);
        if (BLOCKED_STATUS.has(response.status)) {
          const code = markProxyFail(addr, `upstream_${response.status}`, Date.now());
          lastError = fail(`upstream_${response.status}`);
          if (code >= policy.maxFails || response.status === 403 || response.status === 407) evictProxy(addr);
          continue;
        }
        markProxyOk(addr, Date.now() - started, Date.now());
        noteServed('proxy');
        return response;
      } catch (error) {
        lastError = error;
        const code = markProxyFail(addr, error?.message ?? 'failed', Date.now());
        if (code >= policy.maxFails) evictProxy(addr);
      }
    }
    // 这一轮全挂了：如果还够拉新列表的条件，就换一批再试一轮
    if (round === 0 && needsNewList(policy, now())) await pullProxies({ policyOf: () => policy });
    else break;
  }
  if (lastError) throw lastError;
  throw fail('proxy_exhausted');
}

/** 从列表 API 取新出口。API 自己永远走直连——它不是行情，也不能靠代理来拿代理 */
export async function pullProxies({ force = false, policyOf = proxyPolicy } = {}) {
  const policy = { ...PROXY_DEFAULTS, ...(policyOf?.() ?? {}) };
  const now = Date.now();
  if (!force && !needsNewList(policy, now)) return { skipped: true, added: 0, pool: proxyCandidates(policy).length };
  if (!policy.apiUrl) { notePull(now, 'proxy_api_url_missing'); return { skipped: false, added: 0, error: 'proxy_api_url_missing', pool: 0 }; }

  let text = '';
  try {
    const url = new URL(policy.apiUrl);
    // 填进来的 URL 也要 DNS 后再看一眼：字面量合法但解析到内网，同样是开门
    const dial = await resolveProxyHost(url.hostname);
    if (!dial.ok) throw fail(dial.reason);
    // 数量与类型以这里的配置为准：用 searchParams.set 覆盖，避免和 URL 里已有的同名参数重复
    url.searchParams.set('count', String(policy.count));
    url.searchParams.set('protocol', policy.protocol);
    const response = await fetch(url.toString(), { headers: { 'user-agent': UA, accept: '*/*' }, signal: AbortSignal.timeout(Math.max(policy.totalMs, 6_000)) });
    if (!response.ok) throw fail(`api_${response.status}`);
    text = await response.text();
  } catch (error) {
    notePull(now, error?.message ?? 'api_failed');
    return { skipped: false, added: 0, error: error?.message ?? 'api_failed', pool: proxyCandidates(policy).length };
  }
  const found = extractProxies(text, policy);
  if (!found.length) {
    notePull(now, 'api_no_usable_proxy');
    return { skipped: false, added: 0, error: 'api_no_usable_proxy', pool: proxyCandidates(policy).length, raw: text.slice(0, 240) };
  }
  const added = addProxies(found, { nowMs: now, source: 'api' });
  notePull(now);
  return { skipped: false, added: added.length, list: found, pool: proxyCandidates(policy).length };
}

/** scdn 把列表放在 data.proxies，别家可能直接给数组或纯文本：三种形状都吃 */
function extractProxies(text, policy) {
  const out = [];
  const push = (item) => {
    const parsed = parseProxyAddress(String(item ?? '').trim());
    if (parsed && !out.includes(parsed.addr)) out.push(parsed.addr);
  };
  let body = null;
  try {
    body = JSON.parse(text);
  } catch { body = null; }
  const list = Array.isArray(body) ? body
    : Array.isArray(body?.data?.proxies) ? body.data.proxies
      : Array.isArray(body?.data) ? body.data
        : Array.isArray(body?.proxies) ? body.proxies
          : Array.isArray(body?.result) ? body.result : null;
  if (list) for (const item of list) push(typeof item === 'string' ? item : `${item?.host ?? item?.ip ?? ''}:${item?.port ?? ''}`);
  else for (const match of String(text).matchAll(/\b\d{1,3}(?:\.\d{1,3}){3}:\d{1,5}\b/g)) push(match[0]);
  return out.slice(0, policy.count);
}

/** 单个代理活性检测：真打一次行情接口，通了才敢留在池子里 */
export async function probeProxyAddress(addr, { policyOf = proxyPolicy, url = PROBE_URL } = {}) {
  const policy = { ...PROXY_DEFAULTS, ...(policyOf?.() ?? {}) };
  const started = Date.now();
  noteProbe(addr, started);
  try {
    const response = await viaProxy(new URL(url), addr, policy, { ms: policy.totalMs });
    const ms = Date.now() - started;
    if (!response.ok) {
      markProxyFail(addr, `upstream_${response.status}`, Date.now());
      return { addr, ok: false, ms, error: `upstream_${response.status}`, blocked: BLOCKED_STATUS.has(response.status) };
    }
    const rows = await countRows(response);
    // 连上了却取不到行情，等于这个出口没用：不能记成成功，否则死池子看着是活的
    if (rows <= 0) {
      markProxyFail(addr, 'proxy_empty', Date.now());
      return { addr, ok: false, ms, error: '返回为空' };
    }
    markProxyOk(addr, ms, Date.now());
    return { addr, ok: true, ms, rows };
  } catch (error) {
    const message = error?.message ?? 'failed';
    markProxyFail(addr, message, Date.now());
    return { addr, ok: false, ms: Date.now() - started, error: message, blocked: /40[37]|denied|forbidden/i.test(message) };
  }
}

async function countRows(response) {
  try {
    const body = JSON.parse(await response.text());
    const diff = body?.data?.diff;
    if (Array.isArray(diff)) return diff.length;
    if (Array.isArray(body?.data?.klines)) return 1;
    return body?.data ? 1 : 0;
  } catch { return 0; }
}

/** 整池检测：先补一批再逐个验，验完给出结论和该做什么 */
export async function checkProxies({ policyOf = proxyPolicy, url = PROBE_URL } = {}) {
  const policy = { ...PROXY_DEFAULTS, ...(policyOf?.() ?? {}) };
  const pulled = policy.apiUrl ? await pullProxies({ force: true, policyOf: () => policy }) : { skipped: true, added: 0 };
  addProxies(policy.manual ?? [], { source: 'manual' });
  const list = proxyCandidates(policy);
  const rows = [];
  // 顺序检测：并发会让「哪个代理慢」变得不可信，也更容易被上游当成攻击
  for (const addr of list) rows.push(await probeProxyAddress(addr, { policyOf: () => policy, url }));
  const usable = rows.filter((row) => row.ok);
  const blocked = rows.filter((row) => row.blocked);
  for (const row of blocked) evictProxy(row.addr);
  const advice = [];
  if (!policy.apiUrl && !policy.manual.length) advice.push('还没有代理来源：填代理 API 地址，或直接手填几个 host:port。');
  if (pulled.error) advice.push(`代理列表取回失败：${pulled.error}${pulled.error?.startsWith('api_') ? '（多为出口 IP 被该 API 限流或配额用尽，稍后再试）' : ''}。`);
  if (!rows.length) advice.push('池子是空的：没有任何可检测的代理，先获取一批。');
  if (rows.length && !usable.length) advice.push(`${rows.length} 个代理全部不通：住宅/机房代理被上游拒了的可能性最大，先看下面「说明」列的错误码。`);
  if (blocked.length) advice.push(`${blocked.length} 个出口已被封（403/407），已从池子里剔除，下次请求会自动取新代理。`);
  if (usable.length) advice.push(`可用出口 ${usable.length}/${rows.length} 个，最快 ${Math.min(...usable.map((row) => row.ms))}ms。`);
  if (usable.length && !policy.enabled) advice.push('代理已验活但总开关是关的：打开「启用代理」才会真的换出口。');
  const verdict = usable.length === rows.length && rows.length ? 'ok' : usable.length ? 'partial' : 'down';
  return { verdict, okCount: usable.length, total: rows.length, results: rows, pulled, advice, source: { apiUrl: proxyStatus(policy).policy.apiUrl, mode: policy.mode, enabled: policy.enabled } };
}

/** 自建入口调用它：把行情出网换成带代理的实现，并把能力交给 functions 层的管理动作 */
export function installProxyTransport({ policyOf = proxyPolicy, probeUrl = PROBE_URL } = {}) {
  const runtime = {
    quoteRequest: (url, opts) => quoteRequest(url, opts, policyOf),
    pullProxies: (options = {}) => pullProxies({ ...options, policyOf }),
    probeProxyAddress: (addr) => probeProxyAddress(addr, { policyOf, url: probeUrl }),
    checkProxies: () => checkProxies({ policyOf, url: probeUrl }),
    status: () => ({ ...proxyStatus(policyOf()), runtime: 'node' }),
  };
  setQuoteFetch((url, opts) => runtime.quoteRequest(url, opts));
  setProxyRuntime(runtime);
  return runtime;
}
