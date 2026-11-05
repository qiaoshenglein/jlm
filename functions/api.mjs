// 应用路由：注册/登录、行情、下单试算、同步（撮合 + 风控 + 日结快照）。
// 写操作只接受 POST；请求体大小与字段都做白名单校验。
import {
  MICRO, LEAVES, START_CASH, START_CASH_USD, activeParams, bjParts, canMatch, etParts, marketOf, sessionOf,
  startBaseOf, usCanMatch, usSessionOf, usValidityDayOf, validityDayOf, clampText, tradableOf,
} from './rules.mjs';
import {
  KEY_INDEXES, US_INDEXES, ensureQuote, getFx, klineOf, quoteStatus, quoteStatusFor, quotesFor,
  searchSymbols, trendsOf,
} from './quotes.mjs';
import { Store } from './store.mjs';
import { MAX_QTY, REASONS, REASONS_US, judgeOrder, planLiquidation, reasonText, validateOrder } from './engine.mjs';
import { SIDE_LABELS, SIDES, applyTrade, marketOfTrade, metricsOf, replay, startCashOf, tradesOf } from './ledger.mjs';
import {
  checkPassword, digestToken, hashPassword, newId, newToken, normalizeDisplay, normalizeUsername, verifyPassword,
} from './auth.mjs';
import { ensureAdmins, readSettingsCached, runAdmin } from './admin.mjs';

const SESSION_DAYS = 30;
const json = (body, status = 200) => Response.json(body, {
  status, headers: { 'cache-control': 'no-store', 'content-type': 'application/json' },
});
const bad = (code, status = 400) => json({ ok: false, code }, status);

const READ_ACTIONS = new Set(['board', 'sync', 'me', 'chart', 'leader', 'rules', 'lookup', 'search',
  'admin_overview', 'admin_users', 'admin_user', 'admin_orders', 'admin_audit', 'admin_settings']);
const WRITE_ACTIONS = new Set(['register', 'login', 'logout', 'order', 'cancel', 'preview', 'watch_add', 'watch_remove', 'watch_sort',
  'admin_freeze', 'admin_unfreeze', 'admin_unlock', 'admin_revoke_sessions', 'admin_role', 'admin_grant_cash']);

const UNAUTHED = () => Object.assign(new Error('login_required'), { code: 'login_required', status: 401 });

// ---- 双市场基元：沪深（人民币）与美股（美元）各自成账，互不挪用 ----
export const MARKETS = ['cn', 'us'];
const SECID_PATTERN = /^(?:[012]\.\d{6}|1(?:0[567]|00)\.[A-Za-z][A-Za-z0-9.\-]{0,9})$/;
const validSecid = (text) => SECID_PATTERN.test(String(text ?? ''));
const marketOfSecid = (secid) => marketOf(String(secid ?? ''));
const normalizeMarket = (value) => (value === 'us' ? 'us' : 'cn');
const dayOfMarket = (market, now) => (market === 'us' ? etParts(now).day : bjParts(now).day);
const sessionOfMarket = (market, now) => (market === 'us' ? usSessionOf(now) : sessionOf(now));
const matchableMarket = (market, now, paused) => !paused && (market === 'us' ? usCanMatch(now) : canMatch(now));
const validityOfMarket = (market, now) => (market === 'us' ? usValidityDayOf(now) : validityDayOf(now));
const CURRENCY_LABEL = { cn: 'CNY', us: 'USD' };

// 行情是否属于本市场的当前交易日：休市日与节假日都落不到当天，撮合自然停
function quoteDayFor(quotes, market) {
  for (const quote of quotes?.values?.() ?? []) {
    if (quote.ts > 0) return dayOfMarket(market, new Date(quote.ts * 1000));
  }
  return '';
}

// 设置表读不到时按「未熔断」处理：行情与查询不该因为设置表出问题而停摆，撮合还有时段窗口兜底
const pausedFor = (settings, market) => Boolean(settings?.[market === 'us' ? 'match_paused_us' : 'match_paused']);

