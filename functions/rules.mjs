// 交易规则层：数值单位、标的分类、费用、涨跌停、维持担保比例与交易时段。
// 金额统一用「微元」(1e-6 元) 整数存储，避免浮点误差；数据库列类型为 bigint。

export const MICRO = 1_000_000;
export const START_CASH = 1_000_000 * MICRO;
// 美股子账户默认本金（美元，同样按微美元整数存）。与 A 股本金相互独立。
export const START_CASH_USD = 100_000 * MICRO;

export const LEAVES = [1, 2, 3, 4, 5];
export const RATE_MARGIN = 0.0835;
export const RATE_SHORT = 0.1035;

// 维持担保比例阶梯：开仓线 / 预警线 / 追保线 / 平仓线
export const LINE_OPEN = 1.5;
export const LINE_WARN = 1.5;
export const LINE_CALL = 1.4;
export const LINE_LIQUID = 1.3;

export const DAY_MS = 86_400_000;

// 可热改的挂牌参数。默认值就是上面的常量，后台改动只影响「之后的计算」：
// 已落库的成交与费用永不重算，担保线只影响随后的判定，利率按挂牌价对存量负债继续计提。
export const PARAM_LIMITS = {
  stockCommission: [0.00001, 0.003], etfCommission: [0.00001, 0.003], commissionMin: [0, 100 * MICRO],
  stampTax: [0, 0.005], transferFee: [0, 0.001],
  margin: [0, 0.5], short: [0, 0.5],
  open: [1, 4], warn: [1, 4], call: [1, 4], liquid: [1, 2.5], withdraw: [1.5, 10],
};

export const DEFAULT_PARAMS = {
  fees: { stockCommission: 0.00025, etfCommission: 0.0001, commissionMin: 5 * MICRO, stampTax: 0.0005, transferFee: 0.00001 },
  rates: { margin: RATE_MARGIN, short: RATE_SHORT },
  lines: { open: LINE_OPEN, warn: LINE_WARN, call: LINE_CALL, liquid: LINE_LIQUID, withdraw: 3 },
};

// 美股挂牌参数。费用参考零售券商常见结构：佣金按比例、卖出收 SEC 监管费与 FINRA 活动费（有上限），
// 没有印花税；两融利率与维持担保比例按 Reg T 与 FINRA 口径折算成同样的比例表达。
export const DEFAULT_PARAMS_US = {
  // activityPerShare 是「微美元/股」：$0.000166/股 = 166 微美元，直接按股数相乘即为微美元
  fees: { commission: 0.0002, commissionMin: 1 * MICRO, secFee: 0.0000279, activityPerShare: 166, activityCap: Math.round(8.3 * MICRO) },
  rates: { margin: 0.065, short: 0.095 },
  lines: { open: 2, warn: 1.6, call: 1.5, liquid: 1.3, withdraw: 3 },
};

export const PARAM_LIMITS_US = {
  commission: [0, 0.01], commissionMin: [0, 20 * MICRO], secFee: [0, 0.001],
  activityPerShare: [0, 2000], activityCap: [0, 100 * MICRO],
  margin: [0, 0.5], short: [0, 0.5],
  open: [1, 6], warn: [1, 6], call: [1, 6], liquid: [1, 4], withdraw: [1.5, 10],
};

const copy = (value) => JSON.parse(JSON.stringify(value));
let ACTIVE = copy(DEFAULT_PARAMS);
let ACTIVE_US = copy(DEFAULT_PARAMS_US);

export const activeParams = (market = 'cn') => (market === 'us' ? ACTIVE_US : ACTIVE);

// 每个市场一张自己的限额表：美股的费用字段名与 A 股不同，不能共用
function limitsFor(market) {
  return market === 'us' ? PARAM_LIMITS_US : PARAM_LIMITS;
}

export function inRange(key, value, market = 'cn') {
  const limits = limitsFor(market)[key];
  const number = Number(value);
  return Boolean(limits) && Number.isFinite(number) && number >= limits[0] && number <= limits[1];
}

