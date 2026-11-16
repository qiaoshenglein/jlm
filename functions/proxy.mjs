// 代理策略与池子状态。这一层不碰 socket：拉列表、建隧道、DNS 二次校验都在自建入口那边做，
// 这里只管「配置合不合法、池子里还有谁可用、什么时候该换」。
// 实测跑通过的代理列表 API，直接写进程序当默认值：免注册、免凭据，
// GET 一下就在 data.proxies 里返回一批 `ip:port`（本机实测出口被防火墙挡住时取回的地址连不上，
// 那是网络问题不是接口问题，接口本身按这个形状解析）。
export const PROXY_API_SCDN = 'https://proxy.scdn.io/api/get_proxy.php';
export const PROXY_API_PRESETS = [
  { key: 'scdn', label: 'scdn.io', url: PROXY_API_SCDN, docs: 'https://proxy.scdn.io/api_docs.php', note: '免凭据；count 与 protocol 由本程序自动带上' },
];

export const PROXY_DEFAULTS = {
  enabled: false,
  mode: 'direct_first',      // direct_first：直连优先，失败才走代理；proxy_only：一律走代理
  apiUrl: PROXY_API_SCDN,     // 内置默认；可用环境变量 PROXY_API_URL 或后台改
  protocol: 'http',           // 向列表 API 要哪种代理（http=明文 CONNECT，https=对代理再套一层 TLS）
  count: 5,                   // 一次取几个
  ttlMs: 60_000,              // 列表多久算旧
  minPullMs: 30_000,          // 两次拉列表的最小间隔（防把 API 打爆，也防配额被烧光）
  maxFails: 2,                // 连续失败几次就剔除
  connectMs: 4_000,           // 与代理建连的等待上限
  totalMs: 9_000,             // 单次经代理请求的总上限
  directCoolMs: 60_000,       // 直连失败后多久内不再试直连（否则每个请求都要先撞一次超时）
  manual: [],                 // 手动配置的代理，host:port
};

const NUM_LIMITS = {
  count: [1, 50],
  ttlMs: [10_000, 3_600_000],
  minPullMs: [5_000, 3_600_000],
  maxFails: [1, 10],
  connectMs: [1_000, 20_000],
  totalMs: [2_000, 60_000],
  directCoolMs: [5_000, 600_000],
};
const MODES = ['direct_first', 'proxy_only'];
// 只做 CONNECT 隧道这两种：socks5 要引第三方依赖，宁可不给这个选项，也不给一个跑不通的选项
const PROTOCOLS = ['http', 'https'];
const PROXY_ADDR = /^[a-z0-9][a-z0-9._-]{0,252}:\d{1,5}$/i;

// 回环 / 私网 / 链路本地 / 云元数据 / CGNAT：这些地址当代理用，等于让服务端去敲自己的内网门。
// 这里只查字面量，域名要等 DNS 之后再查一次（在 server/proxy.mjs 里做）。
const PRIVATE_V4 = [/^0\./, /^10\./, /^127\./, /^169\.254\./, /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, /^198\.1[89]\./, /^24[0-7]\./];
const PRIVATE_V6 = [/^::1$/, /^f[cd]/i, /^fe80/i, /^::$/];

