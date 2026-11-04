// 应用路由：注册/登录、行情、下单试算、同步（撮合 + 风控 + 日结快照）。
// 写操作只接受 POST；请求体大小与字段都做白名单校验。
import {
  MICRO, LEAVES, START_CASH, RATE_MARGIN, RATE_SHORT, LINE_WARN, LINE_CALL, LINE_LIQUID,
  bjParts, canMatch, sessionOf, validityDayOf, clampText, tradableOf,
} from './rules.mjs';
import { KEY_INDEXES, ensureQuote, getQuotes, klineOf, quoteStatus, searchSymbols, trendsOf } from './quotes.mjs';
import { Store } from './store.mjs';
import { MAX_QTY, REASONS, judgeOrder, planLiquidation, validateOrder } from './engine.mjs';
import { SIDE_LABELS, SIDES, applyTrade, metricsOf, replay } from './ledger.mjs';
import {
  checkPassword, digestToken, hashPassword, newId, newToken, normalizeDisplay, normalizeUsername, verifyPassword,
} from './auth.mjs';

const SESSION_DAYS = 30;
const json = (body, status = 200) => Response.json(body, {
  status, headers: { 'cache-control': 'no-store', 'content-type': 'application/json' },
});
const bad = (code, status = 400) => json({ ok: false, code }, status);

const READ_ACTIONS = new Set(['board', 'sync', 'me', 'chart', 'leader', 'rules', 'lookup', 'search']);
const WRITE_ACTIONS = new Set(['register', 'login', 'logout', 'order', 'cancel', 'preview', 'watch_add', 'watch_remove', 'watch_sort']);

const UNAUTHED = () => Object.assign(new Error('login_required'), { code: 'login_required', status: 401 });

function tokenOf(body, params, request) {
  const fromBody = typeof body?.token === 'string' ? body.token : '';
  if (fromBody.length >= 32 && fromBody.length <= 128) return fromBody;
  // 网关会剥离 cookie 与 authorization，因此优先走请求体；自定义头仅方便本地调试
  const header = request.headers.get('x-ptoken') ?? '';
  if (header.length >= 32 && header.length <= 128) return header;
  return '';
}

// 同一-标的-方向-数量-价格-杠杆 的委托，短时间内重复提交要显式确认，防止误触连点
const DUPLICATE_WINDOW_MS = 15_000;
const recentSubmits = new Map();

const throttles = new Map();
function throttled(key, limit, windowMs, nowMs) {
  const hit = throttles.get(key);
  if (!hit || nowMs - hit.at > windowMs) {
    if (throttles.size > 5000) throttles.clear();
    throttles.set(key, { at: nowMs, n: 1 });
    return false;
  }
  hit.n += 1;
  return hit.n > limit;
}

