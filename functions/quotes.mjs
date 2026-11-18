// 行情层：多家公开接口 + 按优先级依次降级。
// 每个执行环境内做快照缓存（默认 2.5 秒），所有请求共享，避免高频打爆上游。
// 具体接口与字段口径在 quote-sources.mjs，这一层只管「现在用的是谁、什么时候换、坏了怎么退」。
import { MICRO, bjParts, etParts, marketOf, splitSecid } from './rules.mjs';
import {
  INDEX_ETFS, KEY_INDEXES, PROVIDER_ORDER_DEFAULT, QUOTE_PROVIDERS, US_INDEXES,
} from './quote-sources.mjs';
import { noteCache, noteCall } from './usage.mjs';

// 指数与指数 ETF 名单定义在适配器层（三家都要用它点名取数），这里原样导出给接口层与前端
export { INDEX_ETFS, KEY_INDEXES, US_INDEXES };

// 域名白名单：所有源的主机都在这里。填清单外的主机等于给服务端开一个内网探测口（SSRF），
// 而且没核对过字段口径的源会让涨跌停、成交额、时间戳全部失真——那比没行情更危险。
export const QUOTE_HOSTS = Object.values(QUOTE_PROVIDERS).flatMap((item) => item.hosts);

export const QUOTE_SOURCE_DEFAULTS = {
  // 东方财富：字段最全，也是唯一有美股榜的；任何运行时都能解 UTF-8，所以默认排第一
  listHost: 'push2.eastmoney.com',
  singleHost: 'push2.eastmoney.com',
  histHost: 'push2his.eastmoney.com',
  searchHost: 'searchapi.eastmoney.com',
  // 腾讯
  txQuoteHost: 'qt.gtimg.cn',
  txListHost: 'proxy.finance.qq.com',
  txHistHost: 'ifzq.gtimg.cn',
  txKlineHost: 'web.ifzq.gtimg.cn',
  // 新浪
  sinaQuoteHost: 'hq.sinajs.cn',
  sinaListHost: 'vip.stock.finance.sina.com.cn',
  sinaHistHost: 'quotes.sina.cn',

  sourceOrder: [...PROVIDER_ORDER_DEFAULT], // 依次尝试，第一个成功的接管本轮
  fallbackEnabled: true,                     // 关掉就只用首选源，不降级
  cooldownMs: 60_000,                        // 失败的源在这段时间内不再尝试

  timeoutMs: 4_000,
  cnTtlMs: 2_500,
  usTtlMs: 5_000,     // 美股流动性好、盘口变化对仿真撮合影响小，5 秒一档减少上游压力
  fxTtlMs: 60_000,
  trendsTtlMs: 20_000,
  klineTtlMs: 300_000,
  cnPoolSize: 150,    // 沪深个股池：按成交额取前 N
  usPoolSize: 200,    // 美股池：三个交易所按成交额取前 N
  indexPoolSize: 60,
  etfs: [...INDEX_ETFS],
  staleWarnMinutes: 30, // 检测页判定「数据偏旧」的阈值（撮合的当日判定不受它影响）
};

// 每一项都有硬边界：越界值直接拒绝，不静默夹取，避免后台显示的与实际用的不一致
const SOURCE_LIMITS = {
  timeoutMs: [1_000, 15_000],
  cnTtlMs: [500, 30_000], usTtlMs: [1_000, 60_000], fxTtlMs: [15_000, 900_000],
  trendsTtlMs: [5_000, 300_000], klineTtlMs: [60_000, 3_600_000],
  cnPoolSize: [50, 500], usPoolSize: [50, 500], indexPoolSize: [10, 120],
  cooldownMs: [5_000, 900_000],
  staleWarnMinutes: [10, 1_440],
};
const HOST_KEYS = ['listHost', 'singleHost', 'histHost', 'searchHost',
  'txQuoteHost', 'txListHost', 'txHistHost', 'txKlineHost', 'sinaQuoteHost', 'sinaListHost', 'sinaHistHost'];
const BOOL_KEYS = ['fallbackEnabled'];
const ETFS_MAX = 20;
const CN_SECID_ONLY = /^[012]\.\d{6}$/;
const DEMAND_MAX = 400;
const PROVIDER_KEYS = Object.keys(QUOTE_PROVIDERS);

const cloneSource = (values) => ({ ...values, etfs: [...values.etfs], sourceOrder: [...values.sourceOrder] });
let SOURCE = cloneSource(QUOTE_SOURCE_DEFAULTS);

