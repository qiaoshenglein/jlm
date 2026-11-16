// 代理出网的回归：全部用本地 mock（假代理 + 假行情源 + 假列表 API），
// 不依赖能不能真的连上 scdn，也不打任何第三方域名。
// 用法：node dev/proxy-probe.mjs      （约 10 秒）
// 需要 openssl 生成一张自签证书，用来验「经 CONNECT 隧道的 https」这条真路径。
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 假代理与假源都在 127.0.0.1 上：这一句是这条探针唯一的后门开关，必须在 import 之前设好
process.env.PROXY_ALLOW_PRIVATE = '1';
// 假源的证书是自签的，只在本进程内不校验（生产代码路径不受影响）
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const QUOTE_JSON = JSON.stringify({ data: { total: 1, diff: [{ f2: 12.34, f12: '600000', f14: '测试股', f13: 1 }] } });
const ALLOWED = 'push2.eastmoney.com';

const results = [];
const assert = (name, cond, detail = '') => {
  const row = { name, ok: Boolean(cond), detail: cond ? '' : String(detail).slice(0, 160) };
  results.push(row);
  if (process.env.PROBE_VERBOSE) console.log(`${row.ok ? 'PASS' : 'FAIL'} ${name}${row.detail ? ` —— ${row.detail}` : ''}`);
};
const eq = (name, got, want) => assert(name, String(got) === String(want), `got=${String(got)} want=${String(want)}`);

const listenOn = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const closeAll = (list) => Promise.all(list.map((item) => new Promise((resolve) => item.close(resolve))));

// ---- 假行情源：http 与 https 各一个，返回同一种东财形状 ----
function createOriginHttp() {
  return http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(QUOTE_JSON);
  });
}

// 假源按请求路径给形状：行情层要什么形状就给什么形状（东财那一套）
const eastBody = (path) => {
  const ts = Math.floor(Date.now() / 1000);
  if (path.includes('/api/qt/stock/get')) {
    const code = (path.match(/secid=[0-9]+\.(\w+)/) ?? [])[1] ?? '600000';
    return JSON.stringify({ data: {
      f43: 12.34, f44: 12.5, f45: 12.1, f46: 12.2, f47: 1000, f48: 1e7, f57: code, f58: 'P', f60: 12.2,
      f86: ts, f168: 1.2, f169: 0.01, f170: 1.1, f171: 0.13,
    } });
  }
  if (path.includes('/api/qt/stock/trends2/get')) {
    return JSON.stringify({ data: { name: 'P', preClose: 12.2, trends: [`${new Date().toISOString().slice(0, 10)} 09:31:00,12.30,100,12.28`] } });
  }
  if (path.includes('/api/qt/stock/kline/get')) {
    return JSON.stringify({ data: { klines: [`${new Date().toISOString().slice(0, 10)},12.2,12.3,12.5,12.1,1000`] } });
  }
  if (path.includes('/api/suggest/get')) {
    return JSON.stringify({ QuotationCodeTable: { Data: [{ QuoteID: '1.600000', Classify: 'HS', Name: 'P', Code: '600000', MarketType: 'ASCII' }] } });
  }
  // 池子要有 20 行才算建成（行情层的硬门槛），所以假榜给 30 行
  const rows = [];
  for (let n = 0; n < 30; n += 1) {
    const market = n % 3 === 2 ? 0 : 1;
    const code = market === 1 ? String(600000 + n) : String(1000 + n).padStart(6, '0');
    rows.push({
      f2: 10 + n / 10, f3: 1.5, f5: 1000 + n, f6: 1e7 + n, f8: 1.2, f12: code, f13: market, f14: `P${code}`,
      f15: 11, f16: 9.5, f17: 10.2, f18: 10, f20: 1e10, f124: ts,
    });
  }
  return JSON.stringify({ data: { total: rows.length, diff: rows } });
};

const originReply = (text, body) => {
  const at = text.indexOf('\r\n\r\n');
  const head = at < 0 ? text : text.slice(0, at);
  const path = head.split('\r\n')[0].split(' ')[1] ?? '';
  const payload = body ?? eastBody(path);
  return `HTTP/1.1 200 OK\r\ncontent-type: application/json\r\nconnection: close\r\n\r\n${payload}`;
};

