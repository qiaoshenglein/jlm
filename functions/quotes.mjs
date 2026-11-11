// 行情源：东方财富公开行情接口（UTF-8 JSON，无需密钥）。
// 每个执行环境内做快照缓存（默认 2.5 秒），所有请求共享，避免高频打爆上游。
import { FX_SECID, MICRO, bjParts, etParts, marketOf, secidOf, splitSecid, tradableOf, limitPricesOf, tickOf } from './rules.mjs';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36';

// 主要指数：一次板块请求即可全部拿到，这里只规定展示顺序与重点标记
export const KEY_INDEXES = [
  ['1.000001', '上证指数'], ['0.399001', '深证成指'], ['0.399006', '创业板指'],
  ['1.000300', '沪深300'], ['1.000016', '上证50'], ['1.000905', '中证500'],
  ['1.000852', '中证1000'], ['1.000688', '科创50'], ['0.899050', '北证50'],
  ['1.000985', '中证全指'],
];

// 场内指数 ETF：逐个标的取价（行情源批量接口不对外开放）
export const INDEX_ETFS = ['1.510300', '1.510050', '1.510500', '1.588000', '0.159915', '0.159919', '1.512100', '0.159901'];

// ---- 可热改的行情源配置 ----
// 域名只给实测可用的白名单，不提供「任意填一个 URL」：
// 一是本运行时按 UTF-8 解 JSON，换成 GBK 源（腾讯/新浪）会整片乱码；
// 二是后台能填任意主机，等于给服务端开一个内网探测口（SSRF）。
export const QUOTE_HOSTS = ['push2.eastmoney.com', 'push2delay.eastmoney.com', 'push2his.eastmoney.com', 'searchapi.eastmoney.com'];

export const QUOTE_SOURCE_DEFAULTS = {
  listHost: 'push2.eastmoney.com',      // 板块批量（沪深 + 美股）
  singleHost: 'push2.eastmoney.com',    // 单标的快照
  histHost: 'push2his.eastmoney.com',   // 分时与日 K
  searchHost: 'searchapi.eastmoney.com',// 代码检索
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
  staleWarnMinutes: [10, 1_440],
};
const HOST_KEYS = ['listHost', 'singleHost', 'histHost', 'searchHost'];
const ETFS_MAX = 20;
const CN_SECID_ONLY = /^[012]\.\d{6}$/;

let SOURCE = { ...QUOTE_SOURCE_DEFAULTS, etfs: [...QUOTE_SOURCE_DEFAULTS.etfs] };

export function quoteSource() {
  return { ...SOURCE, etfs: [...SOURCE.etfs] };
}

export const sourceHostOk = (host) => QUOTE_HOSTS.includes(String(host));

// 校验并合并；返回 {values, rejected} 让调用方能把「哪些项被拒」如实说出去
export function checkQuoteSource(patch = {}) {
  const values = { ...SOURCE, etfs: [...SOURCE.etfs] };
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
  if (patch.etfs !== undefined) {
    const list = Array.isArray(patch.etfs) ? patch.etfs : String(patch.etfs).split(',');
    const clean = [...new Set(list.map((item) => String(item ?? '').trim()).filter((item) => CN_SECID_ONLY.test(item)))];
    if (!clean.length && list.filter(Boolean).length) rejected.push('etfs：没有合法的 secid（形如 1.510300）');
    else if (clean.length > ETFS_MAX) rejected.push(`etfs：最多 ${ETFS_MAX} 条`);
    else values.etfs = clean;
  }
  for (const key of Object.keys(patch)) {
    if (HOST_KEYS.includes(key) || SOURCE_LIMITS[key] || key === 'etfs') continue;
    rejected.push(`${key}：不是可配置项`);
  }
  return { values, rejected };
}

// 换源或换 TTL 之后必须清缓存，否则「检测」打到的还是旧快照，结论是假的
function resetCaches() {
  snapshot = { at: 0, day: '', data: null };
  usSnapshot = { at: 0, day: '', data: null };
  fxCache = { at: 0, rate: FX_FALLBACK };
  extraCache = new Map();
  charts.clear();
  chartFlights.clear();
  symbolIndex = { at: 0, list: [] };
}