export function quoteSource() {
  return cloneSource(SOURCE);
}

export const sourceHostOk = (host) => QUOTE_HOSTS.includes(String(host));

// 校验并合并；返回 {values, rejected} 让调用方能把「哪些项被拒」如实说出去
export function checkQuoteSource(patch = {}) {
  const values = cloneSource(SOURCE);
  const rejected = [];
  for (const key of HOST_KEYS) {
    if (patch[key] === undefined) continue;
    if (sourceHostOk(patch[key])) values[key] = String(patch[key]);
    else rejected.push(`${key}：域名不在可用清单里`);
  }
  for (const key of Object.keys(SOURCE_LIMITS)) {
    if (patch[key] === undefined) continue;
    const [min, max] = SOURCE_LIMITS[key];
    const number = Number(patch[key]);
    if (Number.isFinite(number) && number >= min && number <= max) values[key] = Math.round(number);
    else rejected.push(`${key}：超出允许范围 ${min}–${max}`);
  }
  for (const key of BOOL_KEYS) {
    if (patch[key] === undefined) continue;
    values[key] = patch[key] === true || patch[key] === 'true' || patch[key] === 1;
  }
  if (patch.sourceOrder !== undefined) {
    const list = Array.isArray(patch.sourceOrder) ? patch.sourceOrder : String(patch.sourceOrder).split(',');
    const clean = [];
    let bad = false;
    for (const item of list) {
      const key = String(item ?? '').trim();
      if (!PROVIDER_KEYS.includes(key)) { bad = true; continue; }
      if (!clean.includes(key)) clean.push(key);
    }
    if (bad) rejected.push(`sourceOrder：只能填 ${PROVIDER_KEYS.join(' / ')}`);
    else if (!clean.length) rejected.push('sourceOrder：至少要有一个源');
    else values.sourceOrder = clean;
  }
  if (patch.etfs !== undefined) {
    const list = Array.isArray(patch.etfs) ? patch.etfs : String(patch.etfs).split(',');
    const clean = [...new Set(list.map((item) => String(item ?? '').trim()).filter((item) => CN_SECID_ONLY.test(item)))];
    if (!clean.length && list.filter(Boolean).length) rejected.push('etfs：没有合法的 secid（形如 1.510300）');
    else if (clean.length > ETFS_MAX) rejected.push(`etfs：最多 ${ETFS_MAX} 条`);
    else values.etfs = clean;
  }
  for (const key of Object.keys(patch)) {
    if (HOST_KEYS.includes(key) || SOURCE_LIMITS[key] || BOOL_KEYS.includes(key) || key === 'etfs' || key === 'sourceOrder') continue;
    rejected.push(`${key}：不是可配置项`);
  }
  return { values, rejected };
}

// ---- 每个源的运行状态 ----
// 冷却是这条链能用的关键：没有它，首选源被封时每轮都要先吃一次它的超时，列表一直转圈
const state = new Map();
const stateOf = (key) => {
  if (!state.has(key)) state.set(key, { failStreak: 0, coolUntil: 0, lastError: null, lastOkAt: 0, lastMs: null });
  return state.get(key);
};

function markOk(key, ms, nowMs) {
  const box = stateOf(key);
  box.failStreak = 0;
  box.coolUntil = 0;
  box.lastError = null;
  box.lastOkAt = nowMs;
  box.lastMs = ms;
}

function markFail(key, message, nowMs) {
  const box = stateOf(key);
  box.failStreak += 1;
  box.lastError = String(message ?? 'failed').slice(0, 60);
  box.coolUntil = nowMs + SOURCE.cooldownMs;
}

export function quoteProviders() {
  const nowMs = Date.now();
  return PROVIDER_KEYS.map((key) => {
    const provider = QUOTE_PROVIDERS[key];
    const box = stateOf(key);
    return {
      key,
      label: provider.label,
      hosts: provider.hosts,
      caps: Object.entries(provider.caps).filter(([, on]) => on).map(([name]) => name),
      rank: SOURCE.sourceOrder.indexOf(key),
      enabled: SOURCE.sourceOrder.includes(key),
      failStreak: box.failStreak,
      coolingFor: box.coolUntil > nowMs ? Math.ceil((box.coolUntil - nowMs) / 1000) : 0,
      lastError: box.lastError,
      lastOkAt: box.lastOkAt ? new Date(box.lastOkAt).toISOString() : null,
      lastMs: box.lastMs,
    };
  });
}