// ---- 假代理：behavior 决定它当「能用 / 被封 / 要凭据 / 连不上 / 限流」哪一种 ----
function createMockProxy({ behavior, relayPort, body = QUOTE_JSON }) {
  const hits = [];
  let connecting = 0;
  const server = net.createServer((socket) => {
    connecting += 1;
    socket.on('error', () => {});
    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const at = buffer.indexOf('\r\n\r\n');
      if (at < 0) return;
      const head = buffer.subarray(0, at).toString('latin1');
      const first = head.split('\r\n')[0];
      hits.push(first);
      socket.removeAllListeners('data');
      if (behavior === 'refuse') { socket.destroy(); return; }
      if (first.startsWith('CONNECT')) {
        if (behavior === 'deny403') { socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
        if (behavior === 'needauth') { socket.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n'); return; }
        socket.write('HTTP/1.1 200 Connection established\r\n\r\n');
        // 真代理不终结 TLS：隧道只是原样转发字节，握手发生在被测代码和假源之间
        const raw = net.connect(relayPort, '127.0.0.1');
        raw.on('error', () => socket.destroy());
        const rest = buffer.subarray(at + 4);
        if (rest.length) socket.unshift(rest);
        socket.pipe(raw).pipe(socket);
        return;
      }
      // 绝对 URI 的明文请求：代理自己给答案就够了
      if (behavior === 'throttle') { socket.end('HTTP/1.1 429 Too Many Requests\r\nconnection: close\r\n\r\n'); return; }
      socket.end(originReply(head + '\r\n\r\n', body === QUOTE_JSON ? null : body));
    });
  });
  return { server, hits, connections: () => connecting };
}

// ---- 假代理列表 API：https（校验只收 https），形状可换用来验三种返回都能解析 ----
function createListApi(tlsOptions) {
  let payload = '';
  let requests = [];
  const handler = (req, res) => {
    requests.push(req.url);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(payload);
  };
  const server = https.createServer(tlsOptions, handler);
  return {
    server,
    requests: () => requests,
    count: () => requests.length,
    reset: () => { requests = []; },
    set: (value) => { payload = typeof value === 'string' ? value : JSON.stringify(value); },
  };
}

const selfSigned = () => {
  const dir = mkdtempSync(join(tmpdir(), 'mirrordesk-proxy-'));
  const args = ['req', '-x509', '-newkey', 'rsa:2048', '-keyout', join(dir, 'k.pem'), '-out', join(dir, 'c.pem'),
    '-days', '2', '-nodes', '-subj', `/CN=${ALLOWED}`, '-addext', `subjectAltName=DNS:${ALLOWED},DNS:localhost,IP:127.0.0.1`];
  execFileSync('openssl', args, { stdio: 'ignore' });
  // Windows 上的 openssl 会写 CRLF，Node 的 PEM 解析只认 LF
  const pem = (name) => readFileSync(join(dir, name), 'utf8').replace(/\r\n/g, '\n');
  return { dir, key: pem('k.pem'), cert: pem('c.pem') };
};

