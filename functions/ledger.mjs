// 账本层：只依赖不可变的成交流水重放出全部余额，因此不存在「多表写一半」的不一致。
// 成交记录一旦写入即不可修改；重放是纯函数，任何时候都能从流水复原账户状态。
import { MICRO, START_CASH, RATE_MARGIN, RATE_SHORT, accruedInterest } from './rules.mjs';

const BUY = 'buy';
const SELL = 'sell';
const MARGIN_BUY = 'margin_buy';
const SELL_REPAY = 'sell_repay';
const SHORT_SELL = 'short_sell';
const COVER_BUY = 'cover_buy';

export const SIDES = [BUY, SELL, MARGIN_BUY, SELL_REPAY, SHORT_SELL, COVER_BUY];
export const SIDE_LABELS = {
  [BUY]: '担保品买入', [SELL]: '担保品卖出', [MARGIN_BUY]: '融资买入',
  [SELL_REPAY]: '卖券还款', [SHORT_SELL]: '融券卖出', [COVER_BUY]: '买券还券',
};
export const isBuySide = (side) => side === BUY || side === MARGIN_BUY || side === COVER_BUY;
export const usesMargin = (side) => side === MARGIN_BUY || side === SHORT_SELL;
export const reducesLong = (side) => side === SELL || side === SELL_REPAY;
export const marginRateOf = (side) => (side === SHORT_SELL ? RATE_SHORT : RATE_MARGIN);

function bookOf(state, symbol, name, kind) {
  let book = state.books.get(symbol);
  if (!book) {
    book = {
      symbol, name: name ?? '', kind: kind ?? 'stock',
      qty: 0, cost: 0, todayBought: 0,
      sQty: 0, sPrincipal: 0, sOwn: 0, sOpenMs: 0,
      realized: 0,
    };
    state.books.set(symbol, book);
  }
  if (name) book.name = name;
  if (kind) book.kind = kind;
  return book;
}

// 卖券还款：逐笔冲减融资负债，先结已产生利息（计息起点推到当前），再冲本金
function repayMarginLots(state, symbol, proceedsMicro, nowMs) {
  let left = Math.max(0, proceedsMicro);
  for (const lot of state.marginLots) {
    if (lot.symbol !== symbol || lot.principal <= 0 || left <= 0) continue;
    const due = accruedInterest(lot.principal, lot.openedAt, nowMs, RATE_MARGIN);
    if (due > left) break; // 连利息都不够结清，保留该笔继续计息
    left -= due;
    lot.openedAt = nowMs;
    const take = Math.min(left, lot.principal);
    lot.principal -= take;
    left -= take;
  }
  state.marginLots = state.marginLots.filter((lot) => lot.principal > 0);
}

// 逐笔重放：trades 必须按 (created_at, id) 升序
export function replay(trades, { nowMs = Date.now(), today = '' } = {}) {
  const state = { cash: START_CASH, books: new Map(), marginLots: [], feesPaid: 0, count: 0 };
  for (const trade of trades) applyTrade(state, trade, nowMs, today);
  return state;
}

export function applyTrade(state, trade, nowMs, today) {
  const side = String(trade.side);
  if (!SIDES.includes(side)) return false;
  const qty = Math.trunc(Number(trade.qty) || 0);
  const price = Math.trunc(Number(trade.price) || 0);
  const amount = Math.trunc(Number(trade.amount) || qty * price);
  const fee = Math.trunc(Number(trade.fee) || 0);
  const leaf = Math.max(1, Math.trunc(Number(trade.leaf) || 1));
  const own = usesMargin(side) ? Math.round(amount / leaf) : 0;
  const atMs = Date.parse(String(trade.created_at ?? '')) || nowMs;
  const sameDay = Boolean(today) && String(trade.day ?? '') === today;
  const book = bookOf(state, trade.symbol, trade.name, trade.kind);
  state.feesPaid += fee;
  state.count += 1;

  if (side === BUY || side === MARGIN_BUY) {
    state.cash -= (side === BUY ? amount + fee : own + fee);
    book.cost += amount + fee;
    book.qty += qty;
    if (sameDay) book.todayBought += qty;
    if (side === MARGIN_BUY) state.marginLots.push({ symbol: book.symbol, principal: amount - own, openedAt: atMs });
    return true;
  }

  if (side === SELL || side === SELL_REPAY) {
    const closeQty = Math.min(qty, book.qty);
    const costOut = book.qty > 0 ? Math.round((book.cost * closeQty) / book.qty) : 0;
    const proceeds = amount - fee;
    state.cash += proceeds;
    book.qty -= closeQty;
    book.cost = book.qty > 0 ? Math.max(0, book.cost - costOut) : 0;
    book.realized += amount - costOut - fee;
    if (side === SELL_REPAY) repayMarginLots(state, book.symbol, proceeds, nowMs);
    return true;
  }

  if (side === SHORT_SELL) {
    state.cash -= own + fee;
    book.sQty += qty;
    book.sPrincipal += amount;
    book.sOwn += own;
    if (!book.sOpenMs) book.sOpenMs = atMs;
    return true;
  }

  if (side === COVER_BUY) {
    const closeQty = Math.min(qty, book.sQty);
    const ratio = book.sQty > 0 ? closeQty / book.sQty : 0;
    const released = Math.round((book.sPrincipal + book.sOwn) * ratio);
    const sellValue = book.sQty > 0 ? Math.round((book.sPrincipal / book.sQty) * closeQty) : 0;
    book.sPrincipal = Math.max(0, book.sPrincipal - Math.round(book.sPrincipal * ratio));
    book.sOwn = Math.max(0, book.sOwn - Math.round(book.sOwn * ratio));
    book.sQty -= closeQty;
    state.cash += released - amount - fee;
    book.realized += sellValue - amount - fee;
    if (book.sQty === 0) { book.sPrincipal = 0; book.sOwn = 0; book.sOpenMs = 0; }
    return true;
  }
  return false;
}