const pick = (key, value, fallback, market = 'cn') => (inRange(key, value, market) ? Number(value) : fallback);

// 担保线必须保持 liquid < call ≤ warn ≤ open。存进设置表之前先归一化，
// 保证「后台看到的值」与「引擎实际用的值」永远一致
export function normalizeLines(lines = {}) {
  const round = (value) => Math.round(value * 1e4) / 1e4;
  const liquid = round(lines.liquid);
  const call = round(Math.max(lines.call, liquid + 0.05));
  const warn = round(Math.max(lines.warn, call));
  const open = round(Math.max(lines.open, warn));
  return { open, warn, call, liquid, withdraw: round(lines.withdraw) };
}

// 挂牌参数按市场各存一份：改美股不会动 A 股的费用与线，反之亦然
export function setParams(patch = {}, market = 'cn') {
  const current = market === 'us' ? ACTIVE_US : ACTIVE;
  const defaults = market === 'us' ? DEFAULT_PARAMS_US : DEFAULT_PARAMS;
  const next = copy(current);
  for (const group of ['fees', 'rates', 'lines']) {
    const incoming = patch[group] ?? {};
    const target = { ...next[group] };
    for (const key of Object.keys(defaults[group])) {
      target[key] = pick(key, incoming[key], next[group][key], market);
    }
    next[group] = target;
  }
  next.lines = normalizeLines(next.lines);
  if (market === 'us') ACTIVE_US = next; else ACTIVE = next;
  return next;
}

export function resetParams(market = 'cn') {
  const fresh = copy(market === 'us' ? DEFAULT_PARAMS_US : DEFAULT_PARAMS);
  fresh.lines = normalizeLines(fresh.lines);
  if (market === 'us') ACTIVE_US = fresh; else ACTIVE = fresh;
  return fresh;
}

export function toMicro(yuan) {
  return Math.round(Number(yuan) * MICRO);
}
export function toYuan(micro) {
  return (micro || 0) / MICRO;
}
export function roundTick(priceMicro, tickMicro) {
  return Math.round(priceMicro / tickMicro) * tickMicro;
}

// secid 形如 "1.600519"（1=沪市，0=深市），与行情源保持一致，直接用于取价。
export function secidOf(market, code) {
  return `${market}.${code}`;
}
export function splitSecid(secid) {
  const [market, code] = String(secid).split('.');
  return { market, code };
}

// 市场与币种：由 secid 的市场号推导，流水不需要额外列，老库天然向后兼容
export const US_MARKET_NUMS = new Set(['100', '105', '106', '107']); // 全球指数 / 纳斯达克 / 纽交所 / AMEX
export const marketOf = (secid) => (US_MARKET_NUMS.has(String(secid).split('.')[0]) ? 'us' : 'cn');
export const currencyOf = (secid) => (marketOf(secid) === 'us' ? 'USD' : 'CNY');
export const CURRENCIES = ['cn', 'us'];
export const CURRENCY_OF_MARKET = { cn: 'CNY', us: 'USD' };
export const SYMBOL_OF_CURRENCY = { CNY: '¥', USD: '$' };
export const FX_SECID = '133.USDCNH'; // 离岸人民币，用于「折合人民币」展示，不参与记账

// 收益率与排行榜的可比本金：两个子账户的开户本金按当日汇率合并成人民币。
// 老账户没有 start_cash_usd 列时回落到默认值，与账本层的美元池起始口径一致。
export function startBaseOf(user, fx = 0) {
  const cny = Number(user?.start_cash ?? 0) > 0 ? Number(user.start_cash) : START_CASH;
  const usd = Number(user?.start_cash_usd ?? 0) > 0 ? Number(user.start_cash_usd) : START_CASH_USD;
  const rate = Number(fx) > 0 ? Number(fx) : 6.7 * MICRO;
  return cny + Math.round(usd * rate / MICRO);
}

// 标的类型由行情来源板块标注：index 指数（只读）/ etf 场内基金 / stock 股票
export function tickOf(kind, market = 'cn') {
  if (market === 'us') return 10_000; // 美股股票与 ETF 都是 0.01 美元（微美元计价，数值与 A 股股票同量级）
  return kind === 'etf' ? 1_000 : 10_000; // ETF 报价 0.001 元，股票 0.01 元
}