export function setQuoteSource(patch = {}) {
  const { values, rejected } = checkQuoteSource(patch);
  SOURCE = values;
  resetCaches();
  return { source: quoteSource(), rejected };
}

export function resetQuoteSource() {
  SOURCE = { ...QUOTE_SOURCE_DEFAULTS, etfs: [...QUOTE_SOURCE_DEFAULTS.etfs] };
  resetCaches();
  return quoteSource();
}

const clist = (fs, pz, fid, fields) => `https://${SOURCE.listHost}/api/qt/clist/get?pn=1&pz=${pz}&po=1&np=1&fltt=2&invt=2&fid=${fid}&fs=${fs}&fields=${fields}`;
const singleUrl = (secid, fields) => `https://${SOURCE.singleHost}/api/qt/stock/get?secid=${secid}&fltt=2&invt=2&fields=${fields}`;
const KLINE_BASE = () => `https://${SOURCE.histHost}/api/qt/stock/kline/get`;
const TRENDS_BASE = () => `https://${SOURCE.histHost}/api/qt/stock/trends2/get`;
const SUGGEST_BASE = () => `https://${SOURCE.searchHost}/api/suggest/get`;

const LIST_FIELDS = 'f2,f3,f4,f5,f6,f7,f8,f12,f13,f14,f15,f16,f17,f18,f20,f124';
const ONE_FIELDS = 'f43,f44,f45,f46,f47,f48,f57,f58,f60,f86,f168,f169,f170,f171';

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const micro = (v) => (v === null ? null : Math.round(v * MICRO));

async function getJson(url, ms = SOURCE.timeoutMs) {
  const response = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'application/json' },
    signal: AbortSignal.timeout(ms),
  });
  if (!response.ok) throw new Error(`upstream_${response.status}`);
  const body = await response.json();
  if (!body || typeof body !== 'object') throw new Error('upstream_shape');
  return body;
}

function listOf(row, kind) {
  const market = String(row.f13);
  const code = String(row.f12);
  const prevClose = micro(row.f18);
  const last = micro(row.f2);
  const name = String(row.f14 ?? '');
  const secid = secidOf(market, code);
  return shape(secid, code, name, kind, last, prevClose, micro(row.f17), micro(row.f15), micro(row.f16),
    num(row.f3), row.f5, row.f6, row.f8, row.f20, row.f124);
}

function shape(secid, code, name, kind, last, prevClose, open, high, low, pct, volume, amount,
  turnover, marketCap, ts) {
  if (!tradableOf(kind) && kind !== 'index') return null;
  if (last === null || prevClose === null || prevClose <= 0) return null;
  const limits = limitPricesOf(prevClose, secid, name, kind);
  return {
    secid, code, name, kind,
    last, prevClose, open, high, low,
    change: last - prevClose,
    pct: pct ?? (prevClose ? ((last - prevClose) / prevClose) * 100 : 0),
    volume: num(volume) ?? 0,           // 手
    amount: Math.round(num(amount) ?? 0), // 元
    turnover: num(turnover),
    marketCap: num(marketCap),
    limitUp: limits.up,
    limitDown: limits.down,
    limitRatio: limits.ratio,
    tick: tickOf(kind, marketOf(secid)),
    ts: num(ts) ?? 0,
    // 美股没有每日涨跌停，limits 为 null 时不能参与比较（null 会被强转成 0 而误判涨停）
    sealedUp: limits.up !== null && last >= limits.up,
    sealedDown: limits.down !== null && last <= limits.down,
  };
}

let snapshot = { at: 0, day: '', data: null, note: '' };
let extraCache = new Map();
let lastError = null;

