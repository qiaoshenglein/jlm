export type Lines = { open: number; warn: number; call: number; liquid: number; withdraw: number };
export const DEFAULT_LINES: Lines = { open: 1.5, warn: 1.5, call: 1.4, liquid: 1.3, withdraw: 3 };

// 两个市场各一套挂牌参数：fees 的字段名不同，所以按市场分开声明
export type CnFees = { stockCommission: number; etfCommission: number; commissionMin: number; stampTax: number; transferFee: number };
export type UsFees = { commission: number; commissionMin: number; secFee: number; activityPerShare: number; activityCap: number };
export type DeskParams = {
  fees: CnFees | UsFees;
  rates: { margin: number; short: number };
  lines: Lines;
};

export const Y = 1_000_000; // 后端金额单位：微元 / 微美元

export type Market = 'cn' | 'us';
export type Currency = 'CNY' | 'USD';
export const MARKET_NAME: Record<Market, string> = { cn: '沪深', us: '美股' };
export const CURRENCY_OF: Record<Market, Currency> = { cn: 'CNY', us: 'USD' };
export const SYMBOL_OF: Record<Currency, string> = { CNY: '¥', USD: '$' };
// 美股市场号：100 全球指数 / 105 纳斯达克 / 106 纽交所 / 107 AMEX
const US_SECID = /^(100|105|106|107)\./;
export const marketOfSecid = (secid?: string | null): Market => (US_SECID.test(String(secid ?? '')) ? 'us' : 'cn');
export const currencyOfSecid = (secid?: string | null): Currency => CURRENCY_OF[marketOfSecid(secid)];
// 整手数量：A 股 100 股一手，美股 1 股一手
export const lotOfSecid = (secid?: string | null) => (marketOfSecid(secid) === 'us' ? 1 : 100);
// 最小报价单位：A 股 ETF 是 0.001 元，其余（含美股）都是两位小数
export const tickOfSecid = (secid?: string | null, kind?: string) =>
  (marketOfSecid(secid) === 'us' || kind !== 'etf' ? 10_000 : 1_000);
export const currencySymbol = (currency: Currency = 'CNY') => SYMBOL_OF[currency] ?? '¥';

export type Quote = {
  secid: string; code: string; name: string; kind: 'index' | 'etf' | 'stock';
  last: number; prevClose: number; open: number | null; high: number | null; low: number | null;
  change: number; pct: number; volume: number; amount: number; turnover: number | null;
  // 美股没有每日涨跌停，服务端给 null；渲染前先判空，别把 null 当 0 用
  marketCap: number | null; limitUp: number | null; limitDown: number | null; limitRatio: number;
  tick: number; ts: number; sealedUp: boolean; sealedDown: boolean;
};

export type Position = {
  symbol: string; code: string; name: string; kind: string; side: 'long' | 'short';
  qty: number; avail: number; price: number; avgCost: number; value: number;
  pnl: number; pnlPct: number; dayPnl: number; collateral?: number; prevClose?: number;
  liquidationPrice?: number | null;
  limitUp: number | null; limitDown: number | null; pct: number;
};

export type Account = {
  day: string; cash: number; longValue: number; shortValue: number; collateral: number;
  totalAssets: number; totalDebt: number; netAssets: number;
  startCash?: number; market?: Market; currency?: Currency;
  marginPrincipal: number; marginInterest: number; marginBalance: number; securityBalance: number;
  guaranteeRatio: number | null; leverage: number | null;
  floatPnl: number; realized: number; todayPnl: number; feesPaid: number; tradeCount: number;
  positions: Position[]; debtBySymbol: { symbol: string; principal: number }[];
};

// 另一个市场的摘要：切过去才展开完整簿面，顶栏只需要这几个数
export type SideView = {
  market: Market; currency: Currency; day: string;
  cash: number; totalAssets: number; netAssets: number; totalDebt: number;
  guaranteeRatio: number | null; leverage: number | null; positions: number; startCash: number;
};

export type MarketStatus = { market: Market; currency: Currency; day: string; session: Session; matchable: boolean; paused: boolean };

export type OrderRow = {
  id: string; secid: string; code: string; name: string; kind: string; side: string; mode: string;
  qty: number; limitPrice: number | null; leaf: number; status: string; day: string;
  reason: string; source: string; created_at: string; currency?: Currency;
};

export type TradeRow = {
  id: string; secid: string; code: string; name: string; kind: string; side: string;
  qty: number; price: number; amount: number; fee: number; leaf: number; day: string; created_at: string;
  currency?: Currency;
};

export type WatchRow = { secid: string; code: string; name: string; kind: string; sort?: number; created_at: string };

export type SearchRow = {
  secid: string; code: string; name: string; kind: 'index' | 'etf' | 'stock';
  last: number | null; pct: number | null; tradable?: boolean; fromList?: boolean;
  sealedUp?: boolean; sealedDown?: boolean; tick?: number; amount?: number;
};

export type Board = {
  market?: Market; currency?: Currency;
  indexes: Quote[]; etfs: Quote[]; stocks: Quote[]; gainers: Quote[]; losers: Quote[];
  // 美股没有涨跌家数接口，取不到就是 null，前端隐藏这一条而不是编一个 0
  breadth: { up: number; down: number; flat: number; limitUp: number; limitDown: number } | null;
  // partial：上游只挂掉一部分时的降级说明（例如 ETF 补取失败），池子仍然可用
  status: { ok: boolean; note: string | null; partial?: string };
};