// 本轮可用的源，按配置顺序；关掉降级时只留第一个
function chainOrder(nowMs) {
  const usable = SOURCE.sourceOrder.filter((key) => QUOTE_PROVIDERS[key]);
  const list = SOURCE.fallbackEnabled ? usable : usable.slice(0, 1);
  const skipped = [];
  const ready = list.filter((key) => {
    const box = stateOf(key);
    if (box.coolUntil > nowMs) {
      skipped.push({ key, label: QUOTE_PROVIDERS[key].label, reason: `冷却中 ${Math.ceil((box.coolUntil - nowMs) / 1000)} 秒 · ${box.lastError ?? '上次失败'}` });
      return false;
    }
    return true;
  });
  return { ready, skipped };
}

// 空返回也算这一家没用：有些接口全挂了却回一个空数组，若当成成功就不会再往下家试
const isEmptyResult = (cap, value) => {
  if (value === null || value === undefined) return true;
  if (Array.isArray(value)) return value.length === 0;
  if (cap === 'trends') return !Array.isArray(value.points) || value.points.length === 0;
  if (cap === 'fx') return !Number.isFinite(value.rate);
  return false;
};

// 依次尝试：第一个成功的返回值与它的名字，全失败则把每家的错误一起带出去
async function withChain(cap, args, nowMs) {
  const { ready, skipped } = chainOrder(nowMs);
  // 某项能力只有个别源提供时（检索、美股榜只有东财有），冷却不能把它变成「这项没了」：
  // 宁可多等一次超时，也要保住单源功能——否则东财一被限流，搜索框就直接空掉
  const capable = SOURCE.sourceOrder.filter((key) => QUOTE_PROVIDERS[key]?.caps[cap]);
  const queue = ready.filter((key) => QUOTE_PROVIDERS[key]?.caps[cap]).length
    ? ready
    : capable;
  const failures = [];
  for (const key of queue) {
    const provider = QUOTE_PROVIDERS[key];
    if (!provider.caps[cap]) {
      failures.push({ key, label: provider.label, error: '该源不提供这项能力' });
      continue;
    }
    const started = Date.now();
    try {
      const value = await provider[cap](SOURCE, ...args);
      if (isEmptyResult(cap, value)) {
        noteCall({ cap, provider: key, ok: false, ms: Date.now() - started });
        markFail(key, '返回为空', nowMs);
        failures.push({ key, label: provider.label, error: '返回为空' });
        continue;
      }
      noteCall({ cap, provider: key, ok: true, ms: Date.now() - started });
      markOk(key, Date.now() - started, nowMs);
      return { value, provider: key, label: provider.label, fellBack: key !== SOURCE.sourceOrder[0], tried: failures, skipped };
    } catch (error) {
      noteCall({ cap, provider: key, ok: false, ms: Date.now() - started });
      const reason = String(error?.cause?.code ?? error?.message ?? error).slice(0, 60);
      markFail(key, reason, nowMs);
      failures.push({ key, label: provider.label, error: reason });
    }
  }
  const thrown = new Error(failures.at(-1)?.error ?? 'all_sources_cooling');
  thrown.sources = failures;
  thrown.skipped = skipped;
  throw thrown;
}

// 「本轮真正需要定价的代码」：持仓、自选、按代码直查过的标的都记在这里。
// 美股只有东财有榜，源降级后靠这份清单 + 一份流动股表保证持仓估值与强平判定不瞎。
const demand = new Set();
export function rememberDemand(secids) {
  for (const secid of secids ?? []) {
    if (typeof secid !== 'string' || secid.length > 20) continue;
    if (!demand.has(secid) && demand.size >= DEMAND_MAX) demand.delete(demand.values().next().value);
    demand.delete(secid);
    demand.add(secid);
  }
}

// 代码 → secid 的本地兜底：检索接口不可用时（源降级或限流），用已经加载过的池子与记过的代码来认。
// 只认完全匹配，不做前缀猜测——猜错交易所会让同一只股票出现两条行情。
export function secidByCode(code, market = 'cn') {
  const needle = String(code ?? '').trim().toUpperCase();
  if (!needle) return null;
  for (const box of [usSnapshot.data, snapshot.data]) {
    for (const quote of box?.values?.() ?? []) {
      if (String(quote.code).toUpperCase() !== needle) continue;
      if (marketOf(quote.secid) === market) return quote.secid;
    }
  }
  for (const secid of demand) {
    if (marketOf(secid) !== market) continue;
    if (splitSecid(secid).code.toUpperCase() === needle) return secid;
  }
  return null;
}