const main = async () => {
  const { dir, key, cert } = selfSigned();
  const originHttp = createOriginHttp();
  const tlsOrigin = (fixed) => tls.createServer({ key, cert }, (socket) => {
    let buf = '';
    socket.on('data', (chunk) => {
      buf += chunk.toString('latin1');
      if (buf.indexOf('\r\n\r\n') < 0) return;
      socket.end(originReply(buf, fixed));
    });
    socket.on('error', () => {});
  });
  const originTls = tlsOrigin(null);            // 按路径给形状：行情层要什么给什么
  const originEmpty = tlsOrigin('{"data":null}');
  const httpPort = await listenOn(originHttp);
  const tlsPort = await listenOn(originTls);
  const emptyTlsPort = await listenOn(originEmpty);
  // 一个「曾经存在、现在没了」的端口：用来制造直连失败
  const gone = http.createServer();
  const deadDirectPort = await listenOn(gone);
  await new Promise((resolve) => gone.close(resolve));

  const listApi = createListApi({ key, cert });
  const listPort = await listenOn(listApi.server);
  const listUrl = `https://127.0.0.1:${listPort}/get_proxy.php?key=SECRETVALUE`;
  listApi.set({ code: 200, message: 'success', data: { proxies: [], count: 0 } });

  const makeProxy = (behavior, relayPort = tlsPort, body = QUOTE_JSON) => createMockProxy({ behavior, relayPort, body });
  const goodProxy = makeProxy('ok');
  const goodPort = await listenOn(goodProxy.server);
  const badProxy = makeProxy('deny403');
  const badPort = await listenOn(badProxy.server);
  const authProxy = makeProxy('needauth');
  const authPort = await listenOn(authProxy.server);
  const deadProxy = makeProxy('refuse');
  const deadPort = await listenOn(deadProxy.server);
  // 连得上、隧道也通，但对面那个源回的是空数据：活性检测要能判成「不可用」而不是假成功
  const emptyProxy = makeProxy('ok', emptyTlsPort);
  const emptyPort = await listenOn(emptyProxy.server);
  const throttleProxy = makeProxy('throttle');
  const throttlePort = await listenOn(throttleProxy.server);

  const transports = await import('../server/proxy.mjs');
  const proxy = await import('../functions/proxy.mjs');
  const transport = await import('../functions/transport.mjs');
  const quotes = await import('../functions/quotes.mjs');

  // ---- 0. 出厂内置的列表接口 ----
  assert('出厂默认就是内置 scdn 接口', proxy.PROXY_DEFAULTS.apiUrl === 'https://proxy.scdn.io/api/get_proxy.php'
    && proxy.PROXY_API_PRESETS.some((item) => item.url === proxy.PROXY_DEFAULTS.apiUrl), JSON.stringify(proxy.PROXY_DEFAULTS.apiUrl));
  assert('内置地址过得了校验', proxy.checkApiUrl(proxy.PROXY_DEFAULTS.apiUrl).ok === true);
  assert('开关默认仍关着（内置地址不会自己出网）', proxy.PROXY_DEFAULTS.enabled === false);
  // 这条探针全程用本地 mock：把默认地址摘掉，免得哪个用例漏设 apiUrl 就去打真接口
  proxy.PROXY_DEFAULTS.apiUrl = '';

  // ---- 1. 还没装运行时：接口层要如实说「这个运行时不支持」 ----
  assert('未装运行时时 proxyRuntime 为空', proxy.proxyRuntime() === null, String(proxy.proxyRuntime()));

  // ---- 2. 策略校验 ----
  const addr = (text) => proxy.parseProxyAddress(text);
  assert('合法 host:port 通过', addr('203.0.113.9:8080')?.addr === '203.0.113.9:8080', JSON.stringify(addr('203.0.113.9:8080')));
  assert('带凭据的地址拒绝', addr('user:pass@203.0.113.9:8080') === null);
  assert('带 scheme 的地址拒绝', addr('http://203.0.113.9:8080') === null);
  assert('云元数据地址拒绝', proxy.isPrivateHost('169.254.169.254') && proxy.isPrivateHost('100.64.0.1') && proxy.isPrivateHost('172.16.0.9'));
  assert('公网地址不算内网', !proxy.isPrivateHost('203.0.113.9') && !proxy.isPrivateHost('8.8.8.8'));
  const httpApi = proxy.checkApiUrl('http://proxy.example.com/api');
  assert('列表 API 只收 https', httpApi.ok === false && /https/.test(httpApi.reason), JSON.stringify(httpApi));
  const credApi = proxy.checkApiUrl('https://u:p@proxy.example.com/api');
  assert('列表 API 不能带凭据', credApi.ok === false, JSON.stringify(credApi));
  const okApi = proxy.checkApiUrl('https://proxy.scdn.io/api/get_proxy.php?protocol=http&count=5');
  assert('正常 API 通过并规范化', okApi.ok && /get_proxy\.php/.test(okApi.value), JSON.stringify(okApi));
  assert('API 地址打码只留主机名与首段', proxy.maskApiUrl('https://proxy.scdn.io/api/get_proxy.php?key=SECRETVALUE') === 'proxy.scdn.io/api?***',
    proxy.maskApiUrl('https://proxy.scdn.io/api/get_proxy.php?key=SECRETVALUE'));
  assert('打码后不含查询串', !/key=/.test(proxy.maskApiUrl('https://x.io/a/b?key=SECRETVALUE')), proxy.maskApiUrl('https://x.io/a/b?key=SECRETVALUE'));
  const masked = proxy.maskProxyValue(JSON.stringify({ enabled: true, apiUrl: 'https://x.io/api?key=SECRETVALUE', manual: ['1.2.3.4:8'] }));
  assert('备份里的代理值不含 key', !JSON.stringify(masked).includes('SECRETVALUE'), JSON.stringify(masked));
  assert('打码后地址是「没配」而不是残串', masked.proxy.apiUrl === '', JSON.stringify(masked.proxy.apiUrl));
  const twice = proxy.maskProxyValue(JSON.stringify(masked.proxy));
  assert('打码可重复（导出→导入→导出字节一致）', JSON.stringify(twice.proxy) === JSON.stringify(masked.proxy), JSON.stringify(twice.proxy));
  assert('打码不会把内置地址塞回去', proxy.checkProxyPolicy(masked.proxy).values.apiUrl === '', JSON.stringify(proxy.checkProxyPolicy(masked.proxy).values.apiUrl));
  assert('未知键逐项拒绝', proxy.checkProxyPolicy({ nope: 1 }).rejected.length === 1, JSON.stringify(proxy.checkProxyPolicy({ nope: 1 })));
  assert('数值越界拒绝', proxy.checkProxyPolicy({ count: 99 }).rejected.length === 1 && proxy.checkProxyPolicy({ directCoolMs: 1 }).rejected.length === 1);
  assert('手动清单去重且限量', proxy.checkProxyPolicy({ manual: '1.1.1.1:8, 1.1.1.1:8, 2.2.2.2:9' }).values.manual.join() === '1.1.1.1:8,2.2.2.2:9');
  assert('默认值就是关着的', proxy.proxyPolicy().enabled === false, JSON.stringify(proxy.proxyPolicy()));

  // ---- 3. 传输：关掉时一律直连，代理一个包都不该收到 ----
  const runtime = transports.installProxyTransport({ policyOf: () => proxy.proxyPolicy() });
  assert('安装后接缝已换', transport.quoteFetchMode() === 'injected', transport.quoteFetchMode());
  const clearHttp = `http://127.0.0.1:${httpPort}/api/qt/clist/get?pn=1`;
  const clearTls = `https://${ALLOWED}/api/qt/clist/get?pn=1&pz=1`;
  proxy.resetProxyPool();
  let response = await runtime.quoteRequest(clearHttp, { ms: 3000 });
  assert('关闭代理时走直连', response.ok && (await response.text()).includes('600000'), '');
  assert('关闭代理时代理未被触碰', goodProxy.connections() === 0, String(goodProxy.connections()));

  // ---- 4. proxy_only：明文 http 目标经代理 ----
  proxy.setProxyPolicy({ ...proxy.PROXY_DEFAULTS, enabled: true, mode: 'proxy_only', manual: [`127.0.0.1:${goodPort}`] });
  const viaProxyOnly = await runtime.quoteRequest(clearHttp, { ms: 3000 });
  assert('代理取回行情', viaProxyOnly.ok && (await viaProxyOnly.text()).includes('600000'), '');
  assert('代理明文请求用绝对 URI', /GET http:/.test(goodProxy.hits.join('\n')), goodProxy.hits.join('\n').slice(0, 120));
  const afterProxy = proxy.proxyStatus();
  assert('成功计数落在对应代理上', afterProxy.pool[0]?.ok === 1 && afterProxy.counters.proxyOk === 1, JSON.stringify(afterProxy));
  assert('出口记录为 proxy', afterProxy.counters.lastVia === 'proxy', JSON.stringify(afterProxy.counters));

  // ---- 5. proxy_only：https 目标真的走 CONNECT 隧道 + TLS ----
  const through = await runtime.quoteRequest(clearTls, { ms: 3000 });
  assert('https 目标经隧道取回', through.ok && (await through.text()).includes('600000'), '');
  assert('隧道请求行正确', goodProxy.hits.some((line) => line.startsWith(`CONNECT ${ALLOWED}:443 HTTP/1.1`)), goodProxy.hits.join('\n').slice(0, 200));

  // ---- 6. 出网目标仍然只认白名单：代理不能变成内网探测口 ----
  let denied = null;
  try { await runtime.quoteRequest('http://evil.example.com/x', { ms: 2000 }); } catch (error) { denied = error.message; }
  assert('白名单外的主机拒绝出网', denied === 'proxy_target_not_allowed', String(denied));
  let scheme = null;
  try { await runtime.quoteRequest('file://x/y', { ms: 500 }); } catch (error) { scheme = error.message; }
  assert('非 http(s) 协议拒绝', scheme === 'proxy_target_scheme', String(scheme));

  // ---- 7. direct_first：直连能用就不碰代理 ----
  proxy.resetProxyPool();
  proxy.setProxyPolicy({ ...proxy.PROXY_DEFAULTS, enabled: true, mode: 'direct_first', manual: [`127.0.0.1:${goodPort}`], apiUrl: listUrl });
  const hitsBefore = goodProxy.connections();
  const directResponse = await runtime.quoteRequest(clearHttp, { ms: 3000 });
  assert('直连优先取回数据', directResponse.ok, '');
  assert('直连命中时代理没被打', goodProxy.connections() === hitsBefore, `${hitsBefore} → ${goodProxy.connections()}`);
  assert('直连计数已记', proxy.proxyStatus().counters.directOk === 1, JSON.stringify(proxy.proxyStatus().counters));

  // ---- 8. direct_first：直连挂了自动换代理 ----
  const deadHttp = `http://127.0.0.1:${deadDirectPort}/api`;
  const fallback = await runtime.quoteRequest(deadHttp, { ms: 1500 });
  assert('直连失败后由代理兜住', fallback.ok && (await fallback.text()).includes('600000'), '');
  assert('直连失败进入冷却', proxy.directState().coolingMs > 0, JSON.stringify(proxy.directState()));
  assert('冷却期内不再试直连', proxy.directReady() === false, JSON.stringify(proxy.directState()));
  assert('冷却到期后会再试直连', proxy.directReady(proxy.proxyPolicy(), Date.now() + 120_000) === true);

  // ---- 9. 被封的出口：403 立刻剔除，取到新代理才恢复 ----
  proxy.resetProxyPool();
  proxy.notePull(0);
  proxy.setProxyPolicy({
    ...proxy.PROXY_DEFAULTS, enabled: true, mode: 'proxy_only', maxFails: 1, minPullMs: 5_000, ttlMs: 5_000,
    apiUrl: listUrl, manual: [`127.0.0.1:${badPort}`],
  });
  listApi.set({ code: 200, message: 'success', data: { proxies: [], count: 0 } });
  let blockedError = null;
  try { await runtime.quoteRequest(clearTls, { ms: 2000 }); } catch (error) { blockedError = error.message; }
  assert('被封出口报错而不是假成功', blockedError === 'tunnel_403', String(blockedError));
  assert('连不上不等于还能用', proxy.proxyStatus().alive === 0, JSON.stringify(proxy.proxyStatus().alive));
  assert('被封的已从池子剔除', !proxy.proxyStatus().pool.some((row) => row.addr.endsWith(`:${badPort}`)), JSON.stringify(proxy.proxyStatus().pool));

  // 池子空了会自动拉列表：列表给一个好代理，下一次请求就该成功
  listApi.set({ code: 200, message: 'success', data: { proxies: [`127.0.0.1:${goodPort}`], count: 1 } });
  proxy.notePull(0);
  const afterPull = await runtime.quoteRequest(clearTls, { ms: 2000 });
  assert('自动换新代理后恢复', afterPull.ok && (await afterPull.text()).includes('600000'), '');
  assert('新列表来自 API', proxy.proxyStatus().pool.some((row) => row.source === 'api'), JSON.stringify(proxy.proxyStatus().pool));

  // ---- 10. 拉取节流：minPullMs 内不重复打 API ----
  proxy.resetProxyPool();
  proxy.notePull(Date.now());
  listApi.reset();
  proxy.setProxyPolicy({
    ...proxy.PROXY_DEFAULTS, enabled: true, mode: 'proxy_only', apiUrl: listUrl,
    minPullMs: 600_000, ttlMs: 600_000, manual: [`127.0.0.1:${goodPort}`],
  });
  await runtime.quoteRequest(clearTls, { ms: 2000 });
  await runtime.quoteRequest(clearTls, { ms: 2000 });
  assert('最小间隔内不重复拉取', listApi.count() === 0, String(listApi.count()));

  // ---- 11. 三种列表形状都能解析 ----
  const shapes = [
    ['data.proxies', { code: 200, data: { proxies: ['8.8.8.8:8080'], count: 1 } }],
    ['顶层数组', ['9.9.9.9:8080']],
    ['纯文本', '7.7.7.7:8080\r\n7.7.7.7:8081'],
  ];
  for (const [label, payload] of shapes) {
    proxy.resetProxyPool();
    listApi.set(payload);
    const pulled = await runtime.pullProxies({ force: true });
    assert(`列表形状 ${label}`, pulled.added >= 1 && proxy.proxyCandidates().length >= 1, JSON.stringify(pulled));
  }
  proxy.resetProxyPool();
  listApi.set({ code: 429, message: 'quota exceeded' });
  const emptyPull = await runtime.pullProxies({ force: true });
  assert('列表里没有可用代理要报错', emptyPull.error === 'api_no_usable_proxy', JSON.stringify(emptyPull));

  // ---- 12. 逐个活性检测：真假混在一池里，结论要按能力说话 ----
  proxy.resetProxyPool();
  proxy.setProxyPolicy({ ...proxy.PROXY_DEFAULTS, enabled: true, mode: 'proxy_only', apiUrl: listUrl, protocol: 'http', totalMs: 4000, connectMs: 1500 });
  listApi.set({ code: 200, data: { proxies: [`127.0.0.1:${goodPort}`, `127.0.0.1:${badPort}`, `127.0.0.1:${authPort}`, `127.0.0.1:${emptyPort}`, `127.0.0.1:${deadPort}`] } });
  const checked = await runtime.checkProxies();
  const byAddr = Object.fromEntries(checked.results.map((row) => [row.addr.split(':')[1], row]));
  assert('检测先补齐了一池', checked.total === 5, JSON.stringify(checked.results.map((row) => row.addr)));
  assert('好代理判为可用', byAddr[goodPort]?.ok === true && byAddr[goodPort]?.rows >= 1, JSON.stringify(byAddr[goodPort]));
  assert('403 代理判为被封', byAddr[badPort]?.ok === false && byAddr[badPort]?.blocked === true, JSON.stringify(byAddr[badPort]));
  assert('要凭据的代理判为不可用', byAddr[authPort]?.ok === false && /407/.test(byAddr[authPort]?.error ?? ''), JSON.stringify(byAddr[authPort]));
  assert('取到空数据的代理判为不可用', byAddr[emptyPort]?.ok === false && byAddr[emptyPort]?.error === '返回为空', JSON.stringify(byAddr[emptyPort]));
  assert('连不上的代理判为不可用', byAddr[deadPort]?.ok === false && !byAddr[deadPort]?.blocked, JSON.stringify(byAddr[deadPort]));
  assert('结论为部分可用', checked.verdict === 'partial', checked.verdict);
  assert('检测建议提到剔除', checked.advice.some((line) => line.includes('已从池子里剔除')), JSON.stringify(checked.advice));
  assert('被封的已被剔出池子', !proxy.proxyStatus().pool.some((row) => row.blocked), JSON.stringify(proxy.proxyStatus().pool.map((row) => [row.addr.split(':')[1], row.blocked])));
  assert('假成功不记为可用', proxy.proxyStatus().pool.filter((row) => row.ok).length === 1, JSON.stringify(proxy.proxyStatus().pool.map((row) => [row.addr.split(':')[1], row.ok])));
  assert('连得上但取不到行情的还留在池里等下一轮', proxy.proxyStatus().alive === 3, JSON.stringify(proxy.proxyStatus().alive));

  // ---- 13. 限流型 429：换一个出口再试 ----
  proxy.resetProxyPool();
  proxy.setProxyPolicy({ ...proxy.PROXY_DEFAULTS, enabled: true, mode: 'proxy_only', protocol: 'http', manual: [`127.0.0.1:${throttlePort}`, `127.0.0.1:${goodPort}`] });
  const retried = await runtime.quoteRequest(`http://127.0.0.1:${httpPort}/api`, { ms: 2000 });
  assert('429 后换出口成功', retried.ok && (await retried.text()).includes('600000'), '');
  assert('429 记在限流那个出口上', proxy.proxyStatus().pool.some((row) => /429/.test(row.lastError ?? '')), JSON.stringify(proxy.proxyStatus().pool.map((row) => row.lastError)));

  // ---- 14. 关掉之后行为立刻回到直连 ----
  proxy.setProxyPolicy({ ...proxy.proxyPolicy(), enabled: false });
  const before = goodProxy.connections();
  await runtime.quoteRequest(clearHttp, { ms: 2000 });
  assert('总开关关掉后不再走代理', goodProxy.connections() === before, `${before} → ${goodProxy.connections()}`);

  // ---- 15. 行情层真的用上了这条接缝：整池数据经代理取回 ----
  proxy.setProxyPolicy({ ...proxy.PROXY_DEFAULTS, enabled: true, mode: 'proxy_only', protocol: 'http', manual: [`127.0.0.1:${goodPort}`] });
  const now = new Date();
  const legs = [];
  for (const key of ['eastmoney:cnStocks', 'eastmoney:cnIndexes', 'eastmoney:cnEtfs']) legs.push(await quotes.probeQuoteSource(key, now));
  const snapError0 = legs.find((row) => !row.ok);
  let snapError = null;
  try { await quotes.getQuotes(true, now); } catch (error) { snapError = error; }
  const health = quotes.quoteHealth('cn', now);
  assert('三条能力经代理都可用', !snapError0, JSON.stringify(legs.map((row) => [row.key, row.ok, row.error, row.rows])));
  assert('行情池经代理建成', !snapError && health.rows >= 1, JSON.stringify({ error: snapError?.sources ?? snapError?.message, rows: health.rows, source: health.source }));
  assert('健康度标出当前源', health.source === 'eastmoney', String(health.source));

  // ---- 16. 没有后门时走严格分支：私网代理进不了池子 ----
  const strictScript = [
    `const p = await import(${JSON.stringify(new URL('../functions/proxy.mjs', import.meta.url).href)});`,
    `const t = await import(${JSON.stringify(new URL('../server/proxy.mjs', import.meta.url).href)});`,
    'const r = t.installProxyTransport({ policyOf: () => p.proxyPolicy() });',
    "p.PROXY_DEFAULTS.apiUrl = '';",
    "p.setProxyPolicy({ enabled: true, mode: 'proxy_only', manual: ['127.0.0.1:8080', '169.254.169.254:3128'] });",
    "let msg = '';",
    "try { await r.quoteRequest('https://push2.eastmoney.com/api/qt/clist/get?x=1', { ms: 800 }); } catch (e) { msg = e.message; }",
    "console.log(JSON.stringify({ privateProxy: p.parseProxyAddress('127.0.0.1:8080'), pool: p.proxyCandidates().length, msg }));",
  ].join('\n');
  const strict = execFileSync(process.execPath, ['--input-type=module', '-e', strictScript], {
    encoding: 'utf8',
    env: { ...process.env, PROXY_ALLOW_PRIVATE: '', NODE_TLS_REJECT_UNAUTHORIZED: '' },
  });
  const strictOut = JSON.parse(strict.trim().split('\n').pop());
  assert('无后门时私网代理被拒', strictOut.privateProxy === null, JSON.stringify(strictOut));
  assert('无后门时池子进不了私网地址', strictOut.pool === 0, JSON.stringify(strictOut));
  assert('无后门时没有可用出口就报错', /proxy_pool_empty|proxy_exhausted/.test(strictOut.msg), strictOut.msg);

  // ---- 17. 后台接口：鉴权、方法限制与状态里的打码 ----
  process.env.ADMIN_USERNAMES = 'px_boss';
  const { handle } = await import('../functions/api.mjs');
  const { createFixtureDb } = await import('./fixture-db.mjs');
  const db = createFixtureDb({ persist: false });
  const supabase = { from: (name) => db.from(name) };
  const call = async (action, payload = {}, token = null, method = 'POST') => {
    const response = await handle({
      request: new Request(`http://x/functions/v1/app?action=${action}`, {
        method,
        headers: { 'content-type': 'application/json' },
        body: method === 'GET' ? undefined : JSON.stringify(token ? { ...payload, token } : payload),
      }),
      supabase,
    });
    return { status: response.status, json: await response.json() };
  };
  const boss = await call('register', { username: 'px_boss', password: 'probe12345', display: '代理后台' });
  const bt = boss.json.token;
  const guest = await call('register', { username: 'px_guest', password: 'probe12345', display: '路人' });

  const forbidden = await call('admin_proxy_pull', {}, guest.json.token);
  assert('普通用户不能取代理', forbidden.status === 403 && forbidden.json.code === 'not_admin', JSON.stringify(forbidden.json));
  const wrongMethod = await call('admin_proxy_check', {}, bt, 'GET');
  assert('检测只能用 POST', wrongMethod.status === 405, JSON.stringify(wrongMethod.json));

  proxy.resetProxyPool();
  listApi.set({ code: 200, data: { proxies: [`127.0.0.1:${goodPort}`, `127.0.0.1:${badPort}`] } });
  const status = (await call('admin_quote_status', {}, bt)).json;
  assert('状态里带代理这一块', Boolean(status.proxy) && status.proxy.runtime === 'node' && status.proxy.defaults.enabled === false, JSON.stringify(status.proxy?.runtime));
  assert('状态里的 API 地址已打码', !String(status.proxy?.status?.policy?.apiUrl ?? '').includes('SECRETVALUE'), String(status.proxy?.status?.policy?.apiUrl));

  // ---- 18. 保存：合法的一改就生效；有一项非法就整次不落库 ----
  const goodSave = await call('admin_settings', {
    patch: { proxy: { ...proxy.PROXY_DEFAULTS, enabled: true, mode: 'proxy_only', apiUrl: listUrl, manual: [`127.0.0.1:${goodPort}`], totalMs: 4000 } }, confirm: true,
  }, bt);
  assert('合法代理配置能保存', goodSave.status === 200 && goodSave.json.changed['proxy.enabled'] === true, JSON.stringify(goodSave.json?.changed ?? goodSave.json));
  const badSave = await call('admin_settings', {
    patch: { proxy: { ...proxy.proxyPolicy(), apiUrl: 'http://insecure.example.com/api', manual: ['not-an-address:xx', 'https://1.2.3.4:8080'] } }, confirm: true,
  }, bt);
  assert('非法项逐项说回去', badSave.status === 400
    && (badSave.json.rejected ?? []).some((line) => line.startsWith('apiUrl'))
    && (badSave.json.rejected ?? []).some((line) => line.startsWith('manual')), JSON.stringify(badSave.json.rejected));
  const untouched = (await call('admin_quote_status', {}, bt)).json.proxy.settings;
  assert('有一项被拒就整次不落库', untouched.apiUrl === listUrl && untouched.enabled === true, JSON.stringify({ apiUrl: untouched.apiUrl, enabled: untouched.enabled }));
  const savedAudit = (await call('admin_audit', { limit: 30 }, bt)).json.rows.find((row) => row.action === 'admin_settings');
  assert('审计里的 API 地址不带凭证', !String(savedAudit?.detail).includes('SECRETVALUE'), String(savedAudit?.detail).slice(0, 180));
  assert('审计记下的是打码后的地址', /\*\*\*/.test(String(savedAudit?.detail)), String(savedAudit?.detail).slice(0, 200));

  // ---- 19. 后台动作真的走通了代理池 ----
  const pulled = await call('admin_proxy_pull', { force: true }, bt);
  assert('后台取列表成功', pulled.status === 200 && pulled.json.added >= 1, JSON.stringify(pulled.json));
  const checkedAgain = await call('admin_proxy_check', {}, bt);
  assert('后台检测给出逐个结论', checkedAgain.status === 200 && checkedAgain.json.total >= 2
    && checkedAgain.json.results.some((row) => row.ok) && checkedAgain.json.results.some((row) => !row.ok), JSON.stringify(checkedAgain.json?.advice));
  assert('检测结论按可用比例给', ['partial', 'ok'].includes(checkedAgain.json.verdict), String(checkedAgain.json.verdict));

  // ---- 20. 备份：默认打码，预检会提醒，显式要求才原样带走 ----
  const exported = await call('admin_backup_export', {}, bt);
  const proxyRow = (exported.json.document?.tables?.settings ?? []).find((row) => row.key === 'proxy');
  assert('备份里有代理配置这一项', Boolean(proxyRow), String(exported.json?.code));
  assert('备份里的 API 地址已打码', !String(proxyRow?.value).includes('SECRETVALUE'), String(proxyRow?.value).slice(0, 160));
  assert('备份标出已打码', exported.json.document?.meta?.proxy_masked === true, JSON.stringify(exported.json.document?.meta));
  const previewed = await call('admin_backup_preview', { document: exported.json.document }, bt);
  assert('预检提醒要重填 API 地址', (previewed.json.warnings ?? []).some((line) => line.includes('代理')), JSON.stringify(previewed.json.warnings));
  const backup = await import('../functions/backup.mjs');
  const plainDoc = await backup.exportBackup(supabase, { proxyPlain: true });
  assert('显式不过滤时原样带走', String((plainDoc.tables.settings ?? []).find((row) => row.key === 'proxy')?.value).includes('SECRETVALUE'), '');

  const failed = results.filter((row) => !row.ok);
  for (const row of results) console.log(`${row.ok ? 'PASS' : 'FAIL'} ${row.name}${row.detail ? ` —— ${row.detail}` : ''}`);
  console.log(`\n${results.length - failed.length}/${results.length} 通过`);

  // 先把结论打完再收尾：假服务器的 close 回调在有残留连接时不一定回来
  await Promise.race([
    closeAll([originHttp, originTls, originEmpty, listApi.server, goodProxy.server, badProxy.server, authProxy.server, deadProxy.server, emptyProxy.server, throttleProxy.server]),
    new Promise((resolve) => setTimeout(resolve, 1_200).unref()),
  ]);
  rmSync(dir, { recursive: true, force: true });
  process.exit(failed.length ? 1 : 0);
};

main().catch((error) => {
  console.error('探针异常', error?.stack ?? error);
  for (const row of results) console.log(`${row.ok ? 'PASS' : 'FAIL'} ${row.name}${row.detail ? ` —— ${row.detail}` : ''}`);
  process.exit(1);
});