// 三个批次分开容错：单标的接口抖动只会少掉 ETF，不该把整个 A 股池一起带走
async function fetchSnapshot() {
  const indices = getJson(clist('b:MK0010', SOURCE.indexPoolSize, 'f3', LIST_FIELDS))
    .then((body) => (body.data?.diff ?? []).map((r) => listOf(r, 'index')).filter(Boolean));
  const stocks = getJson(clist('m:1+t:2,m:1+t:23,m:0+t:6,m:0+t:80', SOURCE.cnPoolSize, 'f6', LIST_FIELDS))
    .then((body) => (body.data?.diff ?? []).map((r) => listOf(r, 'stock')).filter(Boolean));
  const etfs = Promise.allSettled(SOURCE.etfs.filter((s) => CN_SECID_ONLY.test(s)).map(async (secid) => {
    const body = await getJson(singleUrl(secid, ONE_FIELDS));
    const d = body.data;
    if (!d) return null;
    const { code } = splitSecid(secid);
    return shape(secid, String(d.f57 ?? code), String(d.f58 ?? ''), 'etf', micro(d.f43), micro(d.f60),
      micro(d.f46), micro(d.f44), micro(d.f45), num(d.f170), d.f47, d.f48, d.f168, null, d.f86);
  }));
  const [i, s, e] = await Promise.allSettled([indices, stocks, etfs]);
  const list = [
    ...(i.status === 'fulfilled' ? i.value : []),
    ...(s.status === 'fulfilled' ? s.value : []),
    ...(e.status === 'fulfilled' ? e.value.filter(Boolean) : []),
  ];
  const quotes = new Map();
  for (const q of list) if (q) quotes.set(q.secid, q);
  const hard = [i, s].filter((item) => item.status === 'rejected');
  if (quotes.size < 20) {
    throw new Error(String(hard[0]?.reason?.message ?? 'cn_board_empty').slice(0, 40));
  }
  const etfFailed = e.status === 'rejected'
    ? SOURCE.etfs.length
    : (e.value ?? []).filter((item) => item.status === 'rejected').length;
  const note = hard.length ? `指数/个股批次失败 ${hard.length} 组`
    : etfFailed ? `ETF 补取失败 ${etfFailed}/${SOURCE.etfs.length} 条` : '';
  return { quotes, note };
}

export async function getQuotes(force = false, now = new Date()) {
  const parts = bjParts(now);
  if (!force && snapshot.data && now.getTime() - snapshot.at < SOURCE.cnTtlMs && snapshot.day === parts.day) {
    return snapshot.data;
  }
  try {
    const { quotes, note } = await fetchSnapshot();
    lastError = null;
    snapshot = { at: now.getTime(), day: parts.day, data: quotes, note };
    if (extraCache.size > 400) extraCache = new Map();
    return quotes;
  } catch (error) {
    lastError = String(error?.message ?? error).slice(0, 60);
    if (snapshot.data) return snapshot.data; // 上游抖动时回退到上一次快照
    throw error;
  }
}

export function quoteStatus() {
  return { ok: !lastError, note: lastError, partial: snapshot.note || undefined };
}

// ---- 美股行情：一次板块请求（三大交易所按成交额取前 N）+ 一次指数请求 ----
export const US_INDEXES = [['100.DJIA', '道琼斯'], ['100.SPX', '标普500'], ['100.NDX', '纳斯达克'], ['100.NDX100', '纳斯达克100']];
const US_BOARDS = 'm:105,m:106,m:107';

let usSnapshot = { at: 0, day: '', data: null, note: '' };
let usLastError = null;

