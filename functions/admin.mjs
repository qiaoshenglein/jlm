// 后台管理：参数、审计与 admin_* 动作的实现集中在这里。
// 权限判定本身留在 api.mjs（它已有会话解析），这里只处理「已经确认是管理员」之后的事。
import { MICRO, START_CASH, START_CASH_USD, clampText, etParts, inRange, normalizeLines, setParams, startBaseOf } from './rules.mjs';
import { DEFAULT_PARAMS, DEFAULT_PARAMS_US, activeParams } from './rules.mjs';
import { getFx } from './quotes.mjs';
import { replay, startCashOf, tradesOf } from './ledger.mjs';
import { newId } from './auth.mjs';

// 只允许「改了只影响未来」的键。开户本金的历史账户值冻结在 users.start_cash / start_cash_usd 里，
// 这里改的是「新账户默认值」，不会重写任何已存在的账本；已落库的成交与费用永不重算。
export const SETTINGS_DEFAULTS = {
  register_enabled: true,
  invite_code: '',
  start_cash: START_CASH,
  start_cash_usd: START_CASH_USD,
  match_paused: false,
  match_paused_us: false,
  params: DEFAULT_PARAMS,
  us_params: DEFAULT_PARAMS_US,
};

const SETTING_KEYS = Object.keys(SETTINGS_DEFAULTS);
const BOOL_KEYS = ['register_enabled', 'match_paused', 'match_paused_us'];
const CASH_KEYS = { start_cash: true, start_cash_usd: true };
// 挂牌参数按市场分列存储：改美股费用不会碰 A 股，反之亦然
const PARAM_KEYS = { params: 'cn', us_params: 'us' };
const DEFAULTS_OF = { cn: DEFAULT_PARAMS, us: DEFAULT_PARAMS_US };
const MAX_GRANT_MICRO = 1_000_000_000 * MICRO; // 单笔调整上限 10 亿（虚拟资金，防误操作）

// 分组深合并，缺项回落默认值：后台只改一条线时不会把其它线清空
function mergeParams(base, patch, market = 'cn') {
  const out = {};
  for (const group of Object.keys(base)) {
    const incoming = patch[group] ?? {};
    out[group] = { ...base[group] };
    for (const key of Object.keys(base[group])) {
      if (incoming[key] !== undefined && inRange(key, incoming[key], market)) out[group][key] = Number(incoming[key]);
    }
  }
  out.lines = normalizeLines(out.lines);
  return out;
}

function decode(key, raw) {
  const text = String(raw ?? '');
  if (BOOL_KEYS.includes(key)) return text === '1' || text === 'true';
  if (CASH_KEYS[key]) {
    const value = Math.trunc(Number(text));
    return Number.isFinite(value) && value > 0 && value <= MAX_GRANT_MICRO ? value : SETTINGS_DEFAULTS[key];
  }
  if (key in PARAM_KEYS) {
    const market = PARAM_KEYS[key];
    const defaults = DEFAULTS_OF[market];
    try {
      const parsed = JSON.parse(text);
      return mergeParams(defaults, parsed && typeof parsed === 'object' ? parsed : {}, market);
    } catch {
      return defaults;
    }
  }
  return clampText(text, 32);
}

const encode = (key, value) => String(key in PARAM_KEYS ? JSON.stringify(value)
  : BOOL_KEYS.includes(key) ? (value ? '1' : '0') : value ?? '');

export async function readSettings(store) {
  const values = { ...SETTINGS_DEFAULTS, params: DEFAULT_PARAMS, us_params: DEFAULT_PARAMS_US };
  const rows = await store.getSettings().catch(() => []);
  for (const row of rows ?? []) {
    if (SETTING_KEYS.includes(row.key)) values[row.key] = decode(row.key, row.value);
  }
  return values;
}

// 每个请求都要知道当前挂牌参数，所以给设置加一层短缓存；后台写入时立即失效。
const settingsCache = { at: 0, values: null };

export async function readSettingsCached(store, ttl = 2_000) {
  const now = Date.now();
  if (settingsCache.values && now - settingsCache.at < ttl) return settingsCache.values;
  const values = await readSettings(store);
  // 把挂牌参数交给规则层，撮合与试算用的是同一份；两市各一份，互不覆盖
  setParams(values.params, 'cn');
  setParams(values.us_params, 'us');
  settingsCache.at = now;
  settingsCache.values = values;
  return values;
}

export function invalidateSettings() {
  settingsCache.at = 0;
  settingsCache.values = null;
}

// ADMIN_USERNAMES 引导：把列出的已有用户名提升为 admin。
// 名单里还没注册的名字每次都会重新尝试，注册之后下一次后台请求即生效，无需重启。
const granted = new Set();
// 边缘运行时与 Node 都能读到：Deno.env / process.env
function envValue(name) {
  const fromProcess = globalThis.process?.env?.[name];
  if (fromProcess !== undefined) return fromProcess;
  return globalThis.Deno?.env?.get(name);
}

