// 撮合引擎：委托校验、成交判定、强制平仓计划。校验和结算共用同一套账本试算。
import { activeParams, feeFor, lotOf, marketOf, tickOf, tradableOf } from './rules.mjs';
import { SIDE_LABELS, availOf, liquidationPriceOf, metricsOf, project, usesMargin } from './ledger.mjs';

export const MAX_QTY = 1_000_000;
// 挂牌参数快照：同一笔判定内保持一致，改动只影响之后的计算。沪深与美股各一套
const lines = (market = 'cn') => activeParams(market).lines;

export const REASONS = {
  unknown_symbol: '未找到该标的的实时行情',
  index_not_tradable: '指数本身不可交易，请改选对应的场内 ETF',
  qty_invalid: '委托数量须为 100 的整数倍，且不超过 100 万股',
  price_invalid: '委托价格越出当日涨跌停区间，或未对齐最小报价单位',
  limit_up: '标的已涨停，无法买入',
  limit_down: '标的已跌停，无法卖出',
  no_position: '没有可平的多头持仓',
  no_short_position: '没有需要归还的融券负债',
  no_debt: '该标的没有融资负债，请改用「担保品卖出」',
  insufficient_avail: '可用不足：当日买入的仓位需下一交易日才可卖出（T+1）',
  withdraw_limited: '维持担保比例未超过 300%，担保品卖出受限，请改用「卖券还款」',
  insufficient_cash: '可用保证金不足',
  ratio_too_low: '成交后维持担保比例低于开仓线 150%，请降低杠杆或减小数量',
  liquidation_breach: '成交后维持担保比例将低于平仓线 130%，委托被拒绝',
  leaf_invalid: '杠杆倍数不合法',
  side_invalid: '交易方向不合法',
  suspended: '标的停牌或行情未更新，无法成交',
  account_frozen: '该账户已被后台冻结，暂时不能下单（撤单与查询仍可用）',
  match_paused: '后台已开启撮合熔断，暂停接受新委托',
  not_admin: '需要后台管理员权限',
  confirm_required: '该操作需要二次确认',
  last_admin: '系统里必须保留至少一个管理员，撤销被拒绝',
  register_closed: '注册已关闭，请联系管理员开通邀请码',
  invite_invalid: '邀请码不正确',
  unknown_user: '找不到该账户',
  amount_invalid: '金额不合法',
  cash_short: '出金金额超过该账户当前可用现金',
  setting_invalid: '参数名不在可修改清单里',
  param_invalid: '参数超出允许范围',
};

// 美股没有 T+1、没有涨跌停、1 股起买：同样的错误码要换一套说法
export const REASONS_US = {
  qty_invalid: '委托数量须为 1 股起，且不超过 100 万股',
  price_invalid: '委托价格未对齐最小报价单位 0.01 美元',
  insufficient_avail: '可用数量不足',
  ratio_too_low: '成交后维持担保比例低于开仓线 200%，请降低杠杆或减小数量',
  index_not_tradable: '指数本身不可交易，请改选对应的 ETF',
  suspended: '行情未更新（休市或停牌），无法成交',
};

// 废单原因落库与前端提示共用这一个入口：美股文案换成美股口径
export const reasonText = (code, market = 'cn') =>
  (market === 'us' && REASONS_US[code] ? REASONS_US[code] : REASONS[code] ?? code);

export function debtOf(metrics, symbol) {
  const lot = metrics.debtBySymbol.find((item) => item.symbol === symbol);
  return lot ? lot.principal : 0;
}

export function bookOf(state, symbol) {
  return state.books.get(symbol) ?? null;
}

export function buildTrade(draft, quote, nowMs, day) {
  const price = draft.mode === 'limit' ? draft.limitPrice : quote.last;
  const qty = draft.qty;
  const amount = qty * price;
  const leaf = usesMargin(draft.side) ? Math.max(2, draft.leaf ?? 1) : 1;
  const fee = feeFor({ secid: quote.secid, kind: quote.kind, side: draft.side, amount, qty });
  return {
    side: draft.side, symbol: quote.secid, code: quote.code, name: quote.name, kind: quote.kind,
    qty, price, amount, fee, leaf, day,
    own: usesMargin(draft.side) ? Math.round(amount / leaf) : (draft.side === 'buy' ? amount : 0),
    borrow: usesMargin(draft.side) ? amount - Math.round(amount / leaf) : 0,
    created_at: new Date(nowMs).toISOString(),
  };
}

