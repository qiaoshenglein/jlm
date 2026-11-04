export const Y = 1_000_000; // 后端金额单位：微元

export type Quote = {
  secid: string; code: string; name: string; kind: 'index' | 'etf' | 'stock';
  last: number; prevClose: number; open: number | null; high: number | null; low: number | null;
  change: number; pct: number; volume: number; amount: number; turnover: number | null;
  marketCap: number | null; limitUp: number; limitDown: number; limitRatio: number;
  tick: number; ts: number; sealedUp: boolean; sealedDown: boolean;
};

export type Position = {
  symbol: string; code: string; name: string; kind: string; side: 'long' | 'short';
  qty: number; avail: number; price: number; avgCost: number; value: number;
  pnl: number; pnlPct: number; dayPnl: number; collateral?: number; prevClose?: number;
  limitUp: number | null; limitDown: number | null; pct: number;
};

export type Account = {
  day: string; cash: number; longValue: number; shortValue: number; collateral: number;
  totalAssets: number; totalDebt: number; netAssets: number;
  marginPrincipal: number; marginInterest: number; marginBalance: number; securityBalance: number;
  guaranteeRatio: number | null; leverage: number | null;
  floatPnl: number; realized: number; todayPnl: number; feesPaid: number; tradeCount: number;
  positions: Position[]; debtBySymbol: { symbol: string; principal: number }[];
};

export type OrderRow = {
  id: string; secid: string; code: string; name: string; kind: string; side: string; mode: string;
  qty: number; limitPrice: number | null; leaf: number; status: string; day: string;
  reason: string; source: string; created_at: string;
};

export type TradeRow = {
  id: string; secid: string; code: string; name: string; kind: string; side: string;
  qty: number; price: number; amount: number; fee: number; leaf: number; day: string; created_at: string;
};

export type WatchRow = { secid: string; code: string; name: string; kind: string; sort?: number; created_at: string };

export type SearchRow = {
  secid: string; code: string; name: string; kind: 'index' | 'etf' | 'stock';
  last: number | null; pct: number | null; tradable?: boolean; fromList?: boolean;
  sealedUp?: boolean; sealedDown?: boolean; tick?: number; amount?: number;
};

export type Board = {
  indexes: Quote[]; etfs: Quote[]; stocks: Quote[]; gainers: Quote[]; losers: Quote[];
  breadth: { up: number; down: number; flat: number; limitUp: number; limitDown: number };
  status: { ok: boolean; note: string | null };
};

export type Clock = { day: string; hour: number; minute: number; second: number; weekend: boolean; stamp: string };
export type Session = Clock & { phase: 'open' | 'auction' | 'lunch' | 'closed' };

export type SyncResponse = {
  ok: boolean; clock: Clock; session: Session; matchable: boolean; stale: boolean;
  market: Board; account: Account; orders: OrderRow[]; trades: TradeRow[];
  curve: { day: string; netAssets: number; totalAssets: number; totalDebt: number }[];
  events: { kind: string; message: string; at: string }[];
  leader: { name: string; ret: number; netAssets: number; mine: boolean }[];
  watch: WatchRow[]; watchQuotes: Quote[]; fills: TradeRow[];
  settled: number; canceled: number; user: { id: string; username: string; display: string };
};

export type Preview = {
  amount: number; fee: number; own: number; borrow: number; leaf: number; price: number;
  cashAfter: number; totalAssetsAfter: number; totalDebtAfter: number; ratioAfter: number | null;
  liquidationPrice: number | null; side?: string;
};

export const tone = (value: number) => (value > 0 ? 'text-up' : value < 0 ? 'text-down' : 'text-flat');
export const bgTone = (value: number) => (value > 0 ? 'bg-up' : value < 0 ? 'bg-down' : 'bg-flat');

export function money(micro: number, digits = 2): string {
  const value = (micro ?? 0) / Y;
  return value.toLocaleString('zh-CN', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function compact(micro: number): string {
  const value = (micro ?? 0) / Y;
  const abs = Math.abs(value);
  if (abs >= 1e8) return `${(value / 1e8).toFixed(2)}亿`;
  if (abs >= 1e4) return `${(value / 1e4).toFixed(2)}万`;
  return value.toFixed(2);
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
};

export const STATUS_LABEL: Record<string, string> = {
  open: '已报', filling: '成交中', filled: '已成交', canceled: '已撤销', rejected: '废单',
};

export const SIDE_LABEL: Record<string, string> = {
  buy: '担保品买入', sell: '担保品卖出', margin_buy: '融资买入',
  sell_repay: '卖券还款', short_sell: '融券卖出', cover_buy: '买券还券',
};

export const SIDE_SHORT: Record<string, string> = {
  buy: '买入', sell: '卖出', margin_buy: '融资买', sell_repay: '还款卖',
  short_sell: '融券空', cover_buy: '还券',
};