export function adminNames() {
  return String(envValue('ADMIN_USERNAMES') ?? '').split(',').map((item) => item.trim()).filter(Boolean);
}

export async function ensureAdmins(store) {
  const names = adminNames();
  const justGranted = [];
  for (const name of names) {
    if (granted.has(name)) continue;
    const user = await store.getUserByUsername(name);
    if (!user) continue;
    if (user.role !== 'admin') await store.setUserRole(user.id, 'admin');
    granted.add(name);
    justGranted.push(user.username);
  }
  return { configured: names.length > 0, justGranted };
}

export async function writeAudit(store, { admin, action, target, detail, ip, nowMs }) {
  await store.insertAudit({
    id: newId(),
    actor_id: admin?.id ?? null,
    actor: admin?.display ?? admin?.username ?? null,
    action,
    target: clampText(String(target ?? ''), 64) || null,
    // 只落参数快照：口令、令牌、pass_hash 一律不进审计
    detail: detail ? JSON.stringify(detail).slice(0, 900) : null,
    ip: clampText(String(ip ?? ''), 45) || null,
    created_at: new Date(nowMs).toISOString(),
  });
}

const fail = (code, status = 400) => Object.assign(new Error(code), { code, status });

function dayStartMs(today) {
  // today 形如 2026-11-04（北京日期）→ 该日 00:00 北京时间的 UTC 毫秒
  return Date.parse(`${today}T00:00:00+08:00`);
}