// 成交后落账校验：现金不为负、维持担保比例不破开仓线/平仓线
function checkAfter(side, trade, state, quotes, nowMs, today) {
  const market = marketOf(trade.symbol);
  const projected = project(state, trade, nowMs, today);
  const metrics = metricsOf(projected, new Map(quotes), nowMs);
  const out = { projected, metrics, cash: metrics.cash };
  if (metrics.cash < 0) return { code: 'insufficient_cash', ...out };
  if (metrics.totalDebt > 0 && metrics.guaranteeRatio !== null) {
    if (metrics.guaranteeRatio < lines(market).liquid) return { code: 'liquidation_breach', ...out };
    if (usesMargin(side) && metrics.guaranteeRatio < lines(market).open) return { code: 'ratio_too_low', ...out };
  }
  return { code: null, ...out };
}

export function validateOrder(draft, { state, quotes, quote, nowMs, today, sessionFresh }) {
  const side = draft.side;
  if (!SIDE_LABELS[side]) return { ok: false, code: 'side_invalid' };
  if (!quote) return { ok: false, code: 'unknown_symbol' };
  if (!tradableOf(quote.kind)) return { ok: false, code: 'index_not_tradable' };
  if (!sessionFresh) return { ok: false, code: 'suspended' };

  const market = marketOf(quote.secid);
  const qty = Math.trunc(draft.qty ?? 0);
  // A 股 100 股整手，美股 1 股起（真实美股零售就是按股下单）
  if (!Number.isFinite(qty) || qty <= 0 || qty % lotOf(market) !== 0 || qty > MAX_QTY) return { ok: false, code: 'qty_invalid' };

  const leaf = Math.trunc(draft.leaf ?? 1);
  if (usesMargin(side) ? leaf < 2 || leaf > 5 : leaf !== 1) return { ok: false, code: 'leaf_invalid' };

  const buying = side === 'buy' || side === 'margin_buy' || side === 'cover_buy';
  const selling = side === 'sell' || side === 'sell_repay' || side === 'short_sell';
  if (buying && quote.sealedUp) return { ok: false, code: 'limit_up' };
  if (selling && quote.sealedDown) return { ok: false, code: 'limit_down' };

  if (draft.mode === 'limit') {
    const price = Math.trunc(draft.limitPrice ?? 0);
    const tick = quote.tick ?? tickOf(quote.kind, market);
    if (price <= 0 || price % tick !== 0) return { ok: false, code: 'price_invalid' };
    // 美股没有每日涨跌停，limitUp/limitDown 为 null 时不做区间校验
    if (quote.limitUp !== null && quote.limitDown !== null
      && (price > quote.limitUp || price < quote.limitDown)) return { ok: false, code: 'price_invalid' };
  }

  const metrics = metricsOf(state, quotes, nowMs);
  const book = bookOf(state, quote.secid);
  if (side === 'sell' || side === 'sell_repay') {
    if (!book || book.qty <= 0) return { ok: false, code: 'no_position' };
    if (availOf(book) < qty) return { ok: false, code: 'insufficient_avail' };
    const debt = debtOf(metrics, quote.secid);
    if (side === 'sell_repay' && debt <= 0) return { ok: false, code: 'no_debt' };
    if (side === 'sell' && debt > 0 && (metrics.guaranteeRatio ?? 0) < lines(market).withdraw) {
      return { ok: false, code: 'withdraw_limited' };
    }
  }
  if (side === 'cover_buy') {
    if (!book || book.sQty <= 0) return { ok: false, code: 'no_short_position' };
    if (book.sQty < qty) return { ok: false, code: 'insufficient_avail' };
  }

  const trade = buildTrade(draft, quote, nowMs, today);
  const check = checkAfter(side, trade, state, quotes, nowMs, today);
  if (check.code) return { ok: false, code: check.code };

  return {
    ok: true, trade,
    preview: {
      amount: trade.amount, fee: trade.fee, own: trade.own, borrow: trade.borrow,
      leaf: trade.leaf, price: trade.price,
      cashAfter: check.metrics.cash,
      totalAssetsAfter: check.metrics.totalAssets,
      totalDebtAfter: check.metrics.totalDebt,
      ratioAfter: check.metrics.guaranteeRatio,
      liquidationPrice: liquidationPriceOf(check.metrics, quote.secid, lines(market).liquid),
    },
  };
}

