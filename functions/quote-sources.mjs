// 行情源适配器：三家公开接口，统一吐同一种「原始报价」。
// 撮合与风控只认这一种形状，所以换源不动引擎；每个源的字段索引、单位与编码都是实测出来的
// （见 dev/source-probe.mjs，它逐源打真实接口并核对归一化结果），不要凭印象改索引。
//
// 编码按接口而不是按厂商：
//   东财全部 UTF-8 JSON；腾讯 qt.gtimg.cn 是 GBK，proxy.finance.qq.com 与 ifzq 是 UTF-8；
//   新浪 hq.sinajs.cn 是 GBK，vip.stock 与 quotes.sina.cn 是 UTF-8（中文以 \u 转义给出）。
// 没有 iconv，用 TextDecoder('gbk')：自建 Node 带 full-icu 可用；
// 边缘运行时若不支持会退成乱码文本，因此默认源序把东财排在最前。
import { MICRO, FX_SECID, etParts, limitPricesOf, marketOf, secidOf, splitSecid, tickOf, tradableOf } from './rules.mjs';
import { quoteFetch } from './transport.mjs';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36';
const BATCH = 60; // 腾讯/新浪单次批量请求的代码数上限（实测 80 条会被截断，保守取 60）

// 主要指数与指数 ETF：定义在适配器层，因为三家都要用它来「点名」要取哪些指数。
// quotes.mjs 原样再导出，接口层与前端仍然只认一份。
export const KEY_INDEXES = [
  ['1.000001', '上证指数'], ['0.399001', '深证成指'], ['0.399006', '创业板指'],
  ['1.000300', '沪深300'], ['1.000016', '上证50'], ['1.000905', '中证500'],
  ['1.000852', '中证1000'], ['1.000688', '科创50'], ['0.899050', '北证50'],
  ['1.000985', '中证全指'],
];
export const INDEX_ETFS = ['1.510300', '1.510050', '1.510500', '1.588000', '0.159915', '0.159919', '1.512100', '0.159901'];
export const US_INDEXES = [['100.DJIA', '道琼斯'], ['100.SPX', '标普500'], ['100.NDX', '纳斯达克'], ['100.NDX100', '纳斯达克100']];

// ---- 小工具 ----
const num = (v) => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const text = String(v ?? '').trim();
  if (!text) return null;
  const out = Number(text);
  return Number.isFinite(out) ? out : null;
};
const micro = (v) => {
  const n = num(v);
  return n === null ? null : Math.round(n * MICRO);
};
const round = (v) => {
  const n = num(v);
  return n === null ? null : Math.round(n);
};