// ---- 缓存 ----
const FX_FALLBACK = Math.round(6.7 * MICRO);
let snapshot = { at: 0, day: '', data: null, note: '', provider: '', fellBack: false };
let usSnapshot = { at: 0, day: '', data: null, note: '', provider: '', fellBack: false };
let lastError = null;
let usLastError = null;
let extraCache = new Map();
let fxCache = { at: 0, rate: FX_FALLBACK, provider: '', label: '' };
const charts = new Map();
const chartFlights = new Map();
const INDEX_TTL_MS = 6 * 3600_000;
const INDEX_RETRY_MS = 5 * 60_000;
let symbolIndex = { at: 0, list: [] };

// 换源或换 TTL 之后必须清缓存，否则「检测」打到的还是旧快照，结论是假的
function resetCaches() {
  snapshot = { at: 0, day: '', data: null, note: '', provider: '', fellBack: false };
  usSnapshot = { at: 0, day: '', data: null, note: '', provider: '', fellBack: false };
  lastError = null;
  usLastError = null;
  extraCache = new Map();
  fxCache = { at: 0, rate: FX_FALLBACK, provider: '', label: '' };
  charts.clear();
  chartFlights.clear();
  symbolIndex = { at: 0, list: [] };
  state.clear();
}

export function setQuoteSource(patch = {}) {
  const { values, rejected } = checkQuoteSource(patch);
  const changed = JSON.stringify(values) !== JSON.stringify(SOURCE);
  SOURCE = cloneSource(values);
  // 配置没变就别清缓存：设置表每两秒刷一次，跟着一起清的话，
  // 快照缓存与「失败源冷却」永远活不过两秒，降级就等于没做
  if (changed) resetCaches();
  return { source: quoteSource(), rejected, changed };
}

export function resetQuoteSource() {
  SOURCE = cloneSource(QUOTE_SOURCE_DEFAULTS);
  resetCaches();
  return quoteSource();
}

const toMap = (rows) => {
  const map = new Map();
  for (const row of rows) if (row && !map.has(row.secid)) map.set(row.secid, row);
  return map;
};

// 一批一批分开容错：某一批挂掉只该少掉那一批，不该把整个市场带走
async function attempt(cap, args, nowMs) {
  try {
    return { status: 'fulfilled', ...(await withChain(cap, args, nowMs)) };
  } catch (error) {
    return { status: 'rejected', error };
  }
}

const failureText = (box) => {
  const list = box?.error?.sources ?? [];
  return list.length ? list.map((item) => `${item.label}:${item.error}`).join(' ') : String(box?.error?.message ?? 'failed');
};

// ---- 沪深快照：指数 + 个股榜 + ETF 补价 ----
async function fetchSnapshot(nowMs) {
  const [i, s, e] = await Promise.all([
    attempt('cnIndexes', [], nowMs),
    attempt('cnStocks', [SOURCE.cnPoolSize], nowMs),
    attempt('cnEtfs', [SOURCE.etfs.filter((secid) => CN_SECID_ONLY.test(secid))], nowMs),
  ]);
  const quotes = toMap([
    ...(i.status === 'fulfilled' ? i.value : []),
    ...(s.status === 'fulfilled' ? s.value : []),
    ...(e.status === 'fulfilled' ? e.value : []),
  ]);
  const hard = [i, s].filter((box) => box.status === 'rejected');
  if (quotes.size < 20) {
    const error = new Error((hard.length ? failureText(hard[0]) : 'cn_board_empty').slice(0, 40));
    error.sources = hard.flatMap((box) => box.error?.sources ?? []);
    throw error;
  }
  const etfFailed = e.status === 'rejected' ? SOURCE.etfs.length : Math.max(0, SOURCE.etfs.length - e.value.length);
  const note = hard.length ? `指数/个股批次失败 ${hard.length} 组`
    : etfFailed ? `ETF 补取失败 ${etfFailed}/${SOURCE.etfs.length} 条` : '';
  const main = s.status === 'fulfilled' ? s : i;
  return { quotes, note, provider: main.provider ?? '', fellBack: Boolean(main.fellBack) };
}