// 一手股数：A 股 100 股整手，美股 1 股起
export const lotOf = (market) => (market === 'us' ? 1 : 100);

export function tradableOf(kind) {
  return kind === 'etf' || kind === 'stock';
}

export function limitRatioOf(secid, name = '') {
  const { market, code } = splitSecid(secid);
  if (code.startsWith('688') || code.startsWith('689')) return 0.2;
  if (code.startsWith('300') || code.startsWith('301')) return 0.2;
  if (market === '0' && /^(4|8|9)\d{5}$/.test(code)) return 0.3; // 北交所
  if (/ST|退/.test(name)) return 0.05;
  if (/创业板|科创|成长/.test(name)) return 0.2;
  return 0.1;
}

// 交易所涨跌幅限制价格（以昨收为基准）。美股没有每日涨跌停，返回空区间，引擎据此跳过限价校验
export function limitPricesOf(prevCloseMicro, secid, name, kind) {
  const tick = tickOf(kind, marketOf(secid));
  if (marketOf(secid) === 'us') return { ratio: 0, up: null, down: null };
  const ratio = limitRatioOf(secid, name);
  return {
    ratio,
    up: roundTick(prevCloseMicro * (1 + ratio), tick),
    down: roundTick(prevCloseMicro * (1 - ratio), tick),
  };
}

export function isIndex(secid) {
  return secid === 'index' || /^100\./.test(secid) // 全球指数市场（道指/标普/纳指）整体不可交易
    || /^(1|0)\.(000001|000016|000300|000688|000852|000905|399001|399006|399011|899050)$/.test(secid);
}

// 费用：A 股 = 佣金（万2.5/万1，最低5元）+ 印花税（卖出千0.5，仅股票）+ 过户费（万0.1双向，仅股票）
export function feeOf(kind, side, amountMicro) {
  const fees = ACTIVE.fees;
  const buying = side === 'buy' || side === 'margin_buy' || side === 'cover_buy';
  const rate = kind === 'etf' ? fees.etfCommission : fees.stockCommission;
  let fee = Math.max(Math.round(amountMicro * rate), fees.commissionMin);
  if (kind === 'stock') {
    if (!buying) fee += Math.round(amountMicro * fees.stampTax);
    fee += Math.round(amountMicro * fees.transferFee);
  }
  return fee;
}

// 美股费用：佣金 + 卖出时的 SEC 监管费与 FINRA 活动费（按股计、有上限），没有印花税与过户费
export function feeOfUs(kind, side, amountMicro, qty) {
  const fees = ACTIVE_US.fees;
  const buying = side === 'buy' || side === 'margin_buy' || side === 'cover_buy';
  let fee = Math.max(Math.round(amountMicro * fees.commission), fees.commissionMin);
  if (!buying) {
    fee += Math.round(amountMicro * fees.secFee);
    fee += Math.min(Math.round(Math.abs(qty || 0) * fees.activityPerShare), fees.activityCap);
  }
  return fee;
}

// 引擎只调这一个入口，市场差异收在这里
export function feeFor({ secid, kind, side, amount, qty }) {
  return marketOf(secid) === 'us' ? feeOfUs(kind, side, amount, qty) : feeOf(kind, side, amount);
}

export function daysBetween(fromMs, toMs) {
  return Math.max(0, Math.floor((toMs - fromMs) / DAY_MS));
}

export function accruedInterest(principalMicro, openedAtMs, nowMs, rate) {
  return Math.round(principalMicro * rate * (daysBetween(openedAtMs, nowMs) / 365));
}

// ---- 交易时段（北京时间，与服务器时区无关）----
const TZ = 'Asia/Shanghai';
const partsFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, weekday: 'short',
});