// 某个市场的一轮账本快照：行情 → 该市场流水重放 → 补取持仓行情
async function poolView(store, user, market, now) {
  const nowMs = now.getTime();
  const quotes = await quotesFor(market, false, now).catch(() => new Map());
  const day = dayOfMarket(market, now);
  const stale = quotes.size === 0 || quoteDayFor(quotes, market) !== day;
  const trades = tradesOf(await store.listTrades(user.id), market);
  const state = replay(trades, { nowMs, today: day, startCash: startCashOf(user, market) });
  await fillHeldQuotes(state, quotes, now);
  return { market, quotes, day, stale, state, trades, session: sessionOfMarket(market, now) };
}

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

export function publicMarket(quotes, market = 'cn') {
  const list = [...quotes.values()];
  if (market === 'us') {
    const indexes = US_INDEXES.map(([secid]) => quotes.get(secid)).filter(Boolean);
    const tradables = list.filter((quote) => quote.kind !== 'index');
    const stocks = tradables.filter((quote) => quote.kind === 'stock');
    const ranked = [...tradables].sort((a, b) => b.pct - a.pct);
    return {
      market: 'us', currency: 'USD',
      indexes: indexes.length ? indexes : list.filter((quote) => quote.kind === 'index'),
      etfs: tradables.filter((quote) => quote.kind === 'etf'),
      // 成交额前 200 名里 ETF 占了一半，个股标签只留真正的股票，否则两个标签看到的是同一份内容
      stocks: stocks.length ? stocks.slice(0, 60) : tradables.slice(0, 60),
      // 涨跌榜只在有流动性的池子（按成交额前 200）里排，否则会被仙股的三位数涨幅刷屏
      gainers: ranked.slice(0, 10),
      losers: ranked.slice(-10).reverse(),
      breadth: null, // 美股没有对应的涨跌家数接口，留空让前端隐藏这一条，不编造数字
      status: quoteStatusFor('us'),    };
  }
  const indexes = KEY_INDEXES.map(([secid]) => quotes.get(secid)).filter(Boolean);
  const stocks = list.filter((quote) => quote.kind === 'stock');
  const etfs = list.filter((quote) => quote.kind === 'etf');
  const ranked = [...stocks].sort((a, b) => b.pct - a.pct);
  return {
    market: 'cn', currency: 'CNY',
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

const RULES = (settings = null, market = 'cn') => ({
  startCash: START_CASH,
  startCashUsd: Number(settings?.start_cash_usd ?? START_CASH_USD),
  markets: MARKETS,
  cn: { ...activeParams('cn'), currency: 'CNY', lotSize: 100, tPlus1: true, dailyLimit: true, session: '北京时间 09:15–15:00' },
  us: { ...activeParams('us'), currency: 'USD', lotSize: 1, tPlus1: false, dailyLimit: false, session: '美东 09:30–16:00（自动跟夏令/冬令）' },
  leaves: LEAVES,
  maxQty: MAX_QTY,
  // 兼容旧字段：默认指向当前请求的市场，前端不再自己猜是哪一边
  market,
  lines: activeParams(market).lines,
  rates: activeParams(market).rates,
  fees: activeParams(market).fees,
  reasons: market === 'us' ? { ...REASONS, ...REASONS_US } : REASONS,
  sides: SIDES,
  labels: SIDE_LABELS,
});

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
  // 挂牌参数与熔断开关：读失败就用进程内当前值，行情与查询不该因为设置表出问题而停摆
  const settings = await readSettingsCached(store).catch(() => null);
  // 请求级市场上下文：所有动作按当前市场取时段、交易日与熔断状态
  const market = normalizeMarket(body.market ?? url.searchParams.get('market'));

  try {
    if (String(action).startsWith('admin_')) {
      const admin = await requireAdmin(store, tokenOf(body, url.searchParams, request), nowMs);
      if (throttled(`admin:${admin.id}`, 180, 60_000, nowMs)) return bad('too_many_requests', 429);
      const forwarded = (request.headers.get('x-forwarded-for') ?? '').split(',')[0].trim();
      const result = await runAdmin({
        store, action, admin, body, nowMs,
        // 后台的「当日」恒取北京日：日结快照与净值曲线都以北京日为轴，
        // 否则管理员把交易台停在美股页时，账户页会按美东日去找快照，整列净资产都空掉
        today: clock.day,
        ip: forwarded || (request.headers.get('cf-connecting-ip') ?? ''),
      });
      return json({ ok: true, action, ...result });
    }
    const ctx = { store, request, body, url, now, nowMs, clock, market, settings };
    switch (action) {
      case 'rules': return json({ ok: true, rules: RULES(ctx.settings, market) });
      case 'board': return await boardAction(ctx);
      case 'chart': return await chartAction(body);
      case 'lookup': return await lookupAction(body, now);
      case 'search': return await searchAction(body, now, market);
      // 排行榜按日结快照排名，而快照恒以「北京日」为键（两市合并折人民币），所以取日不跟随当前市场
      case 'leader': return await leaderAction(store, clock.day, await getFx(now));
      case 'register': return await registerAction(store, body, nowMs, ctx.settings);
      case 'login': return await loginAction(store, body, nowMs);
      case 'logout': return await logoutAction(store, tokenOf(body, url.searchParams, request));
      case 'me': return await meAction(ctx);
      case 'sync': return await syncAction(ctx);
      case 'preview': return await orderAction(true, ctx);
      case 'order': return await orderAction(false, ctx);
      case 'cancel': return await cancelAction(ctx);
      case 'watch_add': return await watchAction('add', ctx);
      case 'watch_remove': return await watchAction('remove', ctx);
      case 'watch_sort': return await watchSortAction(ctx);
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
  const secid = clampText(body.secid, 16);
  if (!validSecid(secid)) return bad('symbol_invalid');
  const target = marketOfSecid(secid);
  const quotes = await quotesFor(target, false, now).catch(() => new Map());
  const quote = quotes.get(secid) ?? await ensureQuote(secid, quotes, now);
  if (!quote) return bad('unknown_symbol', 404);
  return json({ ok: true, quote, market: target, currency: CURRENCY_LABEL[target] });
}

// 搜索跟随当前市场：在美股页输入「英伟达」不应该跳出 A 股同名缩写
async function searchAction(body, now, market) {
  const quotes = await quotesFor(market, false, now).catch(() => new Map());
  const rows = await searchSymbols(String(body.q ?? ''), quotes, now, market);
  return json({ ok: true, rows, market, currency: CURRENCY_LABEL[market] });
}

async function chartAction(body) {
  const secid = clampText(body.secid, 16);
  const kind = body.kind === 'kline' ? 'kline' : 'trends';
  if (!validSecid(secid)) return bad('symbol_invalid');
  const count = Math.min(320, Math.max(30, Number(body.count) || 120));
  const series = kind === 'kline' ? await klineOf(secid, count) : await trendsOf(secid);
  if (!series) return bad('chart_unavailable', 503);
  return json({ ok: true, secid, kind, market: marketOfSecid(secid), series });
}

// 折人民币口径的日结快照 → 排行榜本金也要同口径：开户时冻结的两笔本金都按当前汇率合并
async function leaderAction(store, day, fx) {
  const rows = await store.leaderboard(day, 30);
  const names = await store.listUsernames(rows.map((row) => row.user_id));
  return json({
    ok: true, day, fx, currency: 'CNY',
    rows: rows.map((row) => {
      const who = names.get(row.user_id);
      // 收益率按各自开户时冻结的本金算，后台改默认本金不会重算别人的历史成绩
      return {
        name: who?.display ?? '匿名',
        netAssets: row.net_assets,
        totalAssets: row.total_assets,
        totalDebt: row.total_debt ?? 0,
        ratio: row.total_debt > 0 ? row.total_assets / row.total_debt : null,
        ret: row.net_assets / startBaseOf(who, fx) - 1,
      };
    }),
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

async function registerAction(store, body, nowMs, cached) {
  const today = bjParts(new Date(nowMs)).day;
  if (throttled(`register:${today}`, 120, 60_000, nowMs)) return bad('too_many_requests', 429);
  // 写路径必须读到真实设置，缓存不可用时回读一次而不是用默认值放行注册
  const settings = cached ?? await readSettingsCached(store, 0);
  if (!settings.register_enabled) return bad('register_closed', 403);
  if (settings.invite_code && String(body.invite ?? '') !== settings.invite_code) return bad('invite_invalid', 403);
  const username = normalizeUsername(body.username);
  if (!username) return bad('username_invalid');
  if (checkPassword(String(body.password ?? ''))) return bad('password_invalid');
  const display = normalizeDisplay(body.display, username);
  const user = await store.insertUser({
    id: newId(), username, display,
    pass_hash: await hashPassword(String(body.password)),
    created_at: new Date(nowMs).toISOString(), last_login: new Date(nowMs).toISOString(),
    fail_count: 0, locked_until: null, role: 'user', status: 'active',
    // 两个子账户的本金都在开户时冻结，之后后台改默认值不会重写这个账户
    start_cash: settings.start_cash, start_cash_usd: settings.start_cash_usd,
  });
  if (!user) return bad('write_failed', 503);
  const token = await createSession(store, user.id, nowMs);
  return json({
    ok: true, token, user: publicUser(user),
    accounts: {
      cn: seedView(user, 'cn', nowMs),
      us: seedView(user, 'us', nowMs),
    },
  });
}

// 新账户的空账本：两个市场各自按冻结本金给一份初始快照，前端不用再猜默认值
function seedView(user, market, nowMs) {
  const day = dayOfMarket(market, new Date(nowMs));
  const metrics = metricsOf(replay([], { nowMs, today: day, startCash: startCashOf(user, market) }), new Map(), nowMs);
  return accountView(metrics, day, market);
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
  // 引导放在这里而不是只在启动时：名单里的账户可能是启动之后才注册的，
  // 否则会出现「没有入口 → 永远拿不到权限」的死锁。未配置 ADMIN_USERNAMES 时这里直接返回，零开销。
  await ensureAdmins(store);
  const row = await store.getSession(await digestToken(token));
  if (!row || Date.parse(row.expires_at) <= nowMs) throw UNAUTHED();
  const user = await store.getUserById(row.user_id);
  if (!user) throw UNAUTHED();
  return user;
}

// 后台权限只认这里：ADMIN_USERNAMES 未配置时整个后台关闭，公网裸奔也不会凭空多出管理口
const FORBIDDEN = () => Object.assign(new Error('not_admin'), { code: 'not_admin', status: 403 });

async function requireAdmin(store, token, nowMs) {
  const { configured } = await ensureAdmins(store);
  if (!configured) throw FORBIDDEN();
  const user = await requireUser(store, token, nowMs);
  if (user.role !== 'admin') throw FORBIDDEN();
  return user;
}

function publicUser(user) {
  return {
    id: user.id, username: user.username, display: user.display,
    created_at: user.created_at, last_login: user.last_login,
    role: user.role ?? 'user', status: user.status ?? 'active',
    startCash: startCashOf(user, 'cn'), startCashUsd: startCashOf(user, 'us'),
  };
}

async function boardAction({ store, request, body, url, now, nowMs, clock, market, settings }) {
  const quotes = await quotesFor(market, false, now).catch(() => new Map());
  const day = dayOfMarket(market, now);
  const paused = pausedFor(settings, market);
  return json({
    ok: true, clock, markets: marketsStatus(now, settings), activeMarket: market,
    market: publicMarket(quotes, market),
    session: sessionOfMarket(market, now), matchable: matchableMarket(market, now, paused),
    matchPaused: paused, stale: quotes.size === 0 || quoteDayFor(quotes, market) !== day, day,
  });
}

// 两个市场的时段状态一起下发：中美时段互补，晚上看美股时 A 股是收盘，顶栏要同时说清两件事
function marketsStatus(now, settings) {
  const out = {};
  for (const item of MARKETS) {
    const paused = pausedFor(settings, item);
    out[item] = {
      market: item, currency: CURRENCY_LABEL[item], day: dayOfMarket(item, now),
      session: sessionOfMarket(item, now), matchable: matchableMarket(item, now, paused), paused,
    };
  }
  return out;
}

async function poolsFor(store, user, now, settings) {
  const nowMs = now.getTime();
  const out = {};
  for (const item of MARKETS) {
    const pool = await poolView(store, user, item, now);
    pool.metrics = metricsOf(pool.state, pool.quotes, nowMs);
    pool.paused = pausedFor(settings, item);
    pool.matchable = matchableMarket(item, now, pool.paused);
    out[item] = pool;
  }
  return out;
}

// 另一个市场只给摘要：切过去才展开完整持仓，避免每次同步都拖两份簿面
const sideView = (metrics, day, item) => ({
  market: item, currency: CURRENCY_LABEL[item], day,
  cash: metrics.cash, totalAssets: metrics.totalAssets, netAssets: metrics.netAssets,
  totalDebt: metrics.totalDebt, guaranteeRatio: metrics.guaranteeRatio, leverage: metrics.leverage,
  positions: metrics.positions.length, startCash: metrics.startCash,
});

// 净值曲线与排行榜必须有一个可比的口径：美元池按当日汇率折成人民币合并。
// fx 本身也是微单位（6.67 美元/人民币 → 6.67e6），乘完必须再除一次 MICRO，否则量级会翻 100 万倍
const toCny = (microUsd, fx) => Math.round(microUsd * fx / MICRO);
const combinedNet = (pools, fx) => ({
  netAssets: pools.cn.metrics.netAssets + toCny(pools.us.metrics.netAssets, fx),
  totalAssets: pools.cn.metrics.totalAssets + toCny(pools.us.metrics.totalAssets, fx),
  cash: pools.cn.metrics.cash + toCny(pools.us.metrics.cash, fx),
  totalDebt: pools.cn.metrics.totalDebt + toCny(pools.us.metrics.totalDebt, fx),
  // 本金也合并：前端算总收益率时不需要自己再拼一次汇率
  startCash: pools.cn.metrics.startCash + toCny(pools.us.metrics.startCash, fx),
});

async function meAction({ store, request, body, url, now, nowMs, clock, market, settings }) {
  const user = await requireUser(store, tokenOf(body, url.searchParams, request), nowMs);
  const pools = await poolsFor(store, user, now, settings);
  const fx = await getFx(now);
  const active = pools[market];
  const other = pools[market === 'us' ? 'cn' : 'us'];
  return json({
    ok: true, user: publicUser(user),
    activeMarket: market, currency: CURRENCY_LABEL[market], fx,
    account: accountView(active.metrics, active.day, market),
    side: sideView(other.metrics, other.day, other.market),
    combined: combinedNet(pools, fx),
    market: publicMarket(active.quotes, market),
    clock, session: active.session, matchable: active.matchable, matchPaused: active.paused, stale: active.stale,
    markets: marketsStatus(now, settings), params: activeParams(market),
  });
}

function accountView(metrics, today, market = 'cn') {
  return {
    day: today, market, currency: CURRENCY_LABEL[market],
    cash: metrics.cash, longValue: metrics.longValue, shortValue: metrics.shortValue,
    collateral: metrics.collateral, totalAssets: metrics.totalAssets, totalDebt: metrics.totalDebt,
    netAssets: metrics.netAssets, marginPrincipal: metrics.marginPrincipal, marginInterest: metrics.marginInterest,
    startCash: metrics.startCash,
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

// 同步 = 两个市场各撮合一轮：过期撤单 → 挂单判定 → 强制平仓 → 合并日结快照
async function syncAction({ store, request, body, url, now, nowMs, clock, market, settings }) {
  const user = await requireUser(store, tokenOf(body, url.searchParams, request), nowMs);
  const pools = await poolsFor(store, user, now, settings);
  const fx = await getFx(now);
  const orders = await store.listOpenOrders(user.id);

  const filled = [];
  let canceled = 0;
  for (const item of MARKETS) {
    const pool = pools[item];
    const round = await matchMarketOrders(store, pool, user, orders, now, nowMs);
    filled.push(...round.filled);
    canceled += round.canceled;
    await riskRound(store, pool, user, round.matched, nowMs);
    pool.metrics = metricsOf(pool.state, pool.quotes, nowMs);
  }

  const active = pools[market];
  const other = pools[market === 'us' ? 'cn' : 'us'];
  const combined = combinedNet(pools, fx);

  // 日结快照恒以「北京日」为键、按人民币合并两市，净值曲线与排行榜因此始终只有一个可比口径
  await store.saveSnapshot({
    id: newId(), user_id: user.id, day: clock.day,
    net_assets: combined.netAssets, total_assets: combined.totalAssets,
    cash: combined.cash, total_debt: combined.totalDebt,
    created_at: new Date(nowMs).toISOString(), updated_at: new Date(nowMs).toISOString(),
  });

  const [openOrders, recentTrades, recentEvents, curve, board, watch] = await Promise.all([
    store.listOpenOrders(user.id), store.listRecentTrades(user.id, 40),
    store.listEvents(user.id, 12), store.listSnapshots(user.id, 90),
    store.leaderboard(clock.day, 20).catch(() => []), store.listWatch(user.id),
  ]);
  const inMarket = (secid) => marketOf(String(secid)) === market;
  const watchRows = watch.filter((row) => inMarket(row.secid));
  const watchQuotes = [];
  for (const item of watchRows.slice(0, 24)) {
    const quote = active.quotes.get(item.secid) ?? await ensureQuote(item.secid, active.quotes, now);
    if (quote) { if (!active.quotes.has(item.secid)) active.quotes.set(item.secid, quote); watchQuotes.push(quote); }
  }
  const names = await store.listUsernames(board.map((row) => row.user_id));

  return json({
    ok: true, clock, activeMarket: market, currency: CURRENCY_LABEL[market], fx,
    session: active.session, matchable: active.matchable, matchPaused: active.paused, stale: active.stale,
    markets: marketsStatus(now, settings),
    market: publicMarket(active.quotes, market),
    account: accountView(active.metrics, active.day, market),
    side: sideView(other.metrics, other.day, other.market),
    combined,
    curve: curve.map((row) => ({ day: row.day, netAssets: row.net_assets, totalAssets: row.total_assets, totalDebt: row.total_debt ?? 0 })),
    orders: openOrders.filter((order) => inMarket(order.secid)).map(orderView),
    trades: recentTrades.filter((trade) => inMarket(trade.symbol)).slice(0, 24).map(tradeView),
    events: recentEvents.map((event) => ({ kind: event.kind, message: event.message, at: event.created_at })),
    leader: board.map((row) => {
      const who = names.get(row.user_id);
      return {
        name: who?.display ?? '匿名', ret: row.net_assets / startBaseOf(who, fx) - 1,
        netAssets: row.net_assets, mine: row.user_id === user.id,
      };
    }),
    settled: filled.length, canceled, params: activeParams(market),
    fills: filled.map(tradeView), watch: watchRows, watchQuotes,
    user: publicUser(user),
  });
}

// 单个市场的一轮挂单处理：只消费属于本市场的委托，另一个市场的挂单原样留着
async function matchMarketOrders(store, pool, user, orders, now, nowMs) {
  const { market, quotes, day, stale, state } = pool;
  const filled = [];
  const canceled = [];
  const matched = [];
  for (const order of orders) {
    if (marketOf(order.secid) !== market) continue;
    matched.push(order);
    if (order.status === 'filling') {
      const known = pool.trades.find((trade) => trade.order_id === order.id);
      if (known) await store.patchOrder(order.id, { status: 'filled', updated_at: new Date(nowMs).toISOString() }, 'filling');
      else if (nowMs - Date.parse(order.updated_at) > 30_000) {
        await store.patchOrder(order.id, { status: 'open', updated_at: new Date(nowMs).toISOString() }, 'filling');
      }
      continue;
    }
    if (String(order.day) > day) continue; // 预埋单：归属未来交易日
    if (String(order.day) < day) {
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
    if (!quote || !pool.matchable || stale) continue;
    const verdict = judgeOrder(order, quote, state, quotes, { nowMs, today: day, tradableWindow: true, stale: false });
    if (verdict.action === 'hold') continue;
    const claimed = await store.claimOrder(order.id);
    if (!claimed) continue;
    if (verdict.action === 'reject') {
      await store.patchOrder(order.id, {
        status: 'rejected', reason: reasonText(verdict.code, market), updated_at: new Date(nowMs).toISOString(),
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
      applyTrade(state, trade, nowMs, day);
      filled.push(trade);
    }
  }
  return { filled, canceled, matched };
}

// 风控一轮：追保线以下生成强平委托，预警线以上只发一条提示。两市各用自己的担保线
async function riskRound(store, pool, user, matched, nowMs) {
  const metrics = metricsOf(pool.state, pool.quotes, nowMs);
  const lines = activeParams(pool.market).lines;
  if (metrics.totalDebt <= 0 || metrics.guaranteeRatio === null) return;
  if (!pool.matchable || pool.stale) return;
  if (metrics.guaranteeRatio >= lines.warn) return;
  const openSymbols = new Set(matched.map((order) => order.secid));
  const seed = `${pool.market}:${pool.day}`;

  if (metrics.guaranteeRatio >= lines.call) {
    await pushEvent(store, user.id, 'warn', nowMs, seed, guaranteeText(metrics), '', pool.market);
    return;
  }
  await pushEvent(store, user.id, 'call', nowMs, seed, guaranteeText(metrics), '', pool.market);
  for (const plan of planLiquidation(metrics, { nowMs, today: pool.day, openSymbols, market: pool.market })) {
    const quote = pool.quotes.get(plan.secid);
    await store.insertOrder({
      id: newId(), user_id: user.id, secid: plan.secid, code: quote?.code ?? plan.secid.split('.')[1],
      name: quote?.name ?? '', kind: quote?.kind ?? 'stock', side: plan.side, mode: 'market', qty: plan.qty,
      limit_price: null, leaf: 1, status: 'open', day: pool.day, reason: plan.reason, source: 'system',
      fill_price: null, fill_qty: 0, fill_fee: 0,
      created_at: new Date(nowMs).toISOString(), updated_at: new Date(nowMs).toISOString(),
    });
    openSymbols.add(plan.secid);
    await pushEvent(store, user.id, 'liquidation', nowMs, `${seed}:${plan.secid}`, guaranteeText(metrics), ` ${plan.qty} 股`, pool.market);
  }
}

function guaranteeText(metrics) {
  return metrics.guaranteeRatio === null ? '—' : `${(metrics.guaranteeRatio * 100).toFixed(1)}%`;
}

const MARKET_LABEL = { cn: '沪深账户', us: '美股账户' };

async function pushEvent(store, userId, kind, nowMs, seed, ratioText, tail, market = 'cn') {
  const lines = activeParams(market).lines;
  const pct = (value) => `${(value * 100).toFixed(0)}%`;
  const who = MARKET_LABEL[market] ?? '账户';
  const message = kind === 'liquidation'
    ? `${who}维持担保比例 ${ratioText}，已生成强制平仓委托：${tail} 股`
    : kind === 'call'
      ? `${who}维持担保比例 ${ratioText}，已低于追保线 ${pct(lines.call)}，请追加担保物或自行减仓`
      : `${who}维持担保比例 ${ratioText}，已低于预警线 ${pct(lines.warn)}，请注意杠杆风险`;
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
    market: marketOf(order.secid), currency: CURRENCY_LABEL[marketOf(order.secid)],
  };
}
function tradeView(trade) {
  return {
    id: trade.id, secid: trade.symbol, code: trade.code, name: trade.name, kind: trade.kind, side: trade.side,
    qty: trade.qty, price: trade.price, amount: trade.amount, fee: trade.fee, leaf: trade.leaf,
    day: trade.day, created_at: trade.created_at,
    market: marketOfTrade(trade), currency: CURRENCY_LABEL[marketOfTrade(trade)],
  };
}

// 试算与下单共用同一套校验，前端展示的预估成本永远等于后端真实结算口径
// 委托指纹：数量/类型/限价/杠杆，用来判定「完全相同的一笔」
function draftFingerprint(body) {
  return [Math.trunc(Number(body.qty)), body.mode === 'limit' ? 'L' : 'M',
    body.mode === 'limit' ? Math.trunc(Number(body.limitPrice) * 1000) : 0,
    Math.trunc(Number(body.leaf ?? 1))].join(':');
}

async function orderAction(previewOnly, { store, request, body, url, nowMs, settings }) {
  const user = await requireUser(store, tokenOf(body, url.searchParams, request), nowMs);
  // 冻结只挡新的风险敞口；撤单与查询仍然放行，避免把人困在已有持仓里
  if (user.status === 'frozen') return bad('account_frozen', 403);
  const secid = clampText(body.secid, 16);
  if (!validSecid(secid)) return bad('symbol_invalid');
  // 委托归属哪个市场由标的本身决定：前端切了市场也不会把美股单挂进人民币池
  const market = marketOfSecid(secid);
  if (!previewOnly && pausedFor(settings, market)) return bad('match_paused', 409);
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
  const day = dayOfMarket(market, now);
  const quotes = await quotesFor(market, false, now).catch(() => null);
  if (!quotes || quotes.size === 0) return bad('quote_unavailable', 503);
  const trades = tradesOf(await store.listTrades(user.id), market);
  const state = replay(trades, { nowMs, today: day, startCash: startCashOf(user, market) });
  await fillHeldQuotes(state, quotes, now);
  const quote = await ensureQuote(secid, quotes, now);
  if (quote && !quotes.has(secid)) quotes.set(secid, quote);

  const result = validateOrder(draft, {
    state, quotes, quote, nowMs, today: day, sessionFresh: quoteDayFor(quotes, market) === day,
  });
  if (!result.ok) {
    // 被规则拒绝的真委托也落一条废单：否则后台的「拒单原因分布」永远看不到任何样本，
    // 而 reason 沿用撮合侧的口径存中文文案，前端直接显示
    if (!previewOnly && quote) {
      await store.insertOrder({
        id: newId(), user_id: user.id, secid, code: quote.code, name: quote.name, kind: quote.kind,
        side: draft.side, mode: draft.mode, qty: draft.qty,
        limit_price: draft.mode === 'limit' ? draft.limitPrice : null, leaf: draft.leaf,
        status: 'rejected', day: validityOfMarket(market, now), reason: reasonText(result.code, market), source: 'user',
        fill_price: null, fill_qty: 0, fill_fee: 0,
        created_at: new Date(nowMs).toISOString(), updated_at: new Date(nowMs).toISOString(),
      });
    }
    return bad(result.code);
  }
  if (previewOnly) {
    return json({
      ok: true, market, currency: CURRENCY_LABEL[market],
      preview: { ...result.preview, side: draft.side, tradable: tradableOf(quote.kind) },
    });
  }

  const validDay = validityOfMarket(market, now);
  const order = await store.insertOrder({
    id: newId(), user_id: user.id, secid, code: quote.code, name: quote.name, kind: quote.kind,
    side: draft.side, mode: draft.mode, qty: draft.qty,
    limit_price: draft.mode === 'limit' ? draft.limitPrice : null, leaf: result.trade.leaf,
    status: 'open', day: validDay,
    reason: validDay > day ? `非交易时段挂单，${validDay} 开盘后参与撮合` : '', source: 'user',
    fill_price: null, fill_qty: 0, fill_fee: 0,
    created_at: new Date(nowMs).toISOString(), updated_at: new Date(nowMs).toISOString(),
  });
  if (!order) return bad('write_failed', 503);
  const metrics = metricsOf(state, quotes, nowMs);
  return json({
    ok: true, market, currency: CURRENCY_LABEL[market], order: orderView(order), preview: result.preview,
    account: accountView(metrics, day, market), queued: validDay > day,
  });
}

async function watchSortAction({ store, request, body, url, nowMs }) {
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

async function watchAction(mode, { store, request, body, url, nowMs, now }) {
  const user = await requireUser(store, tokenOf(body, url.searchParams, request), nowMs);
  const secid = clampText(body.secid, 16);
  if (!validSecid(secid)) return bad('symbol_invalid');
  const market = marketOfSecid(secid);
  if (mode === 'add') {
    const quotes = await quotesFor(market, false, now).catch(() => new Map());
    const quote = quotes.get(secid) ?? await ensureQuote(secid, quotes, now);
    if (!quote) return bad('unknown_symbol', 404);
    const existing = await store.listWatch(user.id);
    const top = existing.reduce((max, row) => Math.max(max, Number(row.sort) || 0), 0);
    await store.addWatch({
      id: newId(), user_id: user.id, secid, code: quote.code, name: quote.name, kind: quote.kind,
      sort: top + 1000, created_at: new Date(nowMs).toISOString(),
    });
  } else {
    await store.removeWatch(user.id, secid);
  }
  // 自选按市场分开返回：前端切到另一边时看到的是那一边的列表
  const rows = (await store.listWatch(user.id)).filter((row) => marketOf(row.secid) === market);
  return json({ ok: true, watch: rows, market, currency: CURRENCY_LABEL[market], action: mode });
}

async function cancelAction({ store, request, body, url, nowMs, market }) {
  const user = await requireUser(store, tokenOf(body, url.searchParams, request), nowMs);
  const id = clampText(body.orderId, 40);
  if (!/^[0-9a-f-]{36}$/i.test(id)) return bad('order_invalid');
  const done = await store.patchOrder(id, { status: 'canceled', reason: '已手动撤单', updated_at: new Date(nowMs).toISOString() }, 'open');
  if (!done) return bad('cancel_failed', 409);
  const orders = (await store.listOpenOrders(user.id)).filter((order) => marketOf(order.secid) === market);
  return json({ ok: true, orders: orders.map(orderView) });
}