// 逐笔判定挂单：限价单需价格穿越，市价单按最新价成交
export function judgeOrder(order, quote, state, quotes, { nowMs, today, tradableWindow, stale }) {
  if (!quote) return { action: 'hold' };
  if (stale) return { action: 'reject', code: 'suspended' };
  if (!tradableWindow) return { action: 'hold' };

  const draft = {
    side: order.side, qty: order.qty, mode: order.mode,
    limitPrice: order.limit_price, leaf: order.leaf,
  };
  const buying = draft.side === 'buy' || draft.side === 'margin_buy' || draft.side === 'cover_buy';
  if (draft.mode === 'limit') {
    const crossed = buying ? quote.last <= draft.limitPrice : quote.last >= draft.limitPrice;
    if (!crossed) return { action: 'hold' };
  }
  const result = validateOrder(draft, { state, quotes, quote, nowMs, today, sessionFresh: true });
  if (!result.ok) return { action: 'reject', code: result.code };
  return { action: 'fill', trade: result.trade, preview: result.preview };
}

export function planLiquidation(metrics, { nowMs, today, openSymbols, market = 'cn' }) {
  if (metrics.totalDebt <= 0 || metrics.guaranteeRatio === null) return [];
  if (metrics.guaranteeRatio >= lines(market).liquid) return [];
  const target = lines(market).call + 0.1;
  // 强平也按各市场整手数量取整：A 股 100 股，美股 1 股
  const lot = lotOf(market);
  const plans = [];

  const longs = metrics.positions.filter((p) => p.side === 'long' && p.avail > 0)
    .sort((a, b) => Math.abs(b.value) - Math.abs(a.value));
  const shorts = metrics.positions.filter((p) => p.side === 'short')
    .sort((a, b) => Math.abs(b.value) - Math.abs(a.value));

  if (metrics.marginBalance > 0) {
    // 卖券还款：资产基本不变、负债减少，需要偿还 V ≥ 负债 − 资产/目标比例
    let remaining = Math.max(0, metrics.totalDebt - metrics.totalAssets / target);
    for (const position of longs) {
      if (plans.length >= 2 || remaining < lot * position.price) break;
      if (openSymbols.has(position.symbol)) continue;
      const value = Math.min(remaining, position.avail * position.price);
      const qty = Math.floor(value / position.price / lot) * lot;
      if (qty < lot) continue;
      plans.push({
        side: debtOf(metrics, position.symbol) > 0 ? 'sell_repay' : 'sell',
        secid: position.symbol, qty, mode: 'market', leaf: 1, reason: '维持担保比例低于平仓线，系统强制平仓',
      });
      remaining -= qty * position.price;
    }
  }
  if (metrics.securityBalance > 0 && plans.length < 2) {
    // 买券还券：资产与负债同时减少 V，需 (A−V)/(D−V) ≥ 目标比例
    let remaining = Math.max(0, (target * metrics.totalDebt - metrics.totalAssets) / (target - 1));
    for (const position of shorts) {
      if (plans.length >= 2 || remaining < lot * position.price) break;
      if (openSymbols.has(position.symbol)) continue;
      const value = Math.min(remaining, position.value);
      const qty = Math.floor(value / position.price / lot) * lot;
      if (qty < lot) continue;
      plans.push({
        side: 'cover_buy', secid: position.symbol, qty, mode: 'market', leaf: 1,
        reason: '维持担保比例低于平仓线，系统强制还券',
      });
      remaining -= qty * position.price;
    }
  }
  return plans;
}