export function bjParts(date = new Date()) {
  const parts = {};
  for (const { type, value } of partsFmt.formatToParts(date)) parts[type] = value;
  const minute = Number(parts.hour) * 60 + Number(parts.minute);
  return {
    day: `${parts.year}-${parts.month}-${parts.day}`,
    hour: Number(parts.hour),
    minute,
    second: Number(parts.second),
    weekend: ['Sat', 'Sun'].includes(parts.weekday),
    stamp: `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`,
  };
}

// open 连续竞价 / auction 集合竞价 / lunch 午间休市 / closed 非交易时间
export function sessionOf(date = new Date()) {
  const p = bjParts(date);
  if (p.weekend) return { phase: 'closed', ...p };
  if (p.minute >= 9 * 60 + 15 && p.minute < 9 * 60 + 25) return { phase: 'auction', ...p };
  if (p.minute >= 9 * 60 + 30 && p.minute < 11 * 60 + 30) return { phase: 'open', ...p };
  if (p.minute >= 11 * 60 + 30 && p.minute < 13 * 60) return { phase: 'lunch', ...p };
  if (p.minute >= 13 * 60 && p.minute < 15 * 60) return { phase: 'open', ...p };
  return { phase: 'closed', ...p };
}

function addDays(day, n) {
  const [y, m, d] = day.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d) + n * DAY_MS);
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`;
}
export function isWeekdayDay(day) {
  const [y, m, d] = day.split('-').map(Number);
  const w = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return w !== 0 && w !== 6;
}
export function nextWeekdayDay(day) {
  let next = addDays(day, 1);
  while (!isWeekdayDay(next)) next = addDays(next, 1);
  return next;
}

// 委托当日有效：盘中/早盘前归属当日，收盘后与周末归属下一个工作日
export function validityDayOf(date = new Date()) {
  const p = bjParts(date);
  if (!p.weekend && p.minute < 15 * 60 + 5) return p.day;
  if (p.weekend && p.minute < 9 * 60 + 15) return p.day;
  return nextWeekdayDay(p.day);
}

// 撮合窗口：工作日的连续竞价/集合竞价，且行情必须来自当日（自动覆盖法定休市日）
export function canMatch(date = new Date()) {
  const s = sessionOf(date);
  return !s.weekend && (s.phase === 'open' || s.phase === 'auction');
}

// ---- 美股时段：按美东时区计算，夏令时/冬令时自动跟随，不写死北京时间偏移 ----
const etFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short',
});

export function etParts(date = new Date()) {
  const parts = {};
  for (const { type, value } of etFmt.formatToParts(date)) parts[type] = value;
  const hour = Number(parts.hour === '24' ? 0 : parts.hour);
  const minute = hour * 60 + Number(parts.minute);
  return {
    day: `${parts.year}-${parts.month}-${parts.day}`,
    hour,
    minute,
    weekend: ['Sat', 'Sun'].includes(parts.weekday),
    stamp: `${parts.year}-${parts.month}-${parts.day} ${String(hour).padStart(2, '0')}:${parts.minute}`,
  };
}

// pre 盘前 / open 常规时段 / after 盘后 / closed。仿真只做常规时段，盘前盘后不撮合
export function usSessionOf(date = new Date()) {
  const p = etParts(date);
  if (p.weekend) return { phase: 'closed', ...p };
  if (p.minute >= 4 * 60 && p.minute < 9 * 60 + 30) return { phase: 'pre', ...p };
  if (p.minute >= 9 * 60 + 30 && p.minute < 16 * 60) return { phase: 'open', ...p };
  if (p.minute >= 16 * 60 && p.minute < 20 * 60) return { phase: 'after', ...p };
  return { phase: 'closed', ...p };
}

// 美股节假日不硬编码：休市日行情时间戳不会落在当日交易日，stale 判定会自动关掉撮合
export function usCanMatch(date = new Date()) {
  return usSessionOf(date).phase === 'open';
}

export function usValidityDayOf(date = new Date()) {
  const p = etParts(date);
  if (!p.weekend && p.minute < 16 * 60 + 5) return p.day;
  if (p.weekend && p.minute < 4 * 60) return p.day;
  return nextWeekdayDay(p.day);
}

export function clampText(value, max) {
  return String(value ?? '').trim().slice(0, max);
}
