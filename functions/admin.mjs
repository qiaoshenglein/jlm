// 后台管理：参数、审计与 admin_* 动作的实现集中在这里。
// 权限判定本身留在 api.mjs（它已有会话解析），这里只处理「已经确认是管理员」之后的事。
import { MICRO, START_CASH, START_CASH_USD, clampText, etParts, inRange, normalizeLines, setParams, startBaseOf } from './rules.mjs';
import { DEFAULT_PARAMS, DEFAULT_PARAMS_US, activeParams } from './rules.mjs';
import {
  QUOTE_HOSTS, QUOTE_PROBES, QUOTE_SOURCE_DEFAULTS, US_INDEXES, checkQuoteSource, fxSource, getFx, getQuotes, getUsQuotes,
  probeQuoteSource, quoteHealth, quoteProviders, quoteSource, setQuoteSource,
} from './quotes.mjs';
import { replay, startCashOf, tradesOf } from './ledger.mjs';
import { newId } from './auth.mjs';
import { applyBackup, exportBackup, inspectBackup, planBackup } from './backup.mjs';

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
  quote_source: QUOTE_SOURCE_DEFAULTS,
};

const SETTING_KEYS = Object.keys(SETTINGS_DEFAULTS);
const BOOL_KEYS = ['register_enabled', 'match_paused', 'match_paused_us'];
const CASH_KEYS = { start_cash: true, start_cash_usd: true };
// 挂牌参数按市场分列存储：改美股费用不会碰 A 股，反之亦然
const PARAM_KEYS = { params: 'cn', us_params: 'us' };
// JSON 结构体配置：写入前都要过各自的校验器，落库的值一定是合法值
const JSON_KEYS = { params: 'cn', us_params: 'us', quote_source: 'source' };
const DEFAULTS_OF = { cn: DEFAULT_PARAMS, us: DEFAULT_PARAMS_US };
const MAX_GRANT_MICRO = 1_000_000_000 * MICRO; // 单笔调整上限 10 亿（虚拟资金，防误操作）
const CHECKS_PER_MINUTE = 12;
// 备份：导出与预检各扫全库，导入更是整库重写——限频单独一档，且导入前必须先落快照
const BACKUP_PER_MINUTE = 8;
const BACKUP_APPLY_PER_MINUTE = 3;
const BACKUP_SCOPES = { data: true, config: true, audit: true, sessions: false };

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
  if (key === 'quote_source') {
    // 存进去之前已经校验过；这里再走一遍是为了兜住「手工改库」或「代码升级改了白名单」
    try {
      const parsed = JSON.parse(text);
      return checkQuoteSource(parsed && typeof parsed === 'object' ? parsed : {}).values;
    } catch {
      return { ...QUOTE_SOURCE_DEFAULTS, etfs: [...QUOTE_SOURCE_DEFAULTS.etfs] };
    }
  }
  return clampText(text, 32);
}