async function readBody(request, limit = 4096) {
  try {
    const raw = await request.text();
    if (!raw) return {};
    if (raw.length > limit) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function publicMarket(quotes) {
  const list = [...quotes.values()];
  const indexes = KEY_INDEXES.map(([secid]) => quotes.get(secid)).filter(Boolean);
  const stocks = list.filter((quote) => quote.kind === 'stock');
  const etfs = list.filter((quote) => quote.kind === 'etf');
  const ranked = [...stocks].sort((a, b) => b.pct - a.pct);
  return {
    indexes: indexes.length ? indexes : list.filter((quote) => quote.kind === 'index'),
    etfs,
    stocks: stocks.slice(0, 60),
    gainers: ranked.slice(0, 10),
    losers: ranked.slice(-10).reverse(),
    breadth: {
      up: stocks.filter((quote) => quote.pct > 0).length,
      down: stocks.filter((quote) => quote.pct < 0).length,
      flat: stocks.filter((quote) => quote.pct === 0).length,
      limitUp: stocks.filter((quote) => quote.sealedUp).length,
      limitDown: stocks.filter((quote) => quote.sealedDown).length,
    },
    status: quoteStatus(),
  };
}

const RULES = {
  startCash: START_CASH,
  leaves: LEAVES,
  maxQty: MAX_QTY,
  lines: { open: 1.5, warn: LINE_WARN, call: LINE_CALL, liquid: LINE_LIQUID, withdraw: 3 },
  rates: { margin: RATE_MARGIN, short: RATE_SHORT },
  fees: { stockCommission: 0.00025, etfCommission: 0.0001, commissionMin: 5 * MICRO, stampTax: 0.0005, transferFee: 0.00001 },
  reasons: REASONS,
  sides: SIDES,
  labels: SIDE_LABELS,
};

export async function handle({ request, supabase }) {
  const store = new Store(supabase);
  const url = new URL(request.url);
  const action = url.searchParams.get('action') ?? 'board';
  const method = request.method.toUpperCase();
  const body = method === 'GET' ? {} : await readBody(request);
  if (body === null) return bad('body_invalid');
  if (method === 'GET' && WRITE_ACTIONS.has(action)) return bad('method_not_allowed', 405);
  if (!READ_ACTIONS.has(action) && !WRITE_ACTIONS.has(action)) return bad('not_found', 404);

  const now = new Date();
  const nowMs = now.getTime();
  const clock = bjParts(now);
  const session = sessionOf(now);
  const matchable = canMatch(now);
  const today = clock.day;

  try {
    switch (action) {
      case 'rules': return json({ ok: true, rules: RULES });
      case 'board': {
        const quotes = await getQuotes(false, now).catch(() => new Map());
        return json({ ok: true, clock, session, matchable, stale: quoteDay(quotes) !== today, market: publicMarket(quotes) });
      }
      case 'chart': return await chartAction(body);
      case 'lookup': return await lookupAction(body, now);
      case 'search': return await searchAction(body, now);
      case 'leader': return await leaderAction(store, today);
      case 'register': return await registerAction(store, body, nowMs, today);
      case 'login': return await loginAction(store, body, nowMs);
      case 'logout': return await logoutAction(store, tokenOf(body, url.searchParams, request));
      case 'me': return await meAction(store, tokenOf(body, url.searchParams, request), nowMs, today, clock, session, matchable);
      case 'sync': return await syncAction({ store, request, body, url, now, nowMs, today, clock, session, matchable });
      case 'preview': return await orderAction(store, true, { request, body, url, nowMs, today });
      case 'order': return await orderAction(store, false, { request, body, url, nowMs, today });
      case 'cancel': return await cancelAction(store, { request, body, url, nowMs });
      case 'watch_add': return await watchAction(store, 'add', { request, body, url, nowMs, now });
      case 'watch_remove': return await watchAction(store, 'remove', { request, body, url, nowMs, now });
      case 'watch_sort': return await watchSortAction(store, { request, body, url, nowMs });
      default: return bad('not_found', 404);
    }
  } catch (error) {
    // 边缘运行时没有 process；本地调试时把真实堆栈打到 stderr，响应里只保留安全错误码
    if (!error?.code && globalThis.process?.env && globalThis.process.env.NODE_ENV !== 'production') {
      console.error(`[app:${action}]`, error?.stack ?? error);
    }
    if (error?.code) return bad(error.code, error.status ?? 503);
    return bad('server_error', 500);
  }
}

async function lookupAction(body, now) {
  const secid = clampText(body.secid, 12);
  if (!/^[012]\.\d{6}$/.test(secid)) return bad('symbol_invalid');
  const quotes = await getQuotes(false, now).catch(() => new Map());
  const quote = quotes.get(secid) ?? await ensureQuote(secid, quotes, now);
  if (!quote) return bad('unknown_symbol', 404);
  return json({ ok: true, quote });
}

async function searchAction(body, now) {
  const quotes = await getQuotes(false, now).catch(() => new Map());
  const rows = await searchSymbols(String(body.q ?? ''), quotes, now);
  return json({ ok: true, rows });
}

async function chartAction(body) {
  const secid = clampText(body.secid, 12);
  const kind = body.kind === 'kline' ? 'kline' : 'trends';
  if (!/^[012]\.\d{6}$/.test(secid)) return bad('symbol_invalid');
  const count = Math.min(320, Math.max(30, Number(body.count) || 120));
  const series = kind === 'kline' ? await klineOf(secid, count) : await trendsOf(secid);
  if (!series) return bad('chart_unavailable', 503);
  return json({ ok: true, secid, kind, series });
}

async function leaderAction(store, today) {
  const rows = await store.leaderboard(today, 30);
  const names = await store.listUsernames(rows.map((row) => row.user_id));
  return json({
    ok: true, day: today,
    rows: rows.map((row) => ({
      name: names.get(row.user_id)?.display ?? '匿名',
      netAssets: row.net_assets,
      totalAssets: row.total_assets,
      totalDebt: row.total_debt ?? 0,
      ratio: row.total_debt > 0 ? row.total_assets / row.total_debt : null,
      ret: row.net_assets / START_CASH - 1,
    })),
  });
}

async function createSession(store, userId, nowMs) {
  const token = newToken();
  const expires = new Date(nowMs + SESSION_DAYS * 86_400_000).toISOString();
  await store.insertSession({
    token: await digestToken(token), user_id: userId, expires_at: expires, created_at: new Date(nowMs).toISOString(),
  });
  return token;
}

async function registerAction(store, body, nowMs, today) {
  if (throttled(`register:${today}`, 120, 60_000, nowMs)) return bad('too_many_requests', 429);
  const username = normalizeUsername(body.username);
  if (!username) return bad('username_invalid');
  if (checkPassword(String(body.password ?? ''))) return bad('password_invalid');
  const display = normalizeDisplay(body.display, username);
  const user = await store.insertUser({
    id: newId(), username, display,
    pass_hash: await hashPassword(String(body.password)),
    created_at: new Date(nowMs).toISOString(), last_login: new Date(nowMs).toISOString(),
    fail_count: 0, locked_until: null,
  });
  if (!user) return bad('write_failed', 503);
  const token = await createSession(store, user.id, nowMs);
  return json({
    ok: true, token, user: publicUser(user),
    account: {
      day: today, cash: START_CASH, totalAssets: START_CASH, netAssets: START_CASH, totalDebt: 0,
      guaranteeRatio: null, leverage: 1, positions: [], debtBySymbol: [], floatPnl: 0, todayPnl: 0,
    },
  });
}

async function loginAction(store, body, nowMs) {
  if (throttled(`login:${Math.floor(nowMs / 60_000)}`, 120, 60_000, nowMs)) return bad('too_many_requests', 429);
  const username = normalizeUsername(body.username);
  if (!username) return bad('credential_invalid', 401);
  const user = await store.getUserByUsername(username);
  const valid = user ? await verifyPassword(String(body.password ?? ''), user.pass_hash) : false;
  if (!user || !valid) {
    if (user) {
      const count = Math.min(10, (user.fail_count ?? 0) + 1);
      await store.bumpFailure(user.id, count, count >= 5 ? new Date(nowMs + 15 * 60_000).toISOString() : null);
    }
    return bad('credential_invalid', 401);
  }
  if (user.locked_until && Date.parse(user.locked_until) > nowMs) return bad('account_locked', 429);
  const token = await createSession(store, user.id, nowMs);
  await store.touchLogin(user.id, new Date(nowMs).toISOString(), true);
  return json({ ok: true, token, user: publicUser(user) });
}

async function logoutAction(store, token) {
  if (token) await store.dropSession(await digestToken(token));
  return json({ ok: true });
}

async function requireUser(store, token, nowMs) {
  if (!token) throw UNAUTHED();
  const row = await store.getSession(await digestToken(token));
  if (!row || Date.parse(row.expires_at) <= nowMs) throw UNAUTHED();
  const user = await store.getUserById(row.user_id);
  if (!user) throw UNAUTHED();
  return user;
}

function publicUser(user) {
  return { id: user.id, username: user.username, display: user.display, created_at: user.created_at, last_login: user.last_login };
}

async function meAction(store, token, nowMs, today, clock, session, matchable) {
  const user = await requireUser(store, token, nowMs);
  const trades = await store.listTrades(user.id);
  const state = replay(trades, { nowMs, today });
  const quotes = await getQuotes(false, new Date(nowMs)).catch(() => new Map());
  await fillHeldQuotes(state, quotes, new Date(nowMs));
  return json({
    ok: true, user: publicUser(user),
    account: accountView(metricsOf(state, quotes, nowMs), today),
    market: publicMarket(quotes),
    clock, session, matchable, stale: quoteDay(quotes) !== today,
  });
}

function accountView(metrics, today) {
  return {
    day: today,
    cash: metrics.cash, longValue: metrics.longValue, shortValue: metrics.shortValue,
    collateral: metrics.collateral, totalAssets: metrics.totalAssets, totalDebt: metrics.totalDebt,
    netAssets: metrics.netAssets, marginPrincipal: metrics.marginPrincipal, marginInterest: metrics.marginInterest,
    marginBalance: metrics.marginBalance, securityBalance: metrics.securityBalance,
    guaranteeRatio: metrics.guaranteeRatio, leverage: metrics.leverage,
    floatPnl: metrics.floatPnl, realized: metrics.realized, todayPnl: metrics.todayPnl,
    feesPaid: metrics.feesPaid, tradeCount: metrics.tradeCount,
    positions: metrics.positions, debtBySymbol: metrics.debtBySymbol,
  };
}

async function fillHeldQuotes(state, quotes, now) {
  let extra = 0;
  for (const symbol of state.books.keys()) {
    if (quotes.has(symbol) || extra >= 12) continue;
    extra += 1;
    const quote = await ensureQuote(symbol, quotes, now);
    if (quote) quotes.set(symbol, quote);
  }
}

function quoteDay(quotes) {
  for (const quote of quotes.values()) {
    if (quote.ts > 0) return bjParts(new Date(quote.ts * 1000)).day;
  }
  return '';
}

// 同步 = 撮合一轮：过期撤单 → 挂单判定 → 强制平仓 → 日结快照
async function syncAction({ store, request, body, url, now, nowMs, today, clock, session, matchable }) {
  const user = await requireUser(store, tokenOf(body, url.searchParams, request), nowMs);
  const quotes = await getQuotes(false, now).catch(() => new Map());
  const stale = quoteDay(quotes) !== today;
  const trades = await store.listTrades(user.id);
  const state = replay(trades, { nowMs, today });
  await fillHeldQuotes(state, quotes, now);

  const orders = await store.listOpenOrders(user.id);
  const filled = [];
  const canceled = [];
  for (const order of orders) {
    if (order.status === 'filling') {
      const known = trades.find((trade) => trade.order_id === order.id);
      if (known) await store.patchOrder(order.id, { status: 'filled', updated_at: new Date(nowMs).toISOString() }, 'filling');
      else if (nowMs - Date.parse(order.updated_at) > 30_000) {
        await store.patchOrder(order.id, { status: 'open', updated_at: new Date(nowMs).toISOString() }, 'filling');
      }
      continue;
    }
    if (String(order.day) > today) continue; // 预埋单：归属未来交易日
    if (String(order.day) < today) {
      const done = await store.patchOrder(order.id, {
        status: 'canceled', reason: '当日有效，未成交部分已自动撤销', updated_at: new Date(nowMs).toISOString(),
      }, 'open');
      if (done) canceled.push(order.id);
      continue;
    }
    let quote = quotes.get(order.secid) ?? null;
    if (!quote) {
      quote = await ensureQuote(order.secid, quotes, now);
      if (quote) quotes.set(order.secid, quote);
    }
    if (!quote || !matchable || stale) continue;
    const verdict = judgeOrder(order, quote, state, quotes, { nowMs, today, tradableWindow: true, stale: false });
    if (verdict.action === 'hold') continue;
    const claimed = await store.claimOrder(order.id);
    if (!claimed) continue;
    if (verdict.action === 'reject') {
      await store.patchOrder(order.id, {
        status: 'rejected', reason: REASONS[verdict.code] ?? '废单', updated_at: new Date(nowMs).toISOString(),
      }, 'filling');
      continue;
    }
    const trade = { ...verdict.trade, id: newId(), order_id: order.id, user_id: user.id, source: order.source ?? 'user' };
    const inserted = await store.insertTrade(trade);
    await store.patchOrder(order.id, {
      status: 'filled', fill_price: trade.price, fill_qty: trade.qty, fill_fee: trade.fee,
      updated_at: new Date(nowMs).toISOString(),
    }, 'filling');
    if (inserted) {
      applyTrade(state, trade, nowMs, today);
      filled.push(trade);
    }
  }

  const metrics = metricsOf(state, quotes, nowMs);
  if (metrics.totalDebt > 0 && metrics.guaranteeRatio !== null && matchable && !stale) {
    const openSymbols = new Set(orders.map((order) => order.secid));
    if (metrics.guaranteeRatio < LINE_CALL) {
      await pushEvent(store, user.id, 'call', nowMs, today, guaranteeText(metrics), '');
      for (const plan of planLiquidation(metrics, { nowMs, today, openSymbols })) {
        const quote = quotes.get(plan.secid);
        await store.insertOrder({
          id: newId(), user_id: user.id, secid: plan.secid, code: quote?.code ?? plan.secid.split('.')[1],
          name: quote?.name ?? '', kind: quote?.kind ?? 'stock', side: plan.side, mode: 'market', qty: plan.qty,
          limit_price: null, leaf: 1, status: 'open', day: today, reason: plan.reason, source: 'system',
          fill_price: null, fill_qty: 0, fill_fee: 0,
          created_at: new Date(nowMs).toISOString(), updated_at: new Date(nowMs).toISOString(),
        });
        openSymbols.add(plan.secid);
        await pushEvent(store, user.id, 'liquidation', nowMs, `${today}:${plan.secid}`, guaranteeText(metrics), ` ${plan.qty} 股`);
      }
    } else if (metrics.guaranteeRatio < LINE_WARN) {
      await pushEvent(store, user.id, 'warn', nowMs, today, guaranteeText(metrics), '');
    }
  }

  await store.saveSnapshot({
    id: newId(), user_id: user.id, day: today,
    net_assets: metrics.netAssets, total_assets: metrics.totalAssets,
    cash: metrics.cash, total_debt: metrics.totalDebt,
    created_at: new Date(nowMs).toISOString(), updated_at: new Date(nowMs).toISOString(),
  });

  const [openOrders, recentTrades, recentEvents, curve, board, watch] = await Promise.all([
    store.listOpenOrders(user.id), store.listRecentTrades(user.id, 30),
    store.listEvents(user.id, 12), store.listSnapshots(user.id, 90),
    store.leaderboard(today, 20).catch(() => []), store.listWatch(user.id),
  ]);
  const watchQuotes = [];
  for (const item of watch.slice(0, 24)) {
    const quote = quotes.get(item.secid) ?? await ensureQuote(item.secid, quotes, now);
    if (quote) { if (!quotes.has(item.secid)) quotes.set(item.secid, quote); watchQuotes.push(quote); }
  }
  const names = await store.listUsernames(board.map((row) => row.user_id));

  return json({
    ok: true, clock, session, matchable, stale,
    market: publicMarket(quotes),
    account: accountView(metrics, today),
    curve: curve.map((row) => ({ day: row.day, netAssets: row.net_assets, totalAssets: row.total_assets, totalDebt: row.total_debt ?? 0 })),
    orders: openOrders.map(orderView),
    trades: recentTrades.map(tradeView),
    events: recentEvents.map((event) => ({ kind: event.kind, message: event.message, at: event.created_at })),
    leader: board.map((row) => ({
      name: names.get(row.user_id)?.display ?? '匿名', ret: row.net_assets / START_CASH - 1,
      netAssets: row.net_assets, mine: row.user_id === user.id,
    })),
    settled: filled.length, canceled: canceled.length,
    fills: filled.map(tradeView), watch, watchQuotes,
    user: publicUser(user),
  });
}

function guaranteeText(metrics) {
  return metrics.guaranteeRatio === null ? '—' : `${(metrics.guaranteeRatio * 100).toFixed(1)}%`;
}

async function pushEvent(store, userId, kind, nowMs, seed, ratioText, tail) {
  const message = kind === 'liquidation'
    ? `维持担保比例 ${ratioText}，已生成强制平仓委托：${tail} 股`
    : kind === 'call'
      ? `维持担保比例 ${ratioText}，已低于追保线 140%，请追加担保物或自行减仓`
      : `维持担保比例 ${ratioText}，已低于预警线 150%，请注意杠杆风险`;
  return store.insertEvent({
    id: newId(), user_id: userId, kind, message,
    dedup: `${kind}:${seed}`, created_at: new Date(nowMs).toISOString(),
  });
}

function orderView(order) {
  return {
    id: order.id, secid: order.secid, code: order.code, name: order.name, kind: order.kind, side: order.side,
    mode: order.mode, qty: order.qty, limitPrice: order.limit_price, leaf: order.leaf, status: order.status,
    day: order.day, reason: order.reason, source: order.source, created_at: order.created_at,
  };
}
function tradeView(trade) {
  return {
    id: trade.id, secid: trade.symbol, code: trade.code, name: trade.name, kind: trade.kind, side: trade.side,
    qty: trade.qty, price: trade.price, amount: trade.amount, fee: trade.fee, leaf: trade.leaf,
    day: trade.day, created_at: trade.created_at,
  };
}

// 试算与下单共用同一套校验，前端展示的预估成本永远等于后端真实结算口径
// 委托指纹：数量/类型/限价/杠杆，用来判定「完全相同的一笔」
function draftFingerprint(body) {
  return [Math.trunc(Number(body.qty)), body.mode === 'limit' ? 'L' : 'M',
    body.mode === 'limit' ? Math.trunc(Number(body.limitPrice) * 1000) : 0,
    Math.trunc(Number(body.leaf ?? 1))].join(':');
}

async function orderAction(store, previewOnly, { request, body, url, nowMs, today }) {
  const user = await requireUser(store, tokenOf(body, url.searchParams, request), nowMs);
  const secid = clampText(body.secid, 12);
  if (!/^[012]\.\d{6}$/.test(secid)) return bad('symbol_invalid');
  if (!previewOnly) {
    if (throttled(`order:${user.id}`, 30, 60_000, nowMs)) return bad('too_many_requests', 429);
    const key = `${user.id}|${String(body.side ?? '')}|${secid}|${draftFingerprint(body)}`;
    const last = recentSubmits.get(key);
    if (last && nowMs - last < DUPLICATE_WINDOW_MS && body.confirmDuplicate !== true) return bad('duplicate_order', 409);
    if (recentSubmits.size > 3000) {
      for (const [oldKey, at] of recentSubmits) if (nowMs - at > DUPLICATE_WINDOW_MS) recentSubmits.delete(oldKey);
    }
    recentSubmits.set(key, nowMs);
  }

  const rawLimit = body.limitPrice;
  const draft = {
    side: clampText(body.side, 16), secid,
    mode: body.mode === 'limit' ? 'limit' : 'market',
    qty: Math.trunc(Number(body.qty)),
    // 价格来自用户输入的十进制字符串：必须四舍五入，trunc 会把 4.06×1e6 削成 4059999
    limitPrice: rawLimit === null || rawLimit === undefined || rawLimit === '' ? null : Math.round(Number(rawLimit) * MICRO),
    leaf: Math.trunc(Number(body.leaf ?? 1)),
  };

  const now = new Date(nowMs);
  const quotes = await getQuotes(false, now).catch(() => null);
  if (!quotes || quotes.size === 0) return bad('quote_unavailable', 503);
  const trades = await store.listTrades(user.id);
  const state = replay(trades, { nowMs, today });
  await fillHeldQuotes(state, quotes, now);
  const quote = await ensureQuote(secid, quotes, now);
  if (quote && !quotes.has(secid)) quotes.set(secid, quote);

  const result = validateOrder(draft, {
    state, quotes, quote, nowMs, today, sessionFresh: quoteDay(quotes) === today,
  });
  if (!result.ok) return bad(result.code);
  if (previewOnly) return json({ ok: true, preview: { ...result.preview, side: draft.side, tradable: tradableOf(quote.kind) } });

  const validDay = validityDayOf(now);
  const order = await store.insertOrder({
    id: newId(), user_id: user.id, secid, code: quote.code, name: quote.name, kind: quote.kind,
    side: draft.side, mode: draft.mode, qty: draft.qty,
    limit_price: draft.mode === 'limit' ? draft.limitPrice : null, leaf: result.trade.leaf,
    status: 'open', day: validDay,
    reason: validDay > today ? `非交易时段挂单，${validDay} 开盘后参与撮合` : '', source: 'user',
    fill_price: null, fill_qty: 0, fill_fee: 0,
    created_at: new Date(nowMs).toISOString(), updated_at: new Date(nowMs).toISOString(),
  });
  if (!order) return bad('write_failed', 503);
  const metrics = metricsOf(state, quotes, nowMs);
  return json({
    ok: true, order: orderView(order), preview: result.preview,
    account: accountView(metrics, today), queued: validDay > today,
  });
}

async function watchSortAction(store, { request, body, url, nowMs }) {
  const user = await requireUser(store, tokenOf(body, url.searchParams, request), nowMs);
  const list = Array.isArray(body.secids) ? body.secids.slice(0, 80) : [];
  if (!list.length) return bad('symbol_invalid');
  const rows = await store.listWatch(user.id);
  const known = new Set(rows.map((row) => row.secid));
  const clean = list.filter((secid) => typeof secid === 'string' && known.has(secid));
  if (clean.length === 0) return bad('order_invalid');
  await store.sortWatch(user.id, clean.map((secid, index) => ({ secid, sort: (index + 1) * 1000 })));
  return json({ ok: true, watch: await store.listWatch(user.id) });
}

async function watchAction(store, mode, { request, body, url, nowMs, now }) {
  const user = await requireUser(store, tokenOf(body, url.searchParams, request), nowMs);
  const secid = clampText(body.secid, 12);
  if (!/^[012]\.\d{6}$/.test(secid)) return bad('symbol_invalid');
  let rows = [];
  if (mode === 'add') {
    const quotes = await getQuotes(false, now).catch(() => new Map());
    const quote = quotes.get(secid) ?? await ensureQuote(secid, quotes, now);
    if (!quote) return bad('unknown_symbol', 404);
    const rows = await store.listWatch(user.id);
    const top = rows.reduce((max, row) => Math.max(max, Number(row.sort) || 0), 0);
    await store.addWatch({
      id: newId(), user_id: user.id, secid, code: quote.code, name: quote.name, kind: quote.kind,
      sort: top + 1000, created_at: new Date(nowMs).toISOString(),
    });
  } else {
    await store.removeWatch(user.id, secid);
  }
  rows = await store.listWatch(user.id);
  return json({ ok: true, watch: rows, action: mode });
}

async function cancelAction(store, { request, body, url, nowMs }) {
  const user = await requireUser(store, tokenOf(body, url.searchParams, request), nowMs);
  const id = clampText(body.orderId, 40);
  if (!/^[0-9a-f-]{36}$/i.test(id)) return bad('order_invalid');
  const done = await store.patchOrder(id, { status: 'canceled', reason: '已手动撤单', updated_at: new Date(nowMs).toISOString() }, 'open');
  if (!done) return bad('cancel_failed', 409);
  return json({ ok: true, orders: (await store.listOpenOrders(user.id)).map(orderView) });
}