// 指数走板块接口的 i: 列表（一次请求拿四条）。
// 实测单标的接口 stock/get 对美股指数并不总是给数据，板块接口更稳，也少三次连接。
async function fetchUsSnapshot() {
  const board = getJson(clist(US_BOARDS, SOURCE.usPoolSize, 'f6', LIST_FIELDS))
    .then((body) => (body.data?.diff ?? [])
      .map((row) => listOf(row, usKindFor(`${row.f13}.${row.f12}`, row.f14)))
      .filter(Boolean));
  const indexes = getJson(clist(US_INDEXES.map(([secid]) => `i:${secid}`).join(','), US_INDEXES.length, 'f3', LIST_FIELDS))
    .then((body) => (body.data?.diff ?? [])
      .map((row) => listOf(row, usKindFor(`${row.f13}.${row.f12}`, row.f14)))
      .filter(Boolean));
  const [rows, idx] = await Promise.allSettled([board, indexes]);
  const quotes = new Map();
  for (const quote of [...(idx.status === 'fulfilled' ? idx.value : []), ...(rows.status === 'fulfilled' ? rows.value : [])]) {
    if (quote && !quotes.has(quote.secid)) quotes.set(quote.secid, quote);
  }
  if (quotes.size < 20) throw new Error(String(rows.reason?.message ?? idx.reason?.message ?? 'us_board_empty').slice(0, 40));
  const missing = US_INDEXES.filter(([secid]) => !quotes.has(secid)).map(([secid]) => secid);
  return { quotes, note: idx.status === 'rejected' ? '指数批次失败（板块池正常）'
    : missing.length ? `指数缺 ${missing.length}/${US_INDEXES.length} 条` : '' };
}

export async function getUsQuotes(force = false, now = new Date()) {
  const day = etParts(now).day;
  if (!force && usSnapshot.data && now.getTime() - usSnapshot.at < SOURCE.usTtlMs && usSnapshot.day === day) return usSnapshot.data;
  try {
    const { quotes, note } = await fetchUsSnapshot();
    usLastError = null;
    usSnapshot = { at: now.getTime(), day, data: quotes, note };
    return quotes;
  } catch (error) {
    usLastError = String(error?.message ?? error).slice(0, 60);
    if (usSnapshot.data) return usSnapshot.data;
    throw error;
  }
}

// 一次取某个市场的快照，接口层只认这一个入口
export const quotesFor = (market, force = false, now = new Date()) =>
  (market === 'us' ? getUsQuotes(force, now) : getQuotes(force, now));
export const quoteStatusFor = (market) => (market === 'us'
  ? { ok: !usLastError, note: usLastError, partial: usSnapshot.note || undefined }
  : quoteStatus());

// ---- 汇率：美元池折人民币只用于「合计」展示与日结快照合并，绝不参与记账 ----
// 取不到就用上一个可用值，离线兜底给一个常量，避免整条同步因为汇率失败而停摆。
const FX_FALLBACK = Math.round(6.7 * MICRO);
let fxCache = { at: 0, rate: FX_FALLBACK };

export async function getFx(now = new Date()) {
  const at = now.getTime();
  if (at - fxCache.at < SOURCE.fxTtlMs) return fxCache.rate;
  try {
    const body = await getJson(singleUrl(FX_SECID, ONE_FIELDS), Math.min(SOURCE.timeoutMs, 3_000));
    const last = micro(body.data?.f43 ?? null);
    // 6.67 这类报价按微单位是 6.67e6；越界说明上游换了口径，宁可沿用旧值
    fxCache = { at, rate: last !== null && last > MICRO && last < 100 * MICRO ? last : fxCache.rate };
  } catch {
    fxCache = { at, rate: fxCache.rate };
  }
  return fxCache.rate;
}

// 行情健康度：后台检测页与顶栏降级提示共用这一份事实，不再各自猜
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
    host: cn ? SOURCE.listHost : SOURCE.listHost,
  };
}

// ---- 后台「行情源检测」：逐个端点实测，结果直接给结论而不是让人猜 ----
// URL 构造只在这里出现一份，检测打的和线上撮合用的是同一条路径，结论才有意义。
export const QUOTE_PROBES = [
  { key: 'cn_board', label: '沪深板块池', host: () => SOURCE.listHost, note: '按成交额取前 N 只个股，是 A 股撮合与列表的数据来源' },
  { key: 'us_board', label: '美股板块池', host: () => SOURCE.listHost, note: '纳斯达克/纽交所/AMEX 按成交额取前 N 只' },
  { key: 'us_index', label: '美股指数', host: () => SOURCE.listHost, note: '道琼斯、标普500、纳斯达克、纳斯达克100' },
  { key: 'single', label: '单标的快照', host: () => SOURCE.singleHost, note: '持仓与搜索命中的池外标的靠它补价' },
  { key: 'trends', label: '当日分时', host: () => SOURCE.histHost, note: '分时图与「行情是否新鲜」判定' },
  { key: 'kline', label: '日 K 线', host: () => SOURCE.histHost, note: '蜡烛图与均线' },
  { key: 'suggest', label: '代码检索', host: () => SOURCE.searchHost, note: '输入代码或拼音首字母时的联想' },
  { key: 'fx', label: '汇率 USDCNH', host: () => SOURCE.singleHost, note: '美元池折人民币的合并口径；取不到会退回兜底值' },
];