export async function runAdmin({ store, action, admin, body, nowMs, today, ip }) {
  const stamp = new Date(nowMs).toISOString();

  if (action === 'admin_overview') {
    const users = await store.scanUsers();
    const stats = await store.dayStats(today);
    const since = dayStartMs(today);
    const fresh = users.filter((row) => Date.parse(row.created_at) >= since).length;
    const snaps = await store.snapshotsForDay(today);
    const live = activeParams('cn').lines;
    const usLines = activeParams('us').lines;
    // 快照是「两市折人民币合并」的一份账，担保比例按合并口径算，判定阈值以沪深线为准
    let belowCall = 0;
    let belowLiquid = 0;
    for (const snap of snaps.values()) {
      if (!snap.total_debt || snap.total_debt <= 0) continue;
      const ratio = snap.total_assets / snap.total_debt;
      if (ratio < live.liquid) belowLiquid += 1;
      else if (ratio < live.call) belowCall += 1;
    }
    const settings = await readSettingsCached(store);
    return {
      accounts: users.length,
      newToday: fresh,
      admins: await store.countAdmins(),
      locked: await store.lockedUsers(stamp),
      activeToday: users.filter((row) => row.last_login && Date.parse(row.last_login) >= since).length,
      settings,
      defaults: SETTINGS_DEFAULTS,
      params: live,
      usParams: usLines,
      // 熔断是分市场的：概览里两条都要露出来，否则「美股还在撮合」看不出来
      breakers: { cn: Boolean(settings.match_paused), us: Boolean(settings.match_paused_us) },
      risk: { belowCall, belowLiquid, leveraged: [...snaps.values()].filter((snap) => snap.total_debt > 0).length },
      stats,
      recent: await store.listAudit(8, 0),
    };
  }

  if (action === 'admin_users') {
    const query = clampText(String(body.q ?? ''), 24);
    const all = query ? await store.searchUsers(query) : await store.scanUsers();
    const snaps = await store.snapshotsForDay(today);
    const fx = await getFx(new Date(nowMs));
    const rows = all.slice(0, 200).map((user) => {
      const snap = snaps.get(user.id);
      const net = snap?.net_assets ?? null;
      // 本金基准与排行榜同口径：人民币本金 + 美元本金折人民币
      const base = startBaseOf(user, fx);
      return {
        id: user.id, username: user.username, display: user.display, role: user.role ?? 'user',
        status: user.status ?? 'active', created_at: user.created_at, last_login: user.last_login,
        fail_count: user.fail_count ?? 0, locked_until: user.locked_until ?? null,
        start_cash: Number(user.start_cash ?? SETTINGS_DEFAULTS.start_cash),
        start_cash_usd: Number(user.start_cash_usd ?? SETTINGS_DEFAULTS.start_cash_usd),
        base,
        net_assets: net, total_assets: snap?.total_assets ?? null,
        total_debt: snap?.total_debt ?? 0,
        ret: net !== null && base > 0 ? net / base - 1 : null,
        ratio: snap && snap.total_debt > 0 ? snap.total_assets / snap.total_debt : null,
      };
    });
    return { rows: rows.sort((a, b) => (b.net_assets ?? 0) - (a.net_assets ?? 0)), total: all.length, day: today, fx };
  }

  if (action === 'admin_user') {
    const userId = clampText(String(body.userId ?? ''), 40);
    const user = await store.getUserRow(userId);
    if (!user) throw fail('unknown_user', 404);
    const snaps = await store.snapshotsForDay(today);
    return {
      user,
      snapshot: snaps.get(userId) ?? null,
      orders: await store.listOrdersAdmin({ userId, limit: 20 }),
      trades: (await store.listRecentTrades(userId, 20)) ?? [],
      events: (await store.listEvents(userId, 20)) ?? [],
    };
  }

  if (action === 'admin_freeze' || action === 'admin_unfreeze') {
    const userId = clampText(String(body.userId ?? ''), 40);
    if (body.confirm !== true) throw fail('confirm_required', 400);
    const user = await store.getUserRow(userId);
    if (!user) throw fail('unknown_user', 404);
    const status = action === 'admin_freeze' ? 'frozen' : 'active';
    await store.setUserStatus(userId, status);
    await writeAudit(store, { admin, action, target: user.username, detail: { status }, ip, nowMs });
    return { id: userId, status };
  }

  if (action === 'admin_unlock') {
    const userId = clampText(String(body.userId ?? ''), 40);
    const user = await store.getUserRow(userId);
    if (!user) throw fail('unknown_user', 404);
    await store.clearLoginLock(userId);
    await writeAudit(store, { admin, action, target: user.username, detail: { fail_count: user.fail_count }, ip, nowMs });
    return { id: userId, unlocked: true };
  }

  if (action === 'admin_revoke_sessions') {
    const userId = clampText(String(body.userId ?? ''), 40);
    if (body.confirm !== true) throw fail('confirm_required', 400);
    const user = await store.getUserRow(userId);
    if (!user) throw fail('unknown_user', 404);
    const dropped = await store.dropUserSessions(userId);
    await writeAudit(store, { admin, action, target: user.username, detail: { dropped }, ip, nowMs });
    return { id: userId, dropped };
  }

  if (action === 'admin_role') {
    const userId = clampText(String(body.userId ?? ''), 40);
    const role = body.role === 'admin' ? 'admin' : 'user';
    if (body.confirm !== true) throw fail('confirm_required', 400);
    const user = await store.getUserRow(userId);
    if (!user) throw fail('unknown_user', 404);
    if (role === 'user' && user.role === 'admin' && (await store.countAdmins()) <= 1) throw fail('last_admin', 409);
    await store.setUserRole(userId, role);
    if (role === 'admin') granted.add(user.username);
    await writeAudit(store, { admin, action, target: user.username, detail: { from: user.role, to: role }, ip, nowMs });
    return { id: userId, role };
  }

  if (action === 'admin_grant_cash') {
    const userId = clampText(String(body.userId ?? ''), 40);
    const side = body.side === 'out' ? 'capital_out' : 'capital_in';
    // 资金调整按市场落到各自的现金池：kind 是美元池的唯一标识
    const market = body.market === 'us' ? 'us' : 'cn';
    const yuan = Number(body.amount);
    if (body.confirm !== true) throw fail('confirm_required', 400);
    if (!Number.isFinite(yuan) || Math.abs(yuan) < 0.01) throw fail('amount_invalid');
    const micro = Math.round(Math.abs(yuan) * MICRO);
    if (micro > MAX_GRANT_MICRO) throw fail('amount_invalid');
    const user = await store.getUserRow(userId);
    if (!user) throw fail('unknown_user', 404);
    const day = market === 'us' ? etParts(new Date(nowMs)).day : today;
    const trades = tradesOf(await store.listTrades(userId), market);
    const state = replay(trades, { nowMs, today: day, startCash: startCashOf(user, market) });
    if (side === 'capital_out' && micro > state.cash) throw fail('cash_short', 409);
    const reason = clampText(String(body.reason ?? ''), 40);
    // 只追加：调整成为流水里的一条资金进出，历史仍然可以从零重放
    const row = await store.insertTrade({
      id: newId(), order_id: null, user_id: userId, symbol: 'capital', code: '',
      name: side === 'capital_in' ? '后台入金' : '后台出金', kind: market === 'us' ? 'cash_usd' : 'cash',
      side, qty: 0, price: 0, amount: micro, fee: 0, leaf: 1, day, source: 'admin', created_at: stamp,
    });
    if (!row) throw fail('write_failed', 503);
    await writeAudit(store, {
      admin, action, target: user.username,
      detail: { market, side, amount: micro / MICRO, reason, cashBefore: state.cash / MICRO }, ip, nowMs,
    });
    return {
      id: userId, market, currency: market === 'us' ? 'USD' : 'CNY', side, amount: micro,
      cashBefore: state.cash, cashAfter: state.cash + (side === 'capital_in' ? micro : -micro),
    };
  }

  if (action === 'admin_orders') {
    const limit = Math.min(100, Math.max(10, Number(body.limit) || 30));
    const offset = Math.max(0, Number(body.offset) || 0);
    const userId = body.userId ? clampText(String(body.userId), 40) : null;
    const day = body.day ? clampText(String(body.day), 10) : null;
    const status = ['open', 'filling', 'filled', 'canceled', 'rejected'].includes(body.status) ? String(body.status) : null;
    const rows = await store.listOrdersAdmin({ userId, day, status, limit, offset });
    const names = await store.listUsernames([...new Set(rows.map((row) => row.user_id))]);
    return {
      // 没有 count 聚合，就用「本页取满则可能还有下一页」来判断翻页，不谎报总数
      rows: rows.map((row) => ({
        ...row, who: names.get(row.user_id)?.display ?? '匿名',
        price: row.limit_price ?? row.fill_price, fee: row.fill_fee ?? 0,
      })),
      limit, offset, day: day ?? today, stats: await store.dayStats(day ?? today), hasMore: rows.length === limit,
    };
  }

  if (action === 'admin_settings') {
    if (body.patch && typeof body.patch === 'object') {
      if (body.confirm !== true) throw fail('confirm_required', 400);
      const patch = body.patch;
      const before = await readSettings(store);
      const next = { ...before, params: { ...before.params }, us_params: { ...before.us_params } };
      for (const key of ['register_enabled', 'invite_code', 'start_cash', 'start_cash_usd', 'match_paused', 'match_paused_us']) {
        if (patch[key] === undefined) continue;
        let value = patch[key];
        if (CASH_KEYS[key]) {
          // 后台填的是「元/美元」面上的数，落库统一放大到微单位
          const micro = Math.round(Number(value) * MICRO);
          if (!Number.isFinite(micro) || micro <= 0 || micro > MAX_GRANT_MICRO) throw fail('amount_invalid');
          value = micro;
        }
        // 整次保存先校验后写入，避免「一半落库一半被拒」的中间态
        if (key === 'invite_code') value = clampText(String(value ?? ''), 32);
        if (BOOL_KEYS.includes(key)) value = value === true || value === 'true';
        next[key] = value;
      }
      // 挂牌参数：两市各一组，逐项校验，非法值明确拒绝而不是悄悄丢掉，
      // 否则后台显示的「已保存」会是假象
      for (const [key, market] of Object.entries(PARAM_KEYS)) {
        const incoming = patch[key];
        if (incoming === undefined || incoming === null || typeof incoming !== 'object') continue;
        const merged = { ...next[key] };
        for (const group of ['fees', 'rates', 'lines']) {
          const part = incoming[group] ?? {};
          const target = { ...merged[group] };
          for (const [name, value] of Object.entries(part)) {
            if (!(name in DEFAULTS_OF[market][group]) || !inRange(name, value, market)) throw fail('param_invalid');
            target[name] = Number(value);
          }
          merged[group] = target;
        }
        // 只对担保线做次序归一化，费率与利率原样保留；先全部校验再一次性落库
        next[key] = { ...merged, lines: normalizeLines(merged.lines) };
      }
      for (const key of SETTING_KEYS) await store.setSetting(key, encode(key, next[key]), admin.id, stamp);
      invalidateSettings();
      const after = await readSettingsCached(store, 0);
      const changed = {};
      for (const key of ['register_enabled', 'invite_code', 'start_cash', 'start_cash_usd', 'match_paused', 'match_paused_us']) {
        if (String(before[key]) !== String(after[key])) changed[key] = after[key];
      }
      for (const key of Object.keys(PARAM_KEYS)) {
        for (const group of ['fees', 'rates', 'lines']) {
          const part = {};
          for (const name of Object.keys(after[key][group])) {
            if (before[key][group][name] !== after[key][group][name]) part[name] = after[key][group][name];
          }
          if (Object.keys(part).length) changed[`${key}.${group}`] = part;
        }
      }
      await writeAudit(store, { admin, action, target: 'settings', detail: { changed }, ip, nowMs });
      return {
        settings: after, params: activeParams('cn'), usParams: activeParams('us'), changed,
      };
    }
    return {
      settings: await readSettingsCached(store, 0), defaults: SETTINGS_DEFAULTS,
      params: activeParams('cn'), usParams: activeParams('us'),
    };
  }

  if (action === 'admin_audit') {
    const limit = Math.min(200, Math.max(10, Number(body.limit) || 60));
    const offset = Math.max(0, Number(body.offset) || 0);
    return { rows: await store.listAudit(limit, offset) };
  }

  throw fail('not_found', 404);
}