// 周 K：东财与腾讯都有原生周线，新浪只有日线，所以要有「日线按周合并」这条兜底路。
// 周的归属按 ISO 口径（周一为一周之始），一根周 K 的日期取该周最后一个交易日。
function weekKey(day) {
  const text = String(day ?? '').slice(0, 10);
  const date = new Date(`${text}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return text;
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
  return date.toISOString().slice(0, 10);
}

export function weeklyFromDaily(bars) {
  const out = [];
  const keys = [];
  for (const bar of bars ?? []) {
    const key = weekKey(bar.day);
    const last = out[out.length - 1];
    if (last && keys[keys.length - 1] === key) {
      last.day = bar.day;
      last.close = bar.close;
      last.high = Math.max(last.high, bar.high);
      last.low = Math.min(last.low, bar.low);
      last.volume += bar.volume || 0;
      continue;
    }
    out.push({ day: bar.day, open: bar.open, close: bar.close, high: bar.high, low: bar.low, volume: bar.volume || 0 });
    keys.push(key);
  }
  return out;
}

// 合成 N 根周 K 大约要 5N 个交易日；上限压在 1000 行，别为了周线把上游拉爆
const WEEKLY_DAILY_ROWS = (count) => Math.min(1_000, Math.max(60, Math.round(count * 5)));

// 出网统一走 transport 的 quoteFetch：自建入口把它换成带代理的实现时，三个源一起受益，
// 而行情层本身仍然不知道代理的存在（边缘运行时没有原始套接字）。
async function fetchText(url, { ms = 5_000, gbk = false, headers = {} } = {}) {
  const response = await quoteFetch(url, {
    ms,
    headers: { 'user-agent': UA, accept: '*/*', ...headers },
  });
  if (!response.ok) throw new Error(`upstream_${response.status}`);
  const buffer = await response.arrayBuffer();
  if (!gbk) return new TextDecoder().decode(buffer);
  try {
    return new TextDecoder('gbk').decode(buffer);
  } catch {
    // 运行时没有 GBK 解码器：数字字段仍然正确，只有中文名会花。
    // 交给上层按「本源不可用」处理，别让乱码进列表。
    throw new Error('gbk_unsupported');
  }
}

async function fetchJson(url, opts = {}) {
  const body = JSON.parse(await fetchText(url, opts));
  if (!body || typeof body !== 'object') throw new Error('upstream_shape');
  return body;
}

// 东财/腾讯 A股/新浪 A股 的时间戳口径各不相同，统一换成 epoch 秒。
// 撮合的「当日判定」就靠它（api.mjs quoteDayFor），差一天就会整市停撮合。
function tsBeijingCompact(text) {
  const s = String(text ?? '');
  if (s.length < 14) return 0;
  const y = Number(s.slice(0, 4));
  const mo = Number(s.slice(4, 6));
  const d = Number(s.slice(6, 8));
  const h = Number(s.slice(8, 10));
  const mi = Number(s.slice(10, 12));
  const se = Number(s.slice(12, 14));
  if (!y || !mo || !d) return 0;
  return Math.round((Date.UTC(y, mo - 1, d, h, mi, se) - 8 * 3600_000) / 1000);
}

function tsBeijingSpaced(datePart, timePart) {
  const s = `${String(datePart ?? '').trim()}T${String(timePart ?? '').trim()}`;
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/);
  if (!m) return 0;
  return Math.round((Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) - 8 * 3600_000) / 1000);
}

// 美东墙上时间 → epoch：先按夏令/冬令各试一次，再用 etParts 反查哪个对得上
function tsEastern(spaced) {
  const m = String(spaced ?? '').match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return 0;
  const wall = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] ?? 0));
  for (const offsetHours of [4, 5]) {
    const candidate = new Date(wall + offsetHours * 3600_000);
    const parts = etParts(candidate);
    if (`${parts.day} ${String(parts.hour).padStart(2, '0')}:${String(parts.minute % 60).padStart(2, '0')}`
      === `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}`) return Math.round(candidate.getTime() / 1000);
  }
  return Math.round((wall + 4 * 3600_000) / 1000);
}

// ---- 代码映射：secid ⇄ 各家原生写法 ----
const CN_INDEX_CODES = new Set(['000001', '000016', '000300', '000688', '000852', '000905', '000985', '399001', '399006', '399011', '899050']);

// 腾讯/新浪的 A 股代码前缀：sh / sz / bj（北交所 4、8 开头），指数与个股同一套前缀
function cnPrefix(secid) {
  const { market, code } = splitSecid(secid);
  if (market === '1') return 'sh';
  if (market === '2') return 'bj';
  if (/^(4|8|9)\d{5}$/.test(code)) return 'bj';
  return 'sz';
}
const qqCode = (secid) => `${cnPrefix(secid)}${splitSecid(secid).code}`;
// 美股：腾讯用 usAAPL 即可命中，返回体里带 .OQ/.N 后缀；指数用 usDJI/usINX/usIXIC 这类代码
// 分级股（106.BRK.B）的代码本身含点，不能用 splitSecid（它按点切，会截成 BRK）
const US_INDEX_QQ = { '100.DJIA': 'usDJI', '100.SPX': 'usINX', '100.NDX': 'usIXIC', '100.NDX100': 'usNDX' };
function qqUsCode(secid) {
  const text = String(secid);
  const market = text.split('.')[0];
  if (market === '100') return US_INDEX_QQ[secid] ?? null;
  return `us${text.slice(text.indexOf('.') + 1)}`;
}
const qqAnyCode = (secid) => (marketOf(secid) === 'us' ? qqUsCode(secid) : qqCode(secid));

// 反向：腾讯/新浪的 code 字段可能带后缀（AAPL.OQ / BRK.B），A 股按前缀还原交易所，
// 美股拿不到交易所编号（腾讯不给 105/106），只能猜 105 —— 所以自家请求一律传 knownSecid，别依赖这条兜底。
function secidFromQq(native, codeField) {
  const text = String(native ?? '');
  if (text.startsWith('us')) return `105.${String(codeField ?? text.slice(2)).toUpperCase().split('.')[0]}`;
  const prefix = text.slice(0, 2);
  const code = text.slice(2);
  if (prefix === 'sh') return `1.${code}`;
  if (prefix === 'sz') return `0.${code}`;
  if (prefix === 'bj') return `0.${code}`;
  return null;
}

// 场内 ETF 判定：沪市 5 开头、深市 1 开头（与东财口径一致）
function cnKindOf(secid, name, isIndex) {
  const { market, code } = splitSecid(secid);
  if (isIndex || CN_INDEX_CODES.has(code)) return 'index';
  if ((market === '1' && code[0] === '5') || (market === '0' && code[0] === '1')) return 'etf';
  return /ETF|杠杆|做多|做空/i.test(String(name ?? '')) ? 'etf' : 'stock';
}
const usKindOf = (secid, name) => (String(secid).startsWith('100.') ? 'index'
  : /ETF|杠杆|做多|做空/i.test(String(name ?? '')) ? 'etf' : 'stock');

// 统一出口：原始报价 → 引擎用的报价。涨跌停缺失就按昨收与规则算，美股没有涨跌停。
export function buildQuote(raw) {
  const kind = raw.kind ?? (marketOf(raw.secid) === 'us' ? usKindOf(raw.secid, raw.name) : cnKindOf(raw.secid, raw.name, raw.isIndex));
  if (!tradableOf(kind) && kind !== 'index') return null;
  if (raw.last === null || raw.prevClose === null || raw.prevClose <= 0) return null;
  const limits = raw.limitUp !== undefined && raw.limitUp !== null
    ? { ratio: raw.prevClose ? (raw.limitUp - raw.prevClose) / raw.prevClose : 0, up: raw.limitUp, down: raw.limitDown ?? null }
    : limitPricesOf(raw.prevClose, raw.secid, raw.name, kind);
  return {
    secid: raw.secid,
    code: String(raw.code ?? splitSecid(raw.secid).code),
    name: String(raw.name ?? ''),
    kind,
    last: raw.last,
    prevClose: raw.prevClose,
    open: raw.open ?? null,
    high: raw.high ?? null,
    low: raw.low ?? null,
    change: raw.last - raw.prevClose,
    pct: raw.pct ?? ((raw.last - raw.prevClose) / raw.prevClose) * 100,
    volume: round(raw.volume) ?? 0,
    amount: round(raw.amount) ?? 0,
    turnover: raw.turnover ?? null,
    marketCap: raw.marketCap ?? null,
    limitUp: limits.up,
    limitDown: limits.down,
    limitRatio: limits.ratio,
    ts: round(raw.ts) ?? 0,
    tick: tickOf(kind, marketOf(raw.secid)),
    sealedUp: limits.up !== null && raw.last >= limits.up,
    sealedDown: limits.down !== null && raw.last <= limits.down,
  };
}

const chunk = (list, size) => {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
};
const uniq = (list) => [...new Set(list.filter(Boolean))];

// =====================================================================
// 东方财富：字段最全（含涨跌停、成交额、市值、时间戳），且是唯一有美股榜的
// =====================================================================
const EM_LIST_FIELDS = 'f2,f3,f4,f5,f6,f7,f8,f12,f13,f14,f15,f16,f17,f18,f20,f124';
const EM_ONE_FIELDS = 'f43,f44,f45,f46,f47,f48,f57,f58,f60,f86,f168,f169,f170,f171';

const emClist = (cfg, fs, pz, fid, fields) => `https://${cfg.listHost}/api/qt/clist/get?pn=1&pz=${pz}&po=1&np=1&fltt=2&invt=2&fid=${fid}&fs=${fs}&fields=${fields}`;
const emSingle = (cfg, secid, fields) => `https://${cfg.singleHost}/api/qt/stock/get?secid=${secid}&fltt=2&invt=2&fields=${fields}`;

const emRow = (row, kind) => {
  const secid = secidOf(String(row.f13), String(row.f12));
  return buildQuote({
    secid, code: String(row.f12), name: String(row.f14 ?? ''), kind,
    last: micro(row.f2), prevClose: micro(row.f18), open: micro(row.f17), high: micro(row.f15), low: micro(row.f16),
    pct: num(row.f3), volume: num(row.f5), amount: num(row.f6), turnover: num(row.f8), marketCap: num(row.f20),
    ts: num(row.f124),
  });
};
// 单标的接口的字段号与列表接口完全不同
const emOne = (d, secid, kind) => buildQuote({
  secid, code: String(d.f57 ?? splitSecid(secid).code), name: String(d.f58 ?? ''), kind,
  last: micro(d.f43), prevClose: micro(d.f60), open: micro(d.f46), high: micro(d.f44), low: micro(d.f45),
  pct: num(d.f170), volume: num(d.f47), amount: num(d.f48), turnover: num(d.f168),
  ts: num(d.f86),
});

const EM_BOARDS = 'm:105,m:106,m:107';
const eastmoney = {
  key: 'eastmoney',
  label: '东方财富',
  hosts: ['push2.eastmoney.com', 'push2delay.eastmoney.com', 'push2his.eastmoney.com', 'searchapi.eastmoney.com'],
  caps: { cnStocks: 1, cnIndexes: 1, cnEtfs: 1, usStocks: 1, usIndexes: 1, one: 1, fx: 1, trends: 1, kline: 1, suggest: 1 },
  encoding: 'utf-8',

  async cnStocks(cfg, limit) {
    const body = await fetchJson(emClist(cfg, 'm:1+t:2,m:1+t:23,m:0+t:6,m:0+t:80', limit, 'f6', EM_LIST_FIELDS), { ms: cfg.timeoutMs });
    return (body.data?.diff ?? []).map((row) => emRow(row, 'stock')).filter(Boolean);
  },
  async cnIndexes(cfg, limit) {
    const body = await fetchJson(emClist(cfg, 'b:MK0010', limit, 'f3', EM_LIST_FIELDS), { ms: cfg.timeoutMs });
    return (body.data?.diff ?? []).map((row) => emRow(row, 'index')).filter(Boolean);
  },
  async cnEtfs(cfg, list) {
    const out = [];
    for (const secid of list) {
      try {
        const body = await fetchJson(emSingle(cfg, secid, EM_ONE_FIELDS), { ms: cfg.timeoutMs });
        const quote = body.data ? emOne(body.data, secid, 'etf') : null;
        if (quote) out.push(quote);
      } catch { /* 单个 ETF 取不到不影响整池，缺数由 note 说明 */ }
    }
    return out;
  },
  async usStocks(cfg, limit) {
    const body = await fetchJson(emClist(cfg, EM_BOARDS, limit, 'f6', EM_LIST_FIELDS), { ms: cfg.timeoutMs });
    return (body.data?.diff ?? []).map((row) => emRow(row, usKindOf(`${row.f13}.${row.f12}`, row.f14))).filter(Boolean);
  },
  async usIndexes(cfg) {
    const fs = US_INDEXES.map(([secid]) => `i:${secid}`).join(',');
    const body = await fetchJson(emClist(cfg, fs, US_INDEXES.length, 'f3', EM_LIST_FIELDS), { ms: cfg.timeoutMs });
    return (body.data?.diff ?? []).map((row) => emRow(row, 'index')).filter(Boolean);
  },
  async one(cfg, secid) {
    if (marketOf(secid) === 'us') {
      // stock/get 对部分纽交所代码返回空，美股单标走板块接口的 i: 形式
      const body = await fetchJson(emClist(cfg, `i:${secid}`, 3, 'f3', EM_LIST_FIELDS), { ms: cfg.timeoutMs });
      const row = (body.data?.diff ?? []).find((item) => `${item.f13}.${item.f12}` === secid);
      return row ? emRow(row, usKindOf(secid, row.f14)) : null;
    }
    const body = await fetchJson(emSingle(cfg, secid, EM_ONE_FIELDS), { ms: cfg.timeoutMs });
    if (!body.data) return null;
    return emOne(body.data, secid, cnKindOf(secid, body.data.f58, false));
  },
  async fx(cfg) {
    const body = await fetchJson(emSingle(cfg, FX_SECID, EM_ONE_FIELDS), { ms: Math.min(cfg.timeoutMs, 3_000) });
    const rate = micro(body.data?.f43 ?? null);
    if (rate === null || rate < MICRO || rate > 100 * MICRO) throw new Error('fx_shape');
    return { rate, label: '离岸 USDCNH' };
  },
  async trends(cfg, secid) {
    const url = `https://${cfg.histHost}/api/qt/stock/trends2/get?secid=${secid}&fields1=f1,f2,f3,f4,f5,f6,f7,f8&fields2=f51,f53,f56,f58&iscr=0&ndays=1`;
    const body = await fetchJson(url, { ms: Math.max(cfg.timeoutMs, 5_000) });
    const d = body.data;
    if (!d || !Array.isArray(d.trends)) throw new Error('trends_shape');
    return {
      name: String(d.name ?? ''),
      preClose: micro(d.preClose),
      points: d.trends.map((line) => {
        const [time, price, volume, avg] = String(line).split(',');
        return { t: time.slice(11, 16), price: micro(Number(price)), volume: Number(volume) || 0, avg: micro(Number(avg)) };
      }).filter((p) => Number.isFinite(p.price)),
    };
  },
  async kline(cfg, secid, count, period = 'day') {
    // klt=101 日线、102 周线；东财两个都给，不用自己合并
    const klt = period === 'week' ? 102 : 101;
    const url = `https://${cfg.histHost}/api/qt/stock/kline/get?secid=${secid}&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56&klt=${klt}&fqt=1&lmt=${count}&end=20500101`;
    const body = await fetchJson(url, { ms: Math.max(cfg.timeoutMs, 5_000) });
    if (!Array.isArray(body.data?.klines)) throw new Error('kline_shape');
    // f51,f52,f53,f54,f55 = 日期,开,收,高,低
    return body.data.klines.map((line) => {
      const [day, open, close, high, low, volume] = String(line).split(',');
      return { day, open: micro(Number(open)), close: micro(Number(close)), high: micro(Number(high)), low: micro(Number(low)), volume: Number(volume) || 0 };
    });
  },
  async suggest(cfg, needle, market) {
    const body = await fetchJson(`https://${cfg.searchHost}/api/suggest/get?input=${encodeURIComponent(needle)}&type=14&count=20`, { ms: cfg.timeoutMs });
    const deny = new Set(['Option', 'Futures', 'BkQuot', 'KRX', 'OTCFUND']);
    return (body.QuotationCodeTable?.Data ?? []).flatMap((row) => {
      const secid = String(row.QuoteID ?? '');
      const classify = String(row.Classify ?? '');
      if (market === 'us' ? !/^(100|105|106|107)\./.test(secid) : !/^[01]\.\d{6}$/.test(secid)) return [];
      if (market !== 'us' && deny.has(classify)) return [];
      return [{
        secid, code: String(row.Code ?? ''), name: String(row.Name ?? ''),
        kind: market === 'us' ? usKindOf(secid, row.Name) : classify === 'Index' ? 'index' : classify === 'Fund' ? 'etf' : cnKindOf(secid, row.Name, false),
      }];
    });
  },
};

// =====================================================================
// 腾讯：GBK 快照字段最全（直接给涨停/跌停），另有 UTF-8 的 A 股榜与分时/日 K
// 没有美股榜，所以美股池只能靠「要定价的代码」+ 固定指数与流动表逐个补
// =====================================================================
// qt.gtimg.cn 快照：A股/ETF/指数共用一套索引，美股是另一套（见 usRowOf）
function qqRow(text, nativeHint, knownSecid = null) {
  const f = String(text).split('~');
  if (f.length < 34) return null;
  const secid = knownSecid ?? secidFromQq(nativeHint ?? f[2], f[2]);
  if (!secid) return null;
  if (marketOf(secid) === 'us') return qqUsRow(f, secid);
  const triple = String(f[35] ?? '').split('/');
  return buildQuote({
    secid, code: f[2], name: f[1],
    last: micro(f[3]), prevClose: micro(f[4]), open: micro(f[5]),
    high: micro(f[33]), low: micro(f[34]),
    pct: num(f[32]),
    volume: num(f[6]),                                  // 手
    amount: num(triple[2]) ?? (num(f[37]) ?? 0) * 1e4,  // 元；退到万元口径时换算
    turnover: num(f[38]),
    marketCap: (num(f[45]) ?? 0) * 1e8 || null,         // 亿元 → 元
    limitUp: micro(f[47]), limitDown: micro(f[48]),     // 源直接给，比我自己算的更贴交易所
    ts: tsBeijingCompact(f[30]),
  });
}
// 美股：[3]最新 [4]昨收 [5]今开 [6]量(股) [30]美东时间 [33]高 [34]低 [37]额(美元) [45]总市值(亿)
function qqUsRow(f, secid) {
  // 代码口径与东财对齐：已知 secid 时取它自己的代码（BRK.B），
  // 腾讯返回的 BRK.B.N 带交易所后缀，只在没有 secid 时兜底用
  const fromSecid = String(secid).slice(String(secid).indexOf('.') + 1);
  const code = fromSecid || String(f[2] ?? '').toUpperCase();
  return buildQuote({
    secid, code, name: f[1],
    last: micro(f[3]), prevClose: micro(f[4]), open: micro(f[5]),
    high: micro(f[33]), low: micro(f[34]),
    pct: num(f[32]),
    volume: num(f[6]),
    amount: num(f[37]),
    marketCap: (num(f[45]) ?? 0) * 1e8 || null,
    ts: tsEastern(f[30]),
  });
}
const qqSecidOfNative = (native) => secidFromQq(String(native).replace(/^us/, 'us'), String(native).slice(2));

async function qqBatch(cfg, requests) {
  // 传 [{native, secid}] 或纯 native 字符串：已知 secid 时必须用它回填，
  // 因为腾讯不给交易所编号，反解会把纽交所(106)一律认成纳斯达克(105)，持仓键就对不上了
  const pairs = requests.map((item) => (typeof item === 'string' ? { native: item, secid: secidFromQq(item) } : item));
  const out = [];
  for (const group of chunk(uniq(pairs.map((item) => item.native)), BATCH)) {
    const text = await fetchText(`https://${cfg.txQuoteHost}/q=${group.join(',')}`, { ms: cfg.timeoutMs, gbk: true });
    for (const line of text.split(';')) {
      // 变量名里有点（v_usBRK.B），\w 会截断成 usBRK，secid 就还原错了
      const native = line.match(/v_([\w.\-]+)=/)?.[1];
      const body = line.slice(line.indexOf('=') + 1).trim().replace(/^"|"$/g, '');
      if (!native || !body) continue;
      const wanted = pairs.find((item) => item.native === native);
      const quote = qqRow(body, native, wanted?.secid ?? null);
      if (quote) out.push(quote);
    }
  }
  if (!out.length) throw new Error('qq_quote_empty');
  return out;
}

const LIQUID_US = ['105.AAPL', '105.MSFT', '105.NVDA', '105.TSLA', '105.AMZN', '105.META', '105.GOOG', '105.GOGL',
  '106.BRK.B', '106.JPM', '106.XOM', '106.WMT', '106.LLY', '106.MCD', '106.AVGO', '105.AMD', '105.NFLX', '105.INTC',
  '106.BA', '106.CVX', '106.KO', '106.PEP', '106.V', '106.MA', '105.SPY', '105.QQQ', '105.DIA', '105.IWM'];

// 美股日 K 必须用带交易所后缀的代码（usAAPL.OQ）：用 usAAPL 只会回「最早一天 + 最新一天」两条，
// 后缀在快照的第 3 段里，所以多花一次请求去取它。
async function qqUsFullCode(cfg, secid) {
  const native = qqUsCode(secid);
  if (!native) return null;
  try {
    const text = await fetchText(`https://${cfg.txQuoteHost}/q=${native}`, { ms: cfg.timeoutMs, gbk: true });
    const full = String(text.split('~')[2] ?? '');
    return full ? `us${full}` : native;
  } catch {
    return native;
  }
}

const tencent = {
  key: 'tencent',
  label: '腾讯财经',
  hosts: ['qt.gtimg.cn', 'proxy.finance.qq.com', 'ifzq.gtimg.cn', 'web.ifzq.gtimg.cn'],
  caps: { cnStocks: 1, cnIndexes: 1, cnEtfs: 1, usStocks: 1, usIndexes: 1, one: 1, fx: 1, trends: 1, kline: 1, suggest: 0 },
  encoding: 'gbk+utf-8',

  // 榜单只给代码与涨跌幅，价格与涨跌停要靠批量快照补齐 —— 两次请求，比东财多一次。
  // 单次上限实测 200 条，超过就静默回空数组，所以按 offset 分页取。
  async cnRankCodes(cfg, limit) {
    const size = Math.max(20, Math.min(limit, 1_000));
    const codes = [];
    for (let offset = 0; offset < size; offset += 200) {
      const body = await fetchJson(`https://${cfg.txListHost}/cgi/cgi-bin/rank/hs/getBoardRankList?board_code=aStock&sort_type=turnover&direct=down&offset=${offset}&count=${Math.min(200, size - offset)}`, { ms: cfg.timeoutMs });
      const list = body.data?.rank_list ?? [];
      if (!list.length) break;
      codes.push(...list.map((row) => row.code));
    }
    if (!codes.length) throw new Error('qq_rank_empty');
    return codes;
  },
  async cnStocks(cfg, limit) {
    const natives = await this.cnRankCodes(cfg, limit);
    return await qqBatch(cfg, natives);
  },
  async cnIndexes(cfg) {
    return await qqBatch(cfg, KEY_INDEXES.map(([secid]) => ({ native: qqCode(secid), secid })));
  },
  async cnEtfs(cfg, list) {
    return await qqBatch(cfg, list.map((secid) => ({ native: qqCode(secid), secid })));
  },
  // 没有美股榜：用「本轮真正需要定价的代码」（持仓/自选/查过的标的）+ 一份流动美股表
  async usStocks(cfg, limit, demand = []) {
    const secids = [...new Set([...demand.filter((s) => marketOf(s) === 'us'), ...LIQUID_US])].slice(0, Math.max(20, limit));
    const rows = await qqBatch(cfg, secids.map((secid) => ({ native: qqUsCode(secid), secid })).filter((item) => item.native));
    return rows.filter((row) => row.kind !== 'index');
  },
  async usIndexes(cfg) {
    const requests = US_INDEXES.map(([secid]) => ({ native: US_INDEX_QQ[secid], secid })).filter((item) => item.native);
    if (!requests.length) throw new Error('qq_us_index_unsupported');
    const rows = await qqBatch(cfg, requests);
    if (!rows.length) throw new Error('qq_us_index_empty');
    return rows.map((row) => ({ ...row, kind: 'index' }));
  },
  async one(cfg, secid) {
    const native = qqAnyCode(secid);
    if (!native) return null;
    const rows = await qqBatch(cfg, [{ native, secid }]);
    return rows.find((row) => row.secid === secid) ?? rows[0] ?? null;
  },
  async fx(cfg) {
    // 腾讯没有离岸 USDCNH 品种，用在岸 USDCNY 兜底：只差几个基点，且汇率只用于展示合并
    const text = await fetchText(`https://${cfg.txQuoteHost}/q=whUSDCNY`, { ms: Math.min(cfg.timeoutMs, 3_000), gbk: true });
    const rate = micro(text.split('~')[3]);
    if (rate === null || rate < MICRO || rate > 100 * MICRO) throw new Error('fx_shape');
    return { rate, label: '在岸 USDCNY（腾讯）' };
  },
  async trends(cfg, secid) {
    // 美股分时用不带后缀的代码（带后缀回空），日 K 反过来必须带后缀 —— 两处不同，别混用
    const native = marketOf(secid) === 'us' ? qqUsCode(secid) : qqCode(secid);
    if (!native) throw new Error('trends_unsupported');
    const body = await fetchJson(`https://${cfg.txHistHost}/appstock/app/minute/query?code=${native}`, { ms: Math.max(cfg.timeoutMs, 5_000) });
    const node = body.data?.[native];
    const lines = node?.data?.data;
    if (!Array.isArray(lines) || !lines.length) throw new Error('trends_shape');
    // qt[native] 本身就是字段数组（与 qt.gtimg.cn 的 ~ 分隔同序），不是字符串列表
    const fields = node.qt?.[native] ?? [];
    return {
      name: String(fields[1] ?? ''),
      preClose: micro(fields[4]) ?? micro(String(lines[0]).trim().split(/\s+/)[1]),
      points: lines.flatMap((line) => {
        const [hhmm, price, volume] = String(line).trim().split(/\s+/);
        if (!hhmm || hhmm.length < 4 || !Number.isFinite(Number(price))) return [];
        return [{ t: `${hhmm.slice(0, 2)}:${hhmm.slice(2, 4)}`, price: micro(Number(price)), volume: Number(volume) || 0, avg: null }];
      }),
    };
  },
  async kline(cfg, secid, count, period = 'day') {
    const us = marketOf(secid) === 'us';
    const native = us ? await qqUsFullCode(cfg, secid) : qqCode(secid);
    if (!native) throw new Error('kline_unsupported');
    const ask = async (span, rows) => {
      const body = await fetchJson(`https://${cfg.txKlineHost}/appstock/app/fqkline/get?param=${native},${span},,,${rows},qfq`, { ms: Math.max(cfg.timeoutMs, 5_000) });
      const node = body.data?.[native] ?? {};
      return node[`qfq${span}`] ?? node[span];
    };
    const bar = ([day, open, close, high, low, volume]) => ({
      day, open: micro(open), close: micro(close), high: micro(high), low: micro(low), volume: Number(volume) || 0,
    });
    const want = period === 'week' ? 'week' : 'day';
    let lines = await ask(want, count);
    if (want === 'week' && (!Array.isArray(lines) || !lines.length)) {
      // 部分标的（尤其美股）这条接口不回周线：退一步取日线自己按周合并，别把周 K 整个判死
      const daily = await ask('day', WEEKLY_DAILY_ROWS(count));
      if (!Array.isArray(daily) || !daily.length) throw new Error('kline_shape');
      return weeklyFromDaily(daily.map(bar)).slice(-count);
    }
    if (!Array.isArray(lines) || !lines.length) throw new Error('kline_shape');
    // 与东财同序：日期,开,收,高,低,量(手)。美股那条会无视 count 直接回全历史，这里自己截
    return lines.slice(-count).map(bar);
  },
};

// =====================================================================
// 新浪：A 股快照与榜可用，但没有涨跌停字段（按规则算）、美股快照不稳
// =====================================================================
function sinaRow(text, native) {
  const f = String(text).split(',');
  if (f.length < 32) return null;
  const secid = secidFromQq(native, native.slice(2));
  if (!secid || marketOf(secid) === 'us') return null;
  return buildQuote({
    secid, code: native.slice(2), name: f[0],
    open: micro(f[1]), prevClose: micro(f[2]), last: micro(f[3]), high: micro(f[4]), low: micro(f[5]),
    volume: (num(f[8]) ?? 0) / 100,          // 新浪给股，引擎记手
    amount: num(f[9]),
    ts: tsBeijingSpaced(f[30], f[31]),
    // 涨跌停不在返回里：留空让 buildQuote 按昨收与板块规则算
  });
}

const sina = {
  key: 'sina',
  label: '新浪财经',
  hosts: ['hq.sinajs.cn', 'vip.stock.finance.sina.com.cn', 'quotes.sina.cn'],
  caps: { cnStocks: 1, cnIndexes: 1, cnEtfs: 1, usStocks: 0, usIndexes: 0, one: 1, fx: 0, trends: 0, kline: 1, suggest: 0 },
  encoding: 'gbk+utf-8',
  headers: { referer: 'https://finance.sina.com.cn/' },

  // 新浪的榜每页最多 80 条，同样分页取；它给的是完整字段（含昨收与成交额），
  // 但仍统一走批量快照补价，这样两家的字段口径只有一处解析
  async cnRankCodes(cfg, limit) {
    const size = Math.max(20, Math.min(limit, 800));
    const symbols = [];
    for (let page = 1; (page - 1) * 80 < size; page += 1) {
      const text = await fetchText(`https://${cfg.sinaListHost}/quotes_service/api/json_v2.php/Market_Center.getHQNodeData?page=${page}&num=80&sort=amount&asc=0&node=hs_a`, {
        ms: cfg.timeoutMs, headers: this.headers,
      });
      const list = JSON.parse(text);
      if (!Array.isArray(list) || !list.length) break;
      symbols.push(...list.map((row) => row.symbol));
    }
    if (!symbols.length) throw new Error('sina_rank_empty');
    return symbols;
  },
  async cnStocks(cfg, limit) {
    const codes = await this.cnRankCodes(cfg, limit);
    return await this.byCodes(cfg, codes);
  },
  async cnIndexes(cfg) {
    return await this.byCodes(cfg, KEY_INDEXES.map(([secid]) => qqCode(secid)));
  },
  async cnEtfs(cfg, list) {
    return await this.byCodes(cfg, list.map(qqCode));
  },
  async byCodes(cfg, natives) {
    const out = [];
    for (const group of chunk(uniq(natives), BATCH)) {
      const text = await fetchText(`https://${cfg.sinaQuoteHost}/list=${group.join(',')}`, { ms: cfg.timeoutMs, gbk: true, headers: this.headers });
      for (const line of text.split('\n')) {
        const native = line.match(/hq_str_(\w+)=/)?.[1];
        const body = line.slice(line.indexOf('="') + 2).replace(/";?.*$/, '');
        if (!native || !body) continue;
        const quote = sinaRow(body, native);
        if (quote) out.push(quote);
      }
    }
    if (!out.length) throw new Error('sina_quote_empty');
    return out;
  },
  async one(cfg, secid) {
    if (marketOf(secid) === 'us') return null; // 美股快照按 IP 限流得厉害，不做兜底
    const rows = await this.byCodes(cfg, [qqCode(secid)]);
    return rows.find((row) => row.secid === secid) ?? null;
  },
  async kline(cfg, secid, count, period = 'day') {
    const native = qqCode(secid);
    // 新浪这条只有 scale=240 的日线，周线靠本地按周合并
    const week = period === 'week';
    const text = await fetchText(`https://${cfg.sinaHistHost}/cn/api/json_v2.php/CN_MarketDataService.getKLineData?symbol=${native}&scale=240&ma=no&datalen=${week ? WEEKLY_DAILY_ROWS(count) : count}`, {
      ms: Math.max(cfg.timeoutMs, 5_000), headers: this.headers,
    });
    const list = JSON.parse(text);
    if (!Array.isArray(list) || !list.length) throw new Error('kline_shape');
    // 新浪字段序是 open,high,low,close，与东财不同，别抄错
    const bars = list.map((row) => ({
      day: String(row.day).slice(0, 10), open: micro(row.open), close: micro(row.close),
      high: micro(row.high), low: micro(row.low), volume: Number(row.volume) || 0,
    }));
    return week ? weeklyFromDaily(bars).slice(-count) : bars;
  },
};

export const QUOTE_PROVIDERS = { eastmoney, tencent, sina };
export const PROVIDER_ORDER_DEFAULT = ['eastmoney', 'tencent', 'sina'];
export { qqCode, qqUsCode, secidFromQq, LIQUID_US };