export type Clock = { day: string; hour: number; minute: number; second: number; weekend: boolean; stamp: string };
export type Session = Clock & { phase: 'open' | 'auction' | 'lunch' | 'closed' | 'pre' | 'after' };

export type SyncResponse = {
  ok: boolean; clock: Clock; session: Session; matchable: boolean; matchPaused?: boolean; stale: boolean;
  activeMarket?: Market; currency?: Currency; fx?: number;
  market: Board; account: Account; side?: SideView;
  combined?: { netAssets: number; totalAssets: number; cash: number; totalDebt: number; startCash?: number };
  markets?: Record<Market, MarketStatus>;
  orders: OrderRow[]; trades: TradeRow[];
  curve: { day: string; netAssets: number; totalAssets: number; totalDebt: number }[];
  events: { kind: string; message: string; at: string }[];
  leader: { name: string; ret: number; netAssets: number; mine: boolean }[];
  watch: WatchRow[]; watchQuotes: Quote[]; fills: TradeRow[];
  settled: number; canceled: number; params?: DeskParams; user: {
    id: string; username: string; display: string;
    role?: 'user' | 'admin'; status?: 'active' | 'frozen';
    startCash?: number; startCashUsd?: number;
  };
};

export type Preview = {
  amount: number; fee: number; own: number; borrow: number; leaf: number; price: number;
  cashAfter: number; totalAssetsAfter: number; totalDebtAfter: number; ratioAfter: number | null;
  liquidationPrice: number | null; side?: string;
};

export const tone = (value: number) => (value > 0 ? 'text-up' : value < 0 ? 'text-down' : 'text-flat');
export const bgTone = (value: number) => (value > 0 ? 'bg-up' : value < 0 ? 'bg-down' : 'bg-flat');

// 金额一律带币种符号输出：两个现金池并存时，光看数字分不清 ¥ 还是 $
export function money(micro: number, currency: Currency = 'CNY', digits = 2): string {
  const value = (micro ?? 0) / Y;
  return `${currencySymbol(currency)}${value.toLocaleString('zh-CN', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

export function compact(micro: number, currency: Currency = 'CNY'): string {
  const value = (micro ?? 0) / Y;
  const abs = Math.abs(value);
  const body = abs >= 1e8 ? `${(value / 1e8).toFixed(2)}亿`
    : abs >= 1e4 ? `${(value / 1e4).toFixed(2)}万` : value.toFixed(2);
  return `${currencySymbol(currency)}${body}`;
}

export function priceText(micro: number, tick = 10_000): string {
  if (micro === null || micro === undefined) return '—';
  return ((micro ?? 0) / Y).toFixed(tick === 1_000 ? 3 : 2);
}

export function percent(value: number, digits = 2): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return `${value >= 0 ? '+' : ''}${value.toFixed(digits)}%`;
}

export function ratioText(ratio: number | null): string {
  if (ratio === null || ratio === undefined) return '—';
  if (ratio > 50) return `${(ratio * 100).toFixed(0)}%`;
  return `${(ratio * 100).toFixed(1)}%`;
}

export function shares(qty: number): string {
  if (Math.abs(qty) >= 10_000) return `${(qty / 10_000).toFixed(qty % 10_000 === 0 ? 0 : 2)}万`;
  return qty.toLocaleString('zh-CN');
}

export function clockTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  // 统一按北京时间展示，避免用户设备时区造成误读
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(date);
}

export function dayTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(date);
}

export const SESSION_LABEL: Record<string, string> = {
  open: '连续竞价中', auction: '集合竞价', lunch: '午间休市', closed: '已收盘',
  pre: '盘前时段', after: '盘后时段',
};

// 美股时段标签：盘前/盘后只是展示，撮合仍然只做常规时段，措辞要区分开
export const US_SESSION_LABEL: Record<string, string> = {
  open: '常规时段', auction: '常规时段', pre: '盘前', after: '盘后', lunch: '休市', closed: '已收盘',
};

export const sessionLabel = (market: Market, phase?: string) =>
  (market === 'us' ? US_SESSION_LABEL : SESSION_LABEL)[phase ?? 'closed'] ?? '已收盘';

export const STATUS_LABEL: Record<string, string> = {
  open: '已报', filling: '成交中', filled: '已成交', canceled: '已撤销', rejected: '废单',
};

export const SIDE_LABEL: Record<string, string> = {
  buy: '担保品买入', sell: '担保品卖出', margin_buy: '融资买入',
  sell_repay: '卖券还款', short_sell: '融券卖出', cover_buy: '买券还券',
  capital_in: '后台入金', capital_out: '后台出金',
};

export const SIDE_SHORT: Record<string, string> = {
  buy: '买入', sell: '卖出', margin_buy: '融资买', sell_repay: '还款卖',
  short_sell: '融券空', cover_buy: '还券', capital_in: '入金', capital_out: '出金',
};

export const isCapitalSide = (side: string) => side === 'capital_in' || side === 'capital_out';