export function availOf(book) {
  return Math.max(0, book.qty - book.todayBought);
}

export function cloneState(state) {
  const books = new Map();
  for (const [symbol, book] of state.books) books.set(symbol, { ...book });
  return { ...state, books, marginLots: state.marginLots.map((lot) => ({ ...lot })) };
}

// 下单前用同一套账本代码试算成交后的状态，避免校验逻辑与结算逻辑各算一套
export function project(state, trade, nowMs, today) {
  const next = cloneState(state);
  applyTrade(next, trade, nowMs, today);
  return next;
}

// 达到平仓价时的估算价：(平仓线 × 负债 − 其他资产) / 持仓数量
export function liquidationPriceOf(metrics, symbol, ratio = 1.3) {
  const book = metrics.positions.find((p) => p.symbol === symbol);
  if (!book || book.qty <= 0) return null;
  const others = metrics.totalAssets - book.value;
  if (metrics.totalDebt <= 0) return null;
  const price = Math.round((ratio * metrics.totalDebt - others) / book.qty);
  return price > 0 ? price : null;
}

export function metricsOf(state, quotes, nowMs = Date.now()) {
  let longValue = 0, shortValue = 0, collateral = 0, floatPnl = 0, todayPnl = 0;
  const positions = [];
  const debtBySymbol = new Map();

  for (const book of state.books.values()) {
    const quote = quotes.get(book.symbol);
    const price = quote ? quote.last : Math.round(book.cost / Math.max(1, book.qty));
    const prevClose = quote ? quote.prevClose : price;
    const code = quote?.code ?? String(book.symbol).split('.')[1] ?? '';
    const name = book.name || quote?.name || code;

    if (book.qty > 0) {
      const value = Math.round(book.qty * price);
      const cost = book.cost;
      const pnl = value - cost;
      const dayPnl = quote ? Math.round(book.qty * (price - prevClose)) : 0;
      longValue += value;
      floatPnl += pnl;
      todayPnl += dayPnl;
      positions.push({
        symbol: book.symbol, code, name, kind: book.kind, side: 'long',
        qty: book.qty, avail: availOf(book), price, avgCost: Math.round(cost / book.qty),
        value, pnl, pnlPct: cost > 0 ? (pnl / cost) * 100 : 0, dayPnl, prevClose,
        limitUp: quote?.limitUp ?? null, limitDown: quote?.limitDown ?? null, pct: quote?.pct ?? 0,
      });
    }

    if (book.sQty > 0) {
      const value = Math.round(book.sQty * price);
      const pnl = book.sPrincipal - value;
      const locked = book.sPrincipal + book.sOwn;
      const dayPnl = quote ? Math.round(book.sQty * (prevClose - price)) : 0;
      shortValue += value;
      collateral += locked;
      floatPnl += pnl;
      todayPnl += dayPnl;
      positions.push({
        symbol: book.symbol, code, name, kind: book.kind, side: 'short',
        qty: book.sQty, avail: book.sQty, price, avgCost: Math.round(book.sPrincipal / book.sQty),
        value, pnl, pnlPct: book.sPrincipal > 0 ? (pnl / book.sPrincipal) * 100 : 0, dayPnl, collateral: locked, prevClose,
        limitUp: quote?.limitUp ?? null, limitDown: quote?.limitDown ?? null, pct: quote?.pct ?? 0,
      });
    }
  }

  let marginPrincipal = 0, marginInterest = 0, shortFee = 0;
  for (const lot of state.marginLots) {
    marginPrincipal += lot.principal;
    marginInterest += accruedInterest(lot.principal, lot.openedAt, nowMs, RATE_MARGIN);
    debtBySymbol.set(lot.symbol, (debtBySymbol.get(lot.symbol) ?? 0) + lot.principal);
  }
  for (const book of state.books.values()) {
    if (book.sQty > 0 && book.sOpenMs) {
      shortFee += accruedInterest(book.sPrincipal, book.sOpenMs, nowMs, RATE_SHORT);
    }
  }

  const totalAssets = state.cash + longValue + collateral;
  const marginDebt = marginPrincipal + marginInterest;
  const shortDebt = shortValue + shortFee;
  const totalDebt = marginDebt + shortDebt;
  const netAssets = totalAssets - totalDebt;

  return {
    cash: state.cash, longValue, shortValue, collateral,
    totalAssets, totalDebt, netAssets,
    marginPrincipal, marginInterest, shortDebt, shortFee,
    marginBalance: marginDebt, securityBalance: shortDebt,
    guaranteeRatio: totalDebt > 0 ? totalAssets / totalDebt : null,
    leverage: netAssets > 0 ? totalAssets / netAssets : null,
    floatPnl, todayPnl, realized: [...state.books.values()].reduce((sum, b) => sum + b.realized, 0),
    feesPaid: state.feesPaid, tradeCount: state.count,
    positions: positions.sort((a, b) => Math.abs(b.value) - Math.abs(a.value)),
    debtBySymbol: [...debtBySymbol].map(([symbol, principal]) => ({ symbol, principal })),
  };
}