const probeShape = (key, body) => {
  const d = body?.data;
  if (Array.isArray(d?.diff)) {
    const first = d.diff[0];
    return { rows: d.diff.length, sample: first ? `${first.f14 ?? ''} ${first.f2 ?? first.f43 ?? ''}` : '', ts: first?.f124 ?? null };
  }
  if (Array.isArray(d?.klines)) return { rows: d.klines.length, sample: d.klines.at(-1)?.slice(0, 19) ?? '', ts: null };
  if (Array.isArray(d?.trends)) return { rows: d.trends.length, sample: d.trends.at(-1)?.slice(0, 21) ?? '', ts: null };
  // 检索接口的结果不在 data 里，是顶层 QuotationCodeTable
  const table = body?.QuotationCodeTable?.Data ?? d?.QuotationCodeTable?.Data;
  if (Array.isArray(table)) return { rows: table.length, sample: table[0]?.QuoteID ?? '', ts: null };
  if (d && typeof d === 'object') return { rows: 1, sample: `${d.f58 ?? d.name ?? ''} ${d.f43 ?? ''}`, ts: d.f86 ?? null };
  return { rows: 0, sample: '', ts: null };
};

export async function probeQuoteSource(key, now = new Date()) {
  const meta = QUOTE_PROBES.find((item) => item.key === key);
  const started = now.getTime();
  const url = {
    cn_board: () => clist('m:1+t:2,m:1+t:23,m:0+t:6,m:0+t:80', Math.min(20, SOURCE.cnPoolSize), 'f6', LIST_FIELDS),
    us_board: () => clist(US_BOARDS, Math.min(20, SOURCE.usPoolSize), 'f6', LIST_FIELDS),
    us_index: () => clist(US_INDEXES.map(([secid]) => `i:${secid}`).join(','), US_INDEXES.length, 'f3', LIST_FIELDS),
    single: () => singleUrl('1.600519', ONE_FIELDS),
    trends: () => `${TRENDS_BASE()}?secid=1.600519&fields1=f1,f2,f3,f4,f5,f6,f7,f8&fields2=f51,f53,f56,f58&iscr=0&ndays=1`,
    kline: () => `${KLINE_BASE()}?secid=1.600519&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56&klt=101&fqt=1&lmt=3&end=20500101`,
    suggest: () => `${SUGGEST_BASE()}?input=${encodeURIComponent('600519')}&type=14&count=3`,
    fx: () => singleUrl(FX_SECID, ONE_FIELDS),
  }[key];
  if (!meta || !url) return { key, ok: false, ms: 0, error: '未知探测项' };
  try {
    const body = await getJson(url(), Math.max(SOURCE.timeoutMs, 5_000));
    const shape = probeShape(key, body);
    return {
      key, label: meta.label, host: meta.host(), ok: true,
      ms: Date.now() - started, rows: shape.rows, sample: shape.sample, ts: shape.ts,
    };
  } catch (error) {
    return {
      key, label: meta.label, host: meta.host(), ok: false,
      ms: Date.now() - started, error: String(error?.cause?.code ?? error?.message ?? error).slice(0, 60),
    };
  }
}