// ---- 美股快照：个股榜 + 指数 ----
async function fetchUsSnapshot(nowMs) {
  const [s, i] = await Promise.all([
    attempt('usStocks', [SOURCE.usPoolSize, [...demand]], nowMs),
    attempt('usIndexes', [], nowMs),
  ]);
  const quotes = toMap([...(i.status === 'fulfilled' ? i.value : []), ...(s.status === 'fulfilled' ? s.value : [])]);
  if (quotes.size < 20) {
    const error = new Error(failureText(s.status === 'rejected' ? s : i).slice(0, 40) || 'us_board_empty');
    error.sources = [...(s.error?.sources ?? []), ...(i.error?.sources ?? [])];
    throw error;
  }
  const missing = US_INDEXES.filter(([secid]) => !quotes.has(secid)).map(([secid]) => secid);
  const note = i.status === 'rejected' ? '指数批次失败（板块池正常）'
    : missing.length ? `指数缺 ${missing.length}/${US_INDEXES.length} 条` : '';
  const main = s.status === 'fulfilled' ? s : i;
  return { quotes, note, provider: main.provider ?? '', fellBack: Boolean(main.fellBack) };
}

export async function getQuotes(force = false, now = new Date()) {
  const parts = bjParts(now);
  if (!force && snapshot.data && now.getTime() - snapshot.at < SOURCE.cnTtlMs && snapshot.day === parts.day) {
    noteCache('pool_cn', 'hit');
    return snapshot.data;
  }
  noteCache('pool_cn', 'miss');
  try {
    const built = await fetchSnapshot(now.getTime());
    lastError = null;
    snapshot = { at: now.getTime(), day: parts.day, data: built.quotes, note: built.note, provider: built.provider, fellBack: built.fellBack };
    if (extraCache.size > 400) extraCache = new Map();
    return built.quotes;
  } catch (error) {
    lastError = String(error?.message ?? error).slice(0, 60);
    if (snapshot.data) return snapshot.data; // 全部上游异常时回退到上一次快照
    throw error;
  }
}

export async function getUsQuotes(force = false, now = new Date()) {
  const day = etParts(now).day;
  if (!force && usSnapshot.data && now.getTime() - usSnapshot.at < SOURCE.usTtlMs && usSnapshot.day === day) {
    noteCache('pool_us', 'hit');
    return usSnapshot.data;
  }
  noteCache('pool_us', 'miss');
  try {
    const built = await fetchUsSnapshot(now.getTime());
    usLastError = null;
    usSnapshot = { at: now.getTime(), day, data: built.quotes, note: built.note, provider: built.provider, fellBack: built.fellBack };
    return built.quotes;
  } catch (error) {
    usLastError = String(error?.message ?? error).slice(0, 60);
    if (usSnapshot.data) return usSnapshot.data;
    throw error;
  }
}

export const quotesFor = (market, force = false, now = new Date()) =>
  (market === 'us' ? getUsQuotes(force, now) : getQuotes(force, now));

// 状态里带上「现在用的是谁」，顶栏与后台概览共用这一份事实，不再各自猜
export function quoteStatus(market = 'cn') {
  const box = market === 'us' ? usSnapshot : snapshot;
  const error = market === 'us' ? usLastError : lastError;
  return {
    ok: !error,
    note: error,
    partial: box.note || undefined,
    source: box.provider ? QUOTE_PROVIDERS[box.provider]?.label ?? box.provider : null,
    sourceKey: box.provider || null,
    fellBack: Boolean(box.fellBack),
  };
}
export const quoteStatusFor = (market) => quoteStatus(market === 'us' ? 'us' : 'cn');

// ---- 汇率：美元池折人民币只用于「合计」展示与日结快照合并，绝不参与记账 ----
// 取不到就用上一个可用值，离线兜底给一个常量，避免整条同步因为汇率失败而停摆。
export async function getFx(now = new Date()) {
  const at = now.getTime();
  if (at - fxCache.at < Math.min(SOURCE.fxTtlMs, 60_000)) {
    noteCache('fx', 'hit');
    return fxCache.rate;
  }
  noteCache('fx', 'miss');
  try {
    const out = await withChain('fx', [], at);
    const rate = out.value?.rate ?? null;
    // 6.67 这类报价按微单位是 6.67e6；越界说明上游换了口径，宁可沿用旧值
    if (rate !== null && rate > MICRO && rate < 100 * MICRO) {
      fxCache = { at, rate, provider: out.provider, label: out.value?.label ?? '' };
    }
  } catch {
    fxCache = { ...fxCache, at };
  }
  return fxCache.rate;
}