export const isPrivateHost = (host) => {
  const text = String(host ?? '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!text) return true;
  if (text === 'localhost' || text.endsWith('.localhost') || text.endsWith('.internal') || text.endsWith('.local')) return true;
  if (PRIVATE_V4.some((re) => re.test(text))) return true;
  if (text.includes(':') && PRIVATE_V6.some((re) => re.test(text))) return true;
  return false;
};

// 测试用后门：回归里要拿本地 mock 代理当出口，而 mock 就在 127.0.0.1 上。
// 只有显式设了环境变量才放开私网检查，生产路径永远走严格分支。
export const allowPrivateProxy = () => String(globalThis.process?.env?.PROXY_ALLOW_PRIVATE ?? '') === '1';

// 环境变量用来覆盖内置默认（备份里这一项是打码的，换机时用它可以一步补回来）。
// 只有默认值走环境变量，后台存过的值永远优先。
const envText = (name) => String(globalThis.process?.env?.[name] ?? globalThis.Deno?.env?.get?.(name) ?? '').trim();
const bootUrl = checkApiUrl(envText('PROXY_API_URL'));
if (bootUrl.ok && bootUrl.value) PROXY_DEFAULTS.apiUrl = bootUrl.value;

/** 拆 host:port；带 scheme、带凭据、路径里有东西的一律不认（凭据会跟着备份文件跑出去） */
export function parseProxyAddress(input) {
  const text = String(input ?? '').trim();
  if (!text || /\s/.test(text) || text.includes('/') || text.includes('@') || text.includes('://')) return null;
  const match = text.match(/^(.*):(\d{1,5})$/);
  if (!match) return null;
  const host = match[1].toLowerCase();
  const port = Number(match[2]);
  if (!host || !PROXY_ADDR.test(text)) return null;
  if (port < 1 || port > 65_535) return null;
  if (isPrivateHost(host) && !allowPrivateProxy()) return null;
  return { host, port, addr: `${host}:${port}` };
}

/** API 地址：必须 https、不能带凭据、主机不能解析到私网（字面量这一关先挡住） */
export function checkApiUrl(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return { ok: true, value: '', reason: '' };
  let url = null;
  try {
    url = new URL(text);
  } catch {
    return { ok: false, value: text, reason: '不是合法 URL' };
  }
  if (url.protocol !== 'https:') return { ok: false, value: text, reason: '只允许 https（代理列表里含第三方地址，明文传输等于把它送给中间人）' };
  if (url.username || url.password) return { ok: false, value: text, reason: 'URL 里不能带账号口令：本程序只支持免凭据的代理出口' };
  if (isPrivateHost(url.hostname) && !allowPrivateProxy()) return { ok: false, value: text, reason: '主机是内网/元数据地址' };
  return { ok: true, value: url.toString(), reason: '' };
}

export function checkProxyPolicy(patch = {}) {
  // 从默认值起步，逐项只采纳合法的那一份：整体 spread 再挑毛病的话，
  // 「被拒的键」仍会留在返回值里，谁忘了看 rejected 就等于把非法配置装了进去
  const values = { ...PROXY_DEFAULTS, manual: [...(PROXY_DEFAULTS.manual ?? [])] };
  const rejected = [];
  const KNOWN = ['enabled', 'manual', 'mode', 'protocol', 'apiUrl'];
  for (const key of Object.keys(patch)) {
    if (KNOWN.includes(key) || NUM_LIMITS[key]) continue;
    rejected.push(`${key}：不是可配置项`);
  }
  if (patch.enabled !== undefined) values.enabled = patch.enabled === true || patch.enabled === 'true' || patch.enabled === 1;
  if (patch.mode !== undefined) {
    if (MODES.includes(patch.mode)) values.mode = patch.mode;
    else rejected.push(`mode：只能是 ${MODES.join(' / ')}`);
  }
  if (patch.protocol !== undefined) {
    if (PROTOCOLS.includes(patch.protocol)) values.protocol = patch.protocol;
    else rejected.push(`protocol：只能是 ${PROTOCOLS.join(' / ')}`);
  }
  if (patch.apiUrl !== undefined) {
    const checked = checkApiUrl(patch.apiUrl);
    if (checked.ok) values.apiUrl = checked.value;
    else rejected.push(`apiUrl：${checked.reason}`);
  }
  for (const key of Object.keys(NUM_LIMITS)) {
    if (patch[key] === undefined) continue;
    const [min, max] = NUM_LIMITS[key];
    const number = Number(patch[key]);
    if (Number.isFinite(number) && number >= min && number <= max) values[key] = Math.round(number);
    else rejected.push(`${key}：超出允许范围 ${min}–${max}`);
  }
  if (patch.manual !== undefined) {
    const list = Array.isArray(patch.manual) ? patch.manual : String(patch.manual).split(/[,，\s]+/);
    const clean = [];
    const bad = [];
    for (const item of list) {
      const text = String(item ?? '').trim();
      if (!text) continue;
      const parsed = parseProxyAddress(text);
      if (!parsed) bad.push(text);
      else if (!clean.includes(parsed.addr)) clean.push(parsed.addr);
    }
    if (bad.length) rejected.push(`manual：${bad.length} 个地址不合法或指向内网（${bad.slice(0, 3).join('、')}${bad.length > 3 ? '…' : ''}）`);
    else if (clean.length > 20) rejected.push('manual：最多 20 个');
    else values.manual = clean;
  }
  return { values, rejected };
}

// ---- 当前生效的策略 ----
// 设置表里存的就是引擎实际在用的那份（和行情源同一套做法）：readSettingsCached 每轮回灌一次。
let policy = { ...PROXY_DEFAULTS, manual: [...PROXY_DEFAULTS.manual] };

export function proxyPolicy() {
  return policy;
}

export function setProxyPolicy(patch = {}) {
  const { values, rejected } = checkProxyPolicy(patch);
  const changed = JSON.stringify(values) !== JSON.stringify(policy);
  if (changed) {
    const manualChanged = JSON.stringify(values.manual) !== JSON.stringify(policy.manual);
    policy = values;
    // 手动清单缩了就把不在清单里的条目删掉；其它条目留着——代理本来就短命，
    // 但「改个超时就把刚验活的池子清空」会让下一次请求白跑一轮。
    if (manualChanged) pruneManual(values);
  }
  return { values, rejected, changed };
}

export function resetProxyPolicy() {
  return setProxyPolicy(PROXY_DEFAULTS);
}

// ---- 运行时接缝 ----
// 拉列表、建隧道、DNS 二次校验只有自建 Node 能做（边缘运行时没有原始套接字），
// 所以入口进程把能力注入这里，functions 层只负责判断「有没有、该不该用」。
let runtime = null;

export function setProxyRuntime(impl) {
  runtime = impl && typeof impl.quoteRequest === 'function' ? impl : null;
  return runtime ? 'installed' : 'cleared';
}

export const proxyRuntime = () => runtime;

// 直连这一路的健康度：失败后要冷却一段时间，否则每个请求都先白等一次超时
let direct = { failAt: 0, fails: 0, okAt: 0, lastError: null };

export const noteDirectFail = (error, nowMs = Date.now()) => {
  direct.fails += 1;
  direct.failAt = nowMs;
  direct.lastError = String(error ?? 'failed').slice(0, 80);
};

export const noteDirectOk = (nowMs = Date.now()) => {
  direct = { failAt: 0, fails: 0, okAt: nowMs, lastError: null };
  counters.directOk += 1;
};

export const resetDirectState = () => { direct = { failAt: 0, fails: 0, okAt: 0, lastError: null }; };

/** 直连是否还值得试：proxy_only 永远不试；刚失败过就冷却 */
export function directReady(p = policy, nowMs = Date.now()) {
  if (p.mode === 'proxy_only') return false;
  return !direct.failAt || nowMs - direct.failAt >= p.directCoolMs;
}

export const directState = (nowMs = Date.now()) => ({
  fails: direct.fails,
  lastError: direct.lastError,
  okAt: direct.okAt ? new Date(direct.okAt).toISOString() : null,
  coolingMs: direct.failAt ? Math.max(0, policy.directCoolMs - (nowMs - direct.failAt)) : 0,
});

// ---- 池子状态 ----
// 池子是进程内的临时资产：代理本来就短命，落库反而会把死地址存下来，重启后重新拉一次更干净。
const pool = new Map();
let counters = { pulls: 0, lastPullAt: 0, lastPullError: null, served: 0, directOk: 0, proxyOk: 0, proxyFail: 0 };

const entryOf = (addr) => {
  if (!pool.has(addr)) pool.set(addr, { addr, fails: 0, ok: 0, lastError: null, lastOkAt: 0, lastMs: null, addedAt: 0, blocked: false, probes: 0 });
  return pool.get(addr);
};

export function addProxies(list, { nowMs = Date.now(), source = 'api' } = {}) {
  const added = [];
  for (const item of list ?? []) {
    const parsed = typeof item === 'string' ? parseProxyAddress(item) : item?.addr ? parseProxyAddress(item.addr) : null;
    if (!parsed) continue;
    const entry = entryOf(parsed.addr);
    if (!entry.addedAt) { entry.addedAt = nowMs; entry.source = source; added.push(parsed.addr); }
    else if (source === 'manual') entry.source = 'manual';
  }
  return added;
}

/** 手动清单删了条目，池子里对应的也要跟着删——否则「取消勾选」还能被用上 */
export function pruneManual(p = policy) {
  const keep = new Set(p.manual ?? []);
  let removed = 0;
  for (const [addr, entry] of pool) {
    if (entry.source === 'manual' && !keep.has(addr)) { pool.delete(addr); removed += 1; }
  }
  return removed;
}

export function markProxyOk(addr, ms, nowMs = Date.now()) {
  const entry = entryOf(addr);
  entry.fails = 0;
  entry.ok += 1;
  entry.lastOkAt = nowMs;
  entry.lastMs = ms;
  entry.lastError = null;
  entry.blocked = false;
  counters.proxyOk += 1;
}

export function markProxyFail(addr, error, nowMs = Date.now()) {
  const entry = entryOf(addr);
  entry.fails += 1;
  entry.lastError = String(error ?? 'failed').slice(0, 80);
  // 上游/代理明确回 403、407，说明这个出口被认出来了，和「连不上」要分开记
  if (/40[37]|blocked|denied|forbidden|proxy_auth|tunnel_/i.test(entry.lastError)) entry.blocked = true;
  counters.proxyFail += 1;
  return entry.fails;
}

export function evictProxy(addr) {
  return pool.delete(String(addr));
}

export function resetProxyPool() {
  pool.clear();
  counters = { pulls: 0, lastPullAt: 0, lastPullError: null, served: 0, lastVia: null, directOk: 0, proxyOk: 0, proxyFail: 0 };
}

const aliveEntries = (p) => [...pool.values()].filter((entry) => entry.fails < p.maxFails && !entry.blocked);

/** 谁先上：手动钉住的 > 最近验活的 > 最慢的；全挂了才允许再碰被封的那几个 */
export function proxyCandidates(p = policy) {
  const manual = new Set(p.manual ?? []);
  const score = (entry) => (manual.has(entry.addr) ? 1 : 0);
  const usable = [...pool.values()].filter((entry) => entry.fails < p.maxFails);
  const list = aliveEntries(p).length ? aliveEntries(p) : usable;
  return [...list]
    .sort((a, b) => score(b) - score(a)
      || (a.blocked ? 1 : 0) - (b.blocked ? 1 : 0)
      || (a.lastOkAt && b.lastOkAt ? b.lastOkAt - a.lastOkAt : 0)
      || (a.lastMs ?? 1e9) - (b.lastMs ?? 1e9))
    .map((entry) => entry.addr);
}

export function poolAge(nowMs = Date.now()) {
  return counters.lastPullAt ? nowMs - counters.lastPullAt : null;
}

export function proxyStatus(p = policy, nowMs = Date.now()) {
  return {
    policy: { ...p, apiUrl: maskApiUrl(p.apiUrl), manual: [...(p.manual ?? [])] },
    pool: [...pool.values()].map((entry) => ({
      addr: entry.addr,
      source: entry.source ?? 'api',
      pinned: (p.manual ?? []).includes(entry.addr),
      fails: entry.fails,
      ok: entry.ok,
      probes: entry.probes,
      blocked: entry.blocked,
      usable: entry.fails < p.maxFails && !entry.blocked,
      lastError: entry.lastError,
      lastMs: entry.lastMs,
      lastOkAt: entry.lastOkAt ? new Date(entry.lastOkAt).toISOString() : null,
      ageMs: entry.addedAt ? nowMs - entry.addedAt : null,
    })).sort((a, b) => (b.usable ? 1 : 0) - (a.usable ? 1 : 0) || a.addr.localeCompare(b.addr)),
    counters: { ...counters, lastPullAt: counters.lastPullAt ? new Date(counters.lastPullAt).toISOString() : null, poolAgeMs: poolAge(nowMs) },
    direct: directState(nowMs),
    alive: aliveEntries(p).length,
  };
}

export const noteProbe = (addr, nowMs = Date.now()) => {
  const entry = entryOf(addr);
  entry.probes += 1;
  entry.lastProbeAt = nowMs;
};

export const notePull = (nowMs, error = null) => {
  counters.pulls += 1;
  counters.lastPullAt = nowMs;
  counters.lastPullError = error ? String(error).slice(0, 120) : null;
};

export const noteServed = (via) => { counters.served += 1; counters.lastVia = via; };

/** 需要拉新列表：开了代理、配了 API、池子空或全挂了、且离上次拉取超过最小间隔 */
export function needsNewList(p = policy, nowMs = Date.now()) {
  if (!p.enabled || !p.apiUrl) return false;
  const stale = !counters.lastPullAt || nowMs - counters.lastPullAt > p.ttlMs;
  const exhausted = aliveEntries(p).length === 0;
  const cooled = !counters.lastPullAt || nowMs - counters.lastPullAt >= p.minPullMs;
  return (stale || exhausted) && cooled;
}

/** 备份与审计里的代理值：只留主机名与开关，路径与查询串（可能带 key）一律抹掉 */
export function maskApiUrl(raw) {
  const text = String(raw ?? '');
  if (!text) return '';
  // 打码必须可重复：备份导入后库里存的就是打码过的值，再导出时若二次打码，
  // 「导出→导入→导出」的校验和会对不上，看起来像数据被改坏了
  if (text.includes('***')) return text;
  try {
    const url = new URL(text);
    return `${url.host}${url.pathname === '/' ? '' : url.pathname.split('/').slice(0, 2).join('/')}?***`;
  } catch {
    return '***';
  }
}

export function maskProxyValue(value) {
  let parsed = null;
  try {
    parsed = typeof value === 'string' ? JSON.parse(value) : value;
  } catch {
    return { proxy: '***', note: '无法解析，已整体打码' };
  }
  if (!parsed || typeof parsed !== 'object') return { proxy: '***', note: '无法解析，已整体打码' };
  // 地址这一项直接抹空，而不是留个「看着像地址」的残串：
  // 残串导入后会被判非法并回落到内置默认，等于悄悄换了服务商；抹空就是「没配」，语义唯一，
  // 而且导出→导入→再导出的字节完全一致（备份校验和不能因为打码而变）。
  const hint = parsed.apiUrl ? maskApiUrl(parsed.apiUrl) : '';
  return {
    proxy: {
      ...parsed,
      apiUrl: '',
      manual: (parsed.manual ?? []).slice(0, 20),
    },
    note: hint ? `代理 API 地址未随备份带走（原为 ${hint}）；换机后请在后台重新填写。` : '代理 API 地址未随备份带走。',
  };
}

export const PROXY_SETTING_KEY = 'proxy';