// 搜索建议接口：代码与拼音首字母命中率高，中文名经常返回空，因此再配一份本地标的索引
const DENY_CLASSIFY = new Set(['Option', 'Futures', 'BkQuot', 'KRX', 'OTCFUND', 'UsStock', 'HKStock']);
const INDEX_TTL_MS = 6 * 3600_000;
let symbolIndex = { at: 0, list: [] };

// 全市场代码表：总市值前 1000 名 + 重要指数 + 指数 ETF，够覆盖常见中文检索
async function buildSymbolIndex() {
  const rows = [];
  const pages = [
    [clist('m:1+t:2,m:1+t:23,m:0+t:6,m:0+t:80', 1_000, 'f20', 'f12,f13,f14'), 'stock'],
    [clist('b:MK0010', SOURCE.indexPoolSize, 'f3', 'f12,f13,f14'), 'index'],
  ];
  for (const [url, kind] of pages) {
    try {
      const body = await getJson(url, Math.max(SOURCE.timeoutMs, 6_000));
      for (const row of body.data?.diff ?? []) {
        rows.push({ secid: secidOf(String(row.f13), String(row.f12)), code: String(row.f12), name: String(row.f14 ?? ''), kind });
      }
    } catch { /* 索引缺失时仍可按代码/拼音检索 */ }
  }
  for (const secid of INDEX_ETFS) {
    const { code } = splitSecid(secid);
    rows.push({ secid, code, name: code, kind: 'etf' });
  }
  return rows;
}

const CN_SECID = /^[01]\.\d{6}$/;
const US_SECID = /^(100|105|106|107)\./i;

// 美股没有可靠的 classify 细分返回，用名称判定 ETF：东财的美股 ETF 名字一律带 ETF/做多/做空/杠杆。
// 市场号 100 是全球指数，一律按不可交易的 index 处理。
const usKindOf = (name) => (/ETF|杠杆|做多|做空|指(数)?基/i.test(String(name ?? '')) ? 'etf' : 'stock');
const usKindFor = (secid, name) => (String(secid).startsWith('100.') ? 'index' : usKindOf(name));