export const fxSource = () => ({
  provider: fxCache.provider || null,
  label: fxCache.label || null,
  fallback: fxCache.rate === FX_FALLBACK,
});

export function quoteHealth(market = 'cn', now = new Date()) {
  const cn = market !== 'us';
  const box = cn ? snapshot : usSnapshot;
  const error = cn ? lastError : usLastError;
  const day = cn ? bjParts(now).day : etParts(now).day;
  let lastTs = 0;
  for (const quote of box.data?.values?.() ?? []) lastTs = Math.max(lastTs, quote.ts ?? 0);
  const ageMs = box.at ? Math.max(0, now.getTime() - box.at) : null;
  const dataAgeMinutes = lastTs ? Math.max(0, Math.round((now.getTime() / 1000 - lastTs) / 60)) : null;
  return {
    market,
    ok: !error,
    note: error,
    partial: box.note || '',
    rows: box.data?.size ?? 0,
    cachedAt: box.at ? new Date(box.at).toISOString() : null,
    ageMs,
    ttlMs: cn ? SOURCE.cnTtlMs : SOURCE.usTtlMs,
    day: box.day,
    today: day,
    fresh: Boolean(box.data) && box.day === day,
    dataTs: lastTs || null,
    dataAgeMinutes,
    staleWarn: dataAgeMinutes !== null && dataAgeMinutes > SOURCE.staleWarnMinutes,
    source: box.provider || null,
    sourceLabel: box.provider ? QUOTE_PROVIDERS[box.provider]?.label ?? box.provider : null,
    fellBack: Boolean(box.fellBack),
    host: box.provider ? QUOTE_PROVIDERS[box.provider].hosts[0] : SOURCE.listHost,
  };
}

// ---- 后台「行情源检测」：逐源逐能力实测，打的就是线上用的那条代码路径 ----
export const CAP_LABELS = {
  cnStocks: '沪深个股池', cnIndexes: '沪深指数', cnEtfs: '指数 ETF 补价', usStocks: '美股池', usIndexes: '美股指数',
  one: '单标的快照', fx: '汇率', trends: '当日分时', kline: '日 K / 周 K', suggest: '代码检索',
};
const CAP_NOTES = {
  cnStocks: 'A 股列表与撮合的主要来源',
  cnIndexes: '顶部指数条',
  cnEtfs: '不在榜上的 ETF 靠它进列表',
  usStocks: '美股列表与撮合的主要来源（只有东财有榜，降级后按持仓与自选补价）',
  usIndexes: '道琼斯、标普500、纳斯达克、纳斯达克100',
  one: '持仓与搜索命中的池外标的靠它补价',
  fx: '美元池折人民币的合并口径；取不到会退回兜底值',
  trends: '分时图',
  kline: '蜡烛图与 MACD（日 K / 周 K）',
  suggest: '输入代码或拼音首字母时的联想',
};

export const QUOTE_PROBES = PROVIDER_KEYS.flatMap((key) => Object.entries(QUOTE_PROVIDERS[key].caps)
  .filter(([, on]) => on)
  .map(([cap]) => ({
    key: `${key}:${cap}`,
    provider: key,
    providerLabel: QUOTE_PROVIDERS[key].label,
    cap,
    label: CAP_LABELS[cap],
    note: CAP_NOTES[cap],
  })));

const probeSample = (cap, value) => {
  if (cap === 'fx') return { rows: 1, sample: `${((value?.rate ?? 0) / MICRO).toFixed(4)} ${value?.label ?? ''}`.trim(), ts: null };
  if (cap === 'trends') return { rows: value?.points?.length ?? 0, sample: `${value?.name ?? ''} ${(value?.preClose ?? 0) / MICRO}`, ts: null };
  if (cap === 'kline') return { rows: value?.length ?? 0, sample: String(value?.at(-1)?.day ?? ''), ts: null };
  if (cap === 'suggest') return { rows: value?.length ?? 0, sample: `${value?.[0]?.name ?? ''} ${value?.[0]?.secid ?? ''}`.trim(), ts: null };
  if (cap === 'one') return { rows: value ? 1 : 0, sample: `${value?.name ?? ''} ${(value?.last ?? 0) / MICRO}`, ts: value?.ts ?? null };
  const list = Array.isArray(value) ? value : [];
  const first = list[0];
  return { rows: list.length, sample: first ? `${first.name} ${(first.last / MICRO).toFixed(2)}` : '', ts: first?.ts ?? null };
};

