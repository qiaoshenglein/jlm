// 行情源：东方财富公开行情接口（UTF-8 JSON，无需密钥）。
// 每个执行环境内做 2.5 秒快照缓存，所有请求共享，避免高频打爆上游。
import { MICRO, bjParts, secidOf, splitSecid, tradableOf, limitPricesOf, tickOf } from './rules.mjs';

const TTL_MS = 2_500;
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

const BOARD_CLIST = 'https://push2.eastmoney.com/api/qt/clist/get';
const SINGLE_GET = 'https://push2.eastmoney.com/api/qt/stock/get';
const KLINE_URL = 'https://push2his.eastmoney.com/api/qt/stock/kline/get';
const TRENDS_URL = 'https://push2his.eastmoney.com/api/qt/stock/trends2/get';

const LIST_FIELDS = 'f2,f3,f4,f5,f6,f7,f8,f12,f13,f14,f15,f16,f17,f18,f20,f124';
const ONE_FIELDS = 'f43,f44,f45,f46,f47,f48,f57,f58,f60,f86,f168,f169,f170,f171';

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const micro = (v) => (v === null ? null : Math.round(v * MICRO));

async function getJson(url, ms = 4_000) {
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
    tick: tickOf(kind),
    ts: num(ts) ?? 0,
    sealedUp: last >= limits.up,
    sealedDown: last <= limits.down,
  };
}

let snapshot = { at: 0, day: '', data: null };
let extraCache = new Map();
let lastError = null;

async function fetchSnapshot() {
  const indices = getJson(`${BOARD_CLIST}?pn=1&pz=60&po=1&np=1&fltt=2&invt=2&fid=f3&fs=b:MK0010&fields=${LIST_FIELDS}`)
    .then((body) => (body.data?.diff ?? []).map((r) => listOf(r, 'index')).filter(Boolean));
  const stocks = getJson(`${BOARD_CLIST}?pn=1&pz=150&po=1&np=1&fltt=2&invt=2&fid=f6&fs=m:1+t:2,m:1+t:23,m:0+t:6,m:0+t:80&fields=${LIST_FIELDS}`)
    .then((body) => (body.data?.diff ?? []).map((r) => listOf(r, 'stock')).filter(Boolean));
  const etfs = Promise.all(INDEX_ETFS.filter((s) => /^\d\.\d{6}$/.test(s)).map(async (secid) => {
    const body = await getJson(`${SINGLE_GET}?secid=${secid}&fltt=2&invt=2&fields=${ONE_FIELDS}`);
    const d = body.data;
    if (!d) return null;
    const { code } = splitSecid(secid);
    return shape(secid, String(d.f57 ?? code), String(d.f58 ?? ''), 'etf', micro(d.f43), micro(d.f60),
      micro(d.f46), micro(d.f44), micro(d.f45), num(d.f170), d.f47, d.f48, d.f168, null, d.f86);
  }));
  const [i, s, e] = await Promise.all([indices, stocks, etfs]);
  const list = [...i, ...s, ...e.filter(Boolean)];
  const quotes = new Map();
  for (const q of list) if (q) quotes.set(q.secid, q);
  return quotes;
}

export async function getQuotes(force = false, now = new Date()) {
  const parts = bjParts(now);
  if (!force && snapshot.data && now.getTime() - snapshot.at < TTL_MS && snapshot.day === parts.day) {
    return snapshot.data;
  }
  try {
    const quotes = await fetchSnapshot();
    lastError = null;
    snapshot = { at: now.getTime(), day: parts.day, data: quotes };
    if (extraCache.size > 400) extraCache = new Map();
    return quotes;
  } catch (error) {
    lastError = String(error?.message ?? error).slice(0, 60);
    if (snapshot.data) return snapshot.data; // 上游抖动时回退到上一次快照
    throw error;
  }
}

export function quoteStatus() {
  return { ok: !lastError, note: lastError };
}

// 搜索建议接口：代码与拼音首字母命中率高，中文名经常返回空，因此再配一份本地标的索引
const SUGGEST_URL = 'https://searchapi.eastmoney.com/api/suggest/get';
const DENY_CLASSIFY = new Set(['Option', 'Futures', 'BkQuot', 'KRX', 'OTCFUND', 'UsStock', 'HKStock']);
const INDEX_TTL_MS = 6 * 3600_000;
let symbolIndex = { at: 0, list: [] };

