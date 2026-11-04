// 交易规则层：数值单位、标的分类、费用、涨跌停、维持担保比例与交易时段。
// 金额统一用「微元」(1e-6 元) 整数存储，避免浮点误差；数据库列类型为 bigint。

export const MICRO = 1_000_000;
export const START_CASH = 1_000_000 * MICRO;

export const LEAVES = [1, 2, 3, 4, 5];
export const RATE_MARGIN = 0.0835;
export const RATE_SHORT = 0.1035;

// 维持担保比例阶梯：开仓线 / 预警线 / 追保线 / 平仓线
export const LINE_OPEN = 1.5;
export const LINE_WARN = 1.5;
export const LINE_CALL = 1.4;
export const LINE_LIQUID = 1.3;

export const DAY_MS = 86_400_000;

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

// 标的类型由行情来源板块标注：index 指数（只读）/ etf 场内基金 / stock 股票
export function tickOf(kind) {
  return kind === 'etf' ? 1_000 : 10_000; // ETF 报价 0.001 元，股票 0.01 元
}

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

// 交易所涨跌幅限制价格（以昨收为基准）
export function limitPricesOf(prevCloseMicro, secid, name, kind) {
  const ratio = limitRatioOf(secid, name);
  const tick = tickOf(kind);
  return {
    ratio,
    up: roundTick(prevCloseMicro * (1 + ratio), tick),
    down: roundTick(prevCloseMicro * (1 - ratio), tick),
  };
}

export function isIndex(secid) {
  return secid === 'index' || /^(1|0)\.(000001|000016|000300|000688|000852|000905|399001|399006|399011|899050)$/.test(secid);
}

// 费用：佣金（万2.5/万1，最低5元）、印花税（卖出千0.5，仅股票）、过户费（万0.1双向，仅股票）
export function feeOf(kind, side, amountMicro) {
  const buying = side === 'buy' || side === 'margin_buy' || side === 'cover_buy';
  const rate = kind === 'etf' ? 0.0001 : 0.00025;
  let fee = Math.max(Math.round(amountMicro * rate), 5 * MICRO);
  if (kind === 'stock') {
    if (!buying) fee += Math.round(amountMicro * 0.0005);
    fee += Math.round(amountMicro * 0.00001);
  }
  return fee;
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

export function clampText(value, max) {
  return String(value ?? '').trim().slice(0, max);
}