const probeArgs = (cap) => {
  if (cap === 'cnStocks') return [Math.min(20, SOURCE.cnPoolSize)];
  if (cap === 'usStocks') return [Math.min(20, SOURCE.usPoolSize), [...demand].slice(0, 20)];
  if (cap === 'cnEtfs') return [SOURCE.etfs.slice(0, 4)];
  if (cap === 'one') return ['1.600519'];
  if (cap === 'trends') return ['1.600519'];
  if (cap === 'kline') return ['1.600519', 5];
  if (cap === 'suggest') return ['600519', 'cn'];
  return [];
};

export async function probeQuoteSource(key, now = new Date()) {
  const meta = QUOTE_PROBES.find((item) => item.key === key);
  if (!meta) return { key, ok: false, ms: 0, error: '未知探测项' };
  const provider = QUOTE_PROVIDERS[meta.provider];
  const started = Date.now();
  try {
    const value = await provider[meta.cap](SOURCE, ...probeArgs(meta.cap));
    const shape = probeSample(meta.cap, value);
    // 空返回按不可用算：链的降级规则也是这么判的，两边口径必须一致，否则检测页会说谎
    if (isEmptyResult(meta.cap, value)) {
      noteCall({ cap: meta.cap, provider: meta.provider, ok: false, ms: Date.now() - started, probe: true });
      markFail(meta.provider, '返回为空', now.getTime());
      return { ...meta, host: provider.hosts[0], ok: false, ms: Date.now() - started, rows: 0, error: '返回为空' };
    }
    noteCall({ cap: meta.cap, provider: meta.provider, ok: true, ms: Date.now() - started, probe: true });
    markOk(meta.provider, Date.now() - started, now.getTime());
    return { ...meta, host: provider.hosts[0], ok: true, ms: Date.now() - started, rows: shape.rows, sample: shape.sample, ts: shape.ts };
  } catch (error) {
    noteCall({ cap: meta.cap, provider: meta.provider, ok: false, ms: Date.now() - started, probe: true });
    const reason = String(error?.cause?.code ?? error?.message ?? error).slice(0, 60);
    markFail(meta.provider, reason, now.getTime());
    return { ...meta, host: provider.hosts[0], ok: false, ms: Date.now() - started, error: reason };
  }
}

// ---- 池外标的补价：持仓、自选、按代码直查 ----
const US_SYMBOL = /^(100|105|106|107)\./i;
export async function ensureQuote(secid, quotes, now = new Date()) {
  const known = quotes?.get?.(secid);
  if (known) return known;
  const us = US_SYMBOL.test(secid);
  if (!us && !/^[012]\.\d{6}$/.test(secid)) return null;
  rememberDemand([secid]);
  const hit = extraCache.get(secid);
  if (hit && now.getTime() - hit.at < (marketOf(secid) === 'us' ? SOURCE.usTtlMs : SOURCE.cnTtlMs)) {
    noteCache('extra', 'hit');
    return hit.quote;
  }
  noteCache('extra', 'miss');
  try {
    const out = await withChain('one', [secid], now.getTime());
    if (out.value) extraCache.set(secid, { at: now.getTime(), quote: out.value });
    return out.value ?? null;
  } catch {
    return null;
  }
}

// ---- 图表：分时 20 秒、日/周 K 5 分钟，同标的并发请求合并 ----
// 前端会预取悬停与相邻标的，没有这一层就会把上游打爆、把点击拖慢
const NEGATIVE_TTL = 5_000;

function cachedChart(layer, key, ttl, loader) {
  const hit = charts.get(key);
  if (hit && Date.now() - hit.at < (hit.data ? ttl : NEGATIVE_TTL)) {
    noteCache(layer, 'hit');
    return Promise.resolve(hit.data);
  }
  const flying = chartFlights.get(key);
  if (flying) {
    noteCache(layer, 'merged');
    return flying;
  }
  noteCache(layer, 'miss');
  const task = (async () => {
    try {
      const data = await loader();
      charts.set(key, { at: Date.now(), data });
      if (charts.size > 400) {
        for (const [stale] of [...charts.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, 200)) charts.delete(stale);
      }
      return data;
    } finally {
      chartFlights.delete(key);
    }
  })();
  chartFlights.set(key, task);
  return task;
}