const encode = (key, value) => String(key in JSON_KEYS ? JSON.stringify(value)
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
  // 行情源同理：设置里存的就是引擎实际在用的域名与 TTL
  setQuoteSource(values.quote_source);
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

const fail = (code, status = 400, extra = null) => Object.assign(new Error(code), { code, status, extra });

// 检测会打真实上游，所以这里自带一个按管理员的滑动窗口限频（进程内计数，重启归零）
const windows = new Map();
function throttledHere(key, limit, windowMs, nowMs) {
  const hit = windows.get(key);
  if (!hit || nowMs - hit.at > windowMs) {
    if (windows.size > 2000) windows.clear();
    windows.set(key, { at: nowMs, n: 1 });
    return false;
  }
  hit.n += 1;
  return hit.n > limit;
}

const MARKET_LABEL = { cn: '沪深', us: '美股' };
let lastQuoteCheck = null;

// 概览只带够判断「行情是否正常」的几个字段，不搬运整个健康度对象
const pickHealth = (item) => ({
  ok: item.ok, fresh: item.fresh, rows: item.rows, note: item.note, partial: item.partial,
  dataAgeMinutes: item.dataAgeMinutes, staleWarn: item.staleWarn,
  sourceLabel: item.sourceLabel, fellBack: item.fellBack,
});

// 导出范围只认这四个开关，其它键名一律忽略（前端加字段不会意外多导表）
const pickScopes = (raw) => {
  const out = { ...BACKUP_SCOPES };
  for (const key of Object.keys(BACKUP_SCOPES)) {
    if (raw?.[key] !== undefined) out[key] = raw[key] === true;
  }
  return out;
};

function dayStartMs(today) {
  // today 形如 2026-11-04（北京日期）→ 该日 00:00 北京时间的 UTC 毫秒
  return Date.parse(`${today}T00:00:00+08:00`);
}

export async function runAdmin({ store, action, admin, body, nowMs, today, ip, files = null }) {
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
      // 行情源只读概览：不打上游，只报缓存里的事实；要看逐端点结果去「行情源」页点检测
      quote: {
        source: quoteSource().listHost,
        cn: pickHealth(quoteHealth('cn', new Date(nowMs))),
        us: pickHealth(quoteHealth('us', new Date(nowMs))),
        lastCheck: lastQuoteCheck,
      },
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
      const next = { ...before, params: { ...before.params }, us_params: { ...before.us_params }, quote_source: { ...before.quote_source, etfs: [...before.quote_source.etfs] } };
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
      // 行情源：域名必须在白名单里、数值必须在边界内，任何一项不合法就整次拒绝，
      // 并把不合法的项原样说回去（否则后台的「已保存」会是假象）
      if (patch.quote_source && typeof patch.quote_source === 'object') {
        const { values, rejected } = checkQuoteSource({ ...next.quote_source, ...patch.quote_source });
        if (rejected.length) throw fail('param_invalid', 400, { rejected });
        next.quote_source = values;
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
      // 行情源变更要单独留痕：换域名或放大池子都会改变上游压力与覆盖面
      for (const name of Object.keys(after.quote_source)) {
        const was = before.quote_source[name];
        const now = after.quote_source[name];
        if (JSON.stringify(was) !== JSON.stringify(now)) changed[`quote_source.${name}`] = now;
      }
      await writeAudit(store, { admin, action, target: 'settings', detail: { changed }, ip, nowMs });
      return {
        settings: after, params: activeParams('cn'), usParams: activeParams('us'),
        source: quoteSource(), changed,
      };
    }
    return {
      settings: await readSettingsCached(store, 0), defaults: SETTINGS_DEFAULTS,
      params: activeParams('cn'), usParams: activeParams('us'), source: quoteSource(),
    };
  }

  if (action === 'admin_quote_status') {
    const settings = await readSettingsCached(store, 0);
    const now = new Date(nowMs);
    return {
      source: quoteSource(),
      defaults: QUOTE_SOURCE_DEFAULTS,
      hosts: QUOTE_HOSTS,
      providers: quoteProviders(),
      probes: QUOTE_PROBES.map(({ key, label, note, provider, providerLabel, cap }) => ({ key, label, note, provider, providerLabel, cap })),
      health: { cn: quoteHealth('cn', now), us: quoteHealth('us', now) },
      fx: await getFx(now).catch(() => 0),
      fxSource: fxSource(),
      settings: { match_paused: settings.match_paused, match_paused_us: settings.match_paused_us },
      // 上一次检测的结果留在进程里：概览页要显示结论，但不该为此再打一次上游
      lastCheck: lastQuoteCheck,
    };
  }

  if (action === 'admin_quote_check') {
    // 一次检测 = 每家源的每项能力各打一次 + 两个市场的池子重建。
    // 各家并行、家内串行：坏主机通常是秒级拒连而不是超时，并行才不会把按钮按成转圈
    if (throttledHere(`quote:${admin.id}`, CHECKS_PER_MINUTE, 60_000, nowMs)) throw fail('too_many_requests', 429);
    const now = new Date(nowMs);
    const lanes = QUOTE_PROBES.reduce((out, item) => {
      (out[item.provider] ??= []).push(item);
      return out;
    }, {});
    const results = (await Promise.all(Object.values(lanes).map(async (lane) => {
      const rows = [];
      for (const item of lane) rows.push(await probeQuoteSource(item.key, now));
      return rows;
    }))).flat();
    // 探测单条通了不代表池子能建起来：再按线上路径强制重建一次，健康度才是真话
    await Promise.allSettled([getQuotes(true, now), getUsQuotes(true, now)]);
    const health = { cn: quoteHealth('cn', now), us: quoteHealth('us', now) };
    const byCap = results.reduce((out, row) => {
      (out[row.cap] ??= []).push(row);
      return out;
    }, {});
    const coverage = Object.entries(byCap).map(([cap, rows]) => ({
      cap,
      label: rows[0]?.label ?? cap,
      ok: rows.some((row) => row.ok),
      providers: rows.filter((row) => row.ok).map((row) => row.providerLabel),
      failures: rows.filter((row) => !row.ok).map((row) => `${row.providerLabel}:${row.error}`),
    }));
    const dead = coverage.filter((item) => !item.ok);
    const verdict = !coverage.some((item) => item.ok) ? 'down'
      : dead.length ? 'partial' : 'ok';
    const okCount = results.filter((row) => row.ok).length;
    const advice = [];
    const capDown = (cap) => dead.some((item) => item.cap === cap);
    const active = health.cn.sourceLabel || health.us.sourceLabel;
    if (health.cn.fellBack || health.us.fellBack) {
      advice.push(`已降级到 ${active ?? '备用源'}：东方财富本轮取不到，撮合与列表改用备用源的数据（字段口径已逐项实测核对）。`);
    }
    if (capDown('cnStocks')) advice.push('所有源的沪深池都取不到：A 股列表与撮合退到上一次快照，当日判定不通过时自动停撮合。');
    if (capDown('usStocks')) advice.push('所有源的美股池都取不到：美股退到上一次快照；降级时美股按持仓与自选逐个补价，没有持仓就只剩指数。');
    if (capDown('cnIndexes')) advice.push('指数全挂：顶部指数条为空，撮合不受影响。');
    if (capDown('one')) advice.push('单标的补价全挂：行情池外的标的（自选补价、按代码直查）取不到新价。');
    if (capDown('kline')) advice.push('日 K 全挂：蜡烛图显示「暂时取不到」，撮合与账本不受影响。');
    if (capDown('trends')) advice.push('分时全挂：分时图显示「暂时取不到」，撮合与账本不受影响。');
    if (capDown('suggest')) advice.push('检索全挂：搜索只能命中行情池内已有标的。');
    if (capDown('fx')) advice.push('汇率全挂：合并口径沿用上次值或兜底 6.7，只影响展示，不影响记账。');
    if (!capDown('fx') && byCap.fx.some((row) => row.ok && row.provider !== 'eastmoney')) {
      advice.push('汇率走了备用源：腾讯没有在岸/离岸之分的 USDCNH，用在岸 USDCNY 代替，只差几个基点，且只影响展示。');
    }
    const usIndexRows = byCap.usIndexes ?? [];
    const bestUsIndex = Math.max(0, ...usIndexRows.filter((row) => row.ok).map((row) => row.rows ?? 0));
    if (bestUsIndex > 0 && bestUsIndex < US_INDEXES.length) {
      advice.push(`美股指数最多只有 ${bestUsIndex}/${US_INDEXES.length} 条：板块池仍可用，指数条会缺项。`);
    }
    for (const item of [health.cn, health.us]) {
      if (!item.fresh) advice.push(`${MARKET_LABEL[item.market]}行情时间戳不在当日：本轮不撮合（休市、节假日或上游延迟），系统时间 ${item.today}，数据日 ${item.day || '空'}。`);
      else if (item.staleWarn) advice.push(`${MARKET_LABEL[item.market]}数据已落后 ${item.dataAgeMinutes} 分钟，超过告警阈值。`);
      else if (item.partial) advice.push(`${MARKET_LABEL[item.market]}部分降级：${item.partial}。`);
    }
    lastQuoteCheck = {
      at: stamp, verdict, okCount, total: results.length,
      slowest: results.reduce((max, row) => (row.ms > (max?.ms ?? -1) ? row : max), null)?.ms ?? 0,
      activeSource: active ?? null,
    };
    return {
      results, verdict, okCount, total: results.length, coverage, dead: dead.map((item) => item.cap),
      health, advice, source: quoteSource(), providers: quoteProviders(), checkedAt: stamp,
    };
  }

  if (action === 'admin_backup_export') {
    if (throttledHere(`backup:${admin.id}`, BACKUP_PER_MINUTE, 60_000, nowMs)) throw fail('too_many_requests', 429);
    const document = await exportBackup(store.sb, {
      include: pickScopes(body.include), now: new Date(nowMs),
      meta: { driver: store.sb.driver ?? null, schema: store.sb.schema ?? null, by: admin.username },
    });
    // 审计里只落「谁在什么时候导出了多少行、校验和是什么」，绝不落内容
    await writeAudit(store, {
      admin, action: 'admin_backup_export', target: `${document.rows} 行`,
      detail: { scopes: document.meta.scopes, counts: document.counts, checksum: document.checksum, bytes: document.bytes },
      ip, nowMs,
    });
    return { document, bytes: document.bytes, checksum: document.checksum, counts: document.counts, rows: document.rows };
  }

  if (action === 'admin_backup_preview') {
    if (throttledHere(`backup:pre:${admin.id}`, BACKUP_PER_MINUTE, 60_000, nowMs)) throw fail('too_many_requests', 429);
    const report = await inspectBackup(body.document);
    if (!report.ok) throw fail('backup_invalid', 400, { problems: report.problems });
    const plans = {};
    for (const mode of ['replace', 'config']) {
      if (report.modes[mode]) plans[mode] = await planBackup(store.sb, report, mode);
    }
    const admins = (report.tables.users ?? []).filter((row) => row.role === 'admin').length;
    const warnings = [...report.warnings];
    if (report.tables.users && !admins) {
      warnings.push('文件里没有任何 role=admin 的账户：导入后后台入口会关闭，直到重启时按 ADMIN_USERNAMES 重新授予。');
    }
    return {
      rows: report.rows, counts: report.counts, checksum: report.checksum, warnings, modes: report.modes,
      created_at: report.created_at, meta: report.meta, admins, plans,
    };
  }

  if (action === 'admin_backup_apply') {
    if (body.confirm !== true) throw fail('confirm_required', 400);
    // 模式必须显式给出：缺省或拼错都不能默认成「覆盖全站」这种破坏性最强的一档
    const mode = body.mode === 'config' || body.mode === 'replace' ? body.mode : null;
    if (!mode) throw fail('backup_mode_unavailable', 400, { mode: body.mode ?? null });
    if (typeof store.sb.withTx !== 'function') throw fail('backup_runtime_unsupported', 503);
    const report = await inspectBackup(body.document);
    if (!report.ok) throw fail('backup_invalid', 400, { problems: report.problems });
    if (!report.modes[mode]) throw fail('backup_mode_unavailable', 400, { mode });
    // 打字确认：要输入服务端刚算出的校验和前 6 位，等于「我看过这份预检结果了」
    const expect = String(report.checksum ?? '').slice(0, 6);
    if (String(body.ack ?? '').trim().toLowerCase() !== expect) throw fail('backup_ack_mismatch', 400, { expect });
    // 限频卡在校验之后、写盘之前：被拒的请求不该占用配额，但真正动库的必须计数
    if (throttledHere(`backup:apply:${admin.id}`, BACKUP_APPLY_PER_MINUTE, 60_000, nowMs)) throw fail('too_many_requests', 429);

    // 先落导入前快照，落不下去就不做覆盖——没有退路的写操作不执行。
    // 快照比常规导出多带一份会话摘要：真要回滚时，连「谁还登录着」都一起还原。
    let snapshot = null;
    try {
      const current = await exportBackup(store.sb, {
        include: { sessions: true }, now: new Date(nowMs), meta: { by: admin.username, reason: 'pre-import' },
      });
      snapshot = await files?.save?.(JSON.stringify(current));
    } catch { snapshot = null; }
    if (!snapshot) throw fail('backup_snapshot_failed', 503);

    const result = await applyBackup(store.sb, report, { mode, now: new Date(nowMs), actor: admin.username });
    invalidateSettings();
    await readSettingsCached(store, 0); // 新配置立即驱动撮合参数与行情源，不用重启
    // 导入可能把管理员角色一起覆盖掉；按 ADMIN_USERNAMES 立刻补授，否则操作者会被关在门外
    granted.clear();
    const regranted = (await ensureAdmins(store)).justGranted;
    await writeAudit(store, {
      admin, action: 'admin_backup_apply', target: `${mode} · ${report.rows} 行`,
      detail: {
        mode, checksum: report.checksum, applied: result.applied, cleared: result.cleared,
        snapshot: snapshot.path, took_ms: result.took_ms, reauth_required: result.reauth_required,
      },
      ip, nowMs,
    });
    return { ...result, snapshot, regranted };
  }

  if (action === 'admin_audit') {
    const limit = Math.min(200, Math.max(10, Number(body.limit) || 60));
    const offset = Math.max(0, Number(body.offset) || 0);
    return { rows: await store.listAudit(limit, offset) };
  }

  throw fail('not_found', 404);
}