export async function searchSymbols(query, quotes, now = new Date(), market = 'cn') {
  const needle = String(query ?? '').trim().slice(0, 24);
  if (!needle) return [];
  const found = new Map();
  const push = (item) => {
    if (!item?.secid) return;
    // 市场隔离：搜美股只给美股代码，搜 A 股仍旧屏蔽境外品种（与原行为一致）
    if (market === 'us') {
      if (!US_SECID.test(item.secid)) return;
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
      const body = await getJson(`${SUGGEST_BASE()}?input=${encodeURIComponent(needle)}&type=14&count=20`, SOURCE.timeoutMs);
      for (const row of body.QuotationCodeTable?.Data ?? []) {
        const secid = String(row.QuoteID ?? '');
        const classify = String(row.Classify ?? '');
        push({
          secid, code: String(row.Code ?? ''), name: String(row.Name ?? ''),
          kind: market === 'us' ? usKindFor(secid, row.Name)
            : (classify === 'Index' ? 'index' : classify === 'Fund' ? 'etf' : 'stock'),
          classify, marketLabel: String(row.SecurityTypeName ?? ''),
        });
      }
    } catch { /* 上游异常时退回本地索引 */ }
  }

  // 中文检索兜底：A 股侧建议接口对中文名经常空返回，美股侧建议接口中文可用，不需要全表扫描
  if (market !== 'us' && (/[一-龥]/.test(needle) || found.size < 6)) {
    if (now.getTime() - symbolIndex.at > INDEX_TTL_MS) {
      symbolIndex = { at: now.getTime(), list: await buildSymbolIndex() };
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

// 持仓/下单涉及板块外的标的时，按需补取单标的行情。
// 注意：美股的单标的接口 stock/get 只覆盖部分代码，实测 clist 的 i:市场.代码 更稳，所以美股走板块接口取一条。
const US_SYMBOL = /^(100|105|106|107)\.[A-Za-z][A-Za-z0-9.\-]{0,9}$/;
export async function ensureQuote(secid, quotes, now = new Date()) {
  const known = quotes.get(secid);
  if (known) return known;
  const us = US_SYMBOL.test(secid);
  if (!us && !/^[012]\.\d{6}$/.test(secid)) return null;
  const hit = extraCache.get(secid);
  if (hit && now.getTime() - hit.at < (marketOf(secid) === 'us' ? SOURCE.usTtlMs : SOURCE.cnTtlMs)) return hit.quote;
  try {
    if (us) {
      const body = await getJson(clist(`i:${secid}`, 3, 'f3', LIST_FIELDS));
      const row = (body.data?.diff ?? []).find((item) => `${item.f13}.${item.f12}` === secid);
      if (!row) return null;
      const quote = listOf(row, usKindFor(secid, row.f14));
      if (quote) extraCache.set(secid, { at: now.getTime(), quote });
      return quote;
    }
    const body = await getJson(singleUrl(secid, ONE_FIELDS));
    const d = body.data;
    if (!d) return null;
    const { market, code } = splitSecid(secid);
    const kind = (market === '1' && code[0] === '5') || (market === '0' && code[0] === '1') ? 'etf' : 'stock';
    const quote = shape(secid, String(d.f57 ?? code), String(d.f58 ?? ''), kind, micro(d.f43), micro(d.f60),
      micro(d.f46), micro(d.f44), micro(d.f45), num(d.f170), d.f47, d.f48, d.f168, null, d.f86);
    if (quote) extraCache.set(secid, { at: now.getTime(), quote });
    return quote;
  } catch {
    return null;
  }
}

// 图表缓存：分时 20 秒、日 K 5 分钟，同标的并发请求合并。
// 前端会预取悬停与相邻标的，没有这一层就会把上游打爆、把点击拖慢。
// TTL 走行情源配置，后台可以按上游稳定性调整
const NEGATIVE_TTL = 5_000;
const charts = new Map();
const chartFlights = new Map();

function cachedChart(key, ttl, loader) {
  const hit = charts.get(key);
  if (hit && Date.now() - hit.at < (hit.data ? ttl : NEGATIVE_TTL)) return Promise.resolve(hit.data);
  const flying = chartFlights.get(key);
  if (flying) return flying;
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

// 当日分时：用于分时图与「行情是否新鲜」的判定
export function trendsOf(secid) {
  return cachedChart(`trends:${secid}`, SOURCE.trendsTtlMs, () => fetchTrends(secid));
}

async function fetchTrends(secid) {
  const url = `${TRENDS_BASE()}?secid=${secid}&fields1=f1,f2,f3,f4,f5,f6,f7,f8&fields2=f51,f53,f56,f58&iscr=0&ndays=1`;
  const body = await getJson(url, Math.max(SOURCE.timeoutMs, 5_000));
  const d = body.data;
  if (!d || !Array.isArray(d.trends)) return null;
  return {
    name: String(d.name ?? ''),
    preClose: micro(d.preClose),
    points: d.trends.map((line) => {
      const [time, price, volume, avg] = String(line).split(',');
      return { t: time.slice(11, 16), price: micro(Number(price)), volume: Number(volume) || 0, avg: micro(Number(avg)) };
    }).filter((p) => Number.isFinite(p.price)),
  };
}

// 日 K：用于蜡烛图与均线
export function klineOf(secid, count = 120) {
  return cachedChart(`kline:${secid}:${count}`, SOURCE.klineTtlMs, () => fetchKline(secid, count));
}

async function fetchKline(secid, count) {
  const url = `${KLINE_BASE()}?secid=${secid}&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56&klt=101&fqt=1&lmt=${count}&end=20500101`;
  const body = await getJson(url, Math.max(SOURCE.timeoutMs, 5_000));
  const d = body.data;
  if (!d || !Array.isArray(d.klines)) return null;
  return d.klines.map((line) => {
    const [day, open, close, high, low, volume] = String(line).split(',');
    return { day, open: micro(Number(open)), close: micro(Number(close)), high: micro(Number(high)), low: micro(Number(low)), volume: Number(volume) || 0 };
  });
}