// 全市场代码表：总市值前 1000 名 + 重要指数 + 指数 ETF，够覆盖常见中文检索
async function buildSymbolIndex() {
  const rows = [];
  const pages = [
    [`${BOARD_CLIST}?pn=1&pz=1000&po=1&np=1&fltt=2&invt=2&fid=f20&fs=m:1+t:2,m:1+t:23,m:0+t:6,m:0+t:80&fields=f12,f13,f14`, 'stock'],
    [`${BOARD_CLIST}?pn=1&pz=60&po=1&np=1&fltt=2&invt=2&fid=f3&fs=b:MK0010&fields=f12,f13,f14`, 'index'],
  ];
  for (const [url, kind] of pages) {
    try {
      const body = await getJson(url, 6_000);
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

export async function searchSymbols(query, quotes, now = new Date()) {
  const needle = String(query ?? '').trim().slice(0, 24);
  if (!needle) return [];
  const found = new Map();
  const push = (item) => {
    if (!item?.secid || !/^[01]\.\d{6}$/.test(item.secid)) return;
    if (item.classify && DENY_CLASSIFY.has(item.classify)) return;
    if (!found.has(item.secid)) found.set(item.secid, item);
  };

  // 已加载的行情池先本地匹配：零成本，且不受上游限制
  for (const quote of quotes?.values?.() ?? []) {
    if (quote.name.includes(needle) || quote.code.startsWith(needle)) {
      push({ secid: quote.secid, code: quote.code, name: quote.name, kind: quote.kind });
    }
  }

  if (/^[0-9a-zA-Z]+$/.test(needle)) {
    try {
      const body = await getJson(`${SUGGEST_URL}?input=${encodeURIComponent(needle)}&type=14&count=20`, 4_000);
      for (const row of body.QuotationCodeTable?.Data ?? []) {
        push({
          secid: String(row.QuoteID ?? ''), code: String(row.Code ?? ''), name: String(row.Name ?? ''),
          kind: row.Classify === 'Index' ? 'index' : row.Classify === 'Fund' ? 'etf' : 'stock',
          classify: String(row.Classify ?? ''), marketLabel: String(row.SecurityTypeName ?? ''),
        });
      }
    } catch { /* 上游异常时退回本地索引 */ }
  }

  // 中文检索兜底
  if (/[一-龥]/.test(needle) || found.size < 6) {
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

// 持仓/下单涉及板块外的标的时，按需补取单标的行情
export async function ensureQuote(secid, quotes, now = new Date()) {
  const known = quotes.get(secid);
  if (known) return known;
  if (!/^[012]\.\d{6}$/.test(secid)) return null;
  const hit = extraCache.get(secid);
  if (hit && now.getTime() - hit.at < TTL_MS) return hit.quote;
  try {
    const body = await getJson(`${SINGLE_GET}?secid=${secid}&fltt=2&invt=2&fields=${ONE_FIELDS}`);
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
const TRENDS_TTL = 20_000;
const KLINE_TTL = 300_000;
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
  return cachedChart(`trends:${secid}`, TRENDS_TTL, () => fetchTrends(secid));
}

async function fetchTrends(secid) {
  const url = `${TRENDS_URL}?secid=${secid}&fields1=f1,f2,f3,f4,f5,f6,f7,f8&fields2=f51,f53,f56,f58&iscr=0&ndays=1`;
  const body = await getJson(url, 5_000);
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
  return cachedChart(`kline:${secid}:${count}`, KLINE_TTL, () => fetchKline(secid, count));
}

async function fetchKline(secid, count) {
  const url = `${KLINE_URL}?secid=${secid}&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56&klt=101&fqt=1&lmt=${count}&end=20500101`;
  const body = await getJson(url, 5_000);
  const d = body.data;
  if (!d || !Array.isArray(d.klines)) return null;
  return d.klines.map((line) => {
    const [day, open, close, high, low, volume] = String(line).split(',');
    return { day, open: micro(Number(open)), close: micro(Number(close)), high: micro(Number(high)), low: micro(Number(low)), volume: Number(volume) || 0 };
  });
}