export function trendsOf(secid, now = new Date()) {
  return cachedChart('trends', `trends:${secid}`, SOURCE.trendsTtlMs, async () => (await withChain('trends', [secid], now.getTime())).value);
}

export function klineOf(secid, count = 120, period = 'day', now = new Date()) {
  const span = period === 'week' ? 'week' : 'day';
  return cachedChart('kline', `kline:${secid}:${span}:${count}`, SOURCE.klineTtlMs,
    async () => (await withChain('kline', [secid, count, span], now.getTime())).value);
}

// ---- 检索：建议接口 + 本地代码索引兜底中文名 ----
const DENY_CLASSIFY = new Set(['Option', 'Futures', 'BkQuot', 'KRX', 'OTCFUND', 'UsStock', 'HKStock']);
const CN_SECID = /^[01]\.\d{6}$/;

// 全市场代码表：只用来兜底中文名检索。走源链而不是只打东财——东财挂着时也要能搜到「茅台」。
// 300 条是折中：够用（覆盖常见大盘股与指数成分），又不至于每轮去捞 4600 只。
const INDEX_RANK_SIZE = 300;

async function buildSymbolIndex(nowMs) {
  const rows = [];
  try {
    const stocks = await withChain('cnStocks', [INDEX_RANK_SIZE], nowMs);
    for (const quote of stocks.value) rows.push({ secid: quote.secid, code: quote.code, name: quote.name, kind: quote.kind });
  } catch { /* 索引缺失时仍可按代码/拼音检索 */ }
  try {
    const indexes = await withChain('cnIndexes', [], nowMs);
    for (const quote of indexes.value) rows.push({ secid: quote.secid, code: quote.code, name: quote.name, kind: 'index' });
  } catch { /* 同上 */ }
  for (const secid of INDEX_ETFS) rows.push({ secid, code: splitSecid(secid).code, name: '', kind: 'etf' });
  return rows;
}

export async function searchSymbols(query, quotes, now = new Date(), market = 'cn') {
  const needle = String(query ?? '').trim().slice(0, 24);
  if (!needle) return [];
  const found = new Map();
  const push = (item) => {
    if (!item?.secid) return;
    // 市场隔离：搜美股只给美股代码，搜 A 股仍旧屏蔽境外品种（与原行为一致）
    if (market === 'us') {
      if (!US_SYMBOL.test(item.secid)) return;
    } else if (!CN_SECID.test(item.secid) || (item.classify && DENY_CLASSIFY.has(item.classify))) return;
    if (!found.has(item.secid)) found.set(item.secid, item);
  };

  // 已加载的行情池先本地匹配：零成本，且不受上游限制
  for (const quote of quotes?.values?.() ?? []) {
    if (quote.name.includes(needle) || quote.code.toUpperCase().startsWith(needle.toUpperCase())) {
      push({ secid: quote.secid, code: quote.code, name: quote.name, kind: quote.kind });
    }
  }

  if (/^[0-9a-zA-Z]+$/.test(needle) || /[一-龥]/.test(needle)) {
    try {
      const out = await withChain('suggest', [needle, market], now.getTime());
      for (const row of out.value ?? []) push(row);
    } catch { /* 上游异常时退回本地索引 */ }
  }

  // 中文检索兜底：建议接口对中文名经常空返回
  if (market !== 'us' && (/[一-龥]/.test(needle) || found.size < 6)) {
    if (now.getTime() - symbolIndex.at > INDEX_TTL_MS) {
      const list = await buildSymbolIndex(now.getTime());
      // 空索引不缓存六小时：否则一次上游抖动就把中文检索锁死一整个上午，5 分钟后再试
      if (list.length) symbolIndex = { at: now.getTime(), list };
      else symbolIndex = { at: now.getTime() - INDEX_TTL_MS + INDEX_RETRY_MS, list: symbolIndex.list };
    }
    for (const item of symbolIndex.list) {
      if (found.size >= 20) break;
      if (item.name.includes(needle) || item.code.startsWith(needle)) push({ ...item });
    }
  }

  return [...found.values()].slice(0, 20).map((item) => {
    const live = quotes?.get?.(item.secid);
    return {
      ...item,
      name: live?.name ?? item.name,
      last: live?.last ?? null,
      pct: live?.pct ?? null,
      tradable: item.kind === 'stock' || item.kind === 'etf',
    };
  });
}
