// 数据访问层：表名对应迁移里的 app.* 逻辑表；金额列为 bigint（微元）。
// 关键约束：trades.order_id 唯一 —— 同一笔委托只可能结算一次，多执行环境竞争时天然幂等。
const TABLES = {
  users: 'users',
  sessions: 'sessions',
  orders: 'orders',
  trades: 'trades',
  events: 'events',
  snapshots: 'snapshots',
  watchlists: 'watchlists',
  settings: 'settings',
  audit: 'audit',
  api_keys: 'api_keys',
};

const USER_COLUMNS = 'id,username,display,pass_hash,created_at,last_login,fail_count,locked_until,role,status,start_cash,start_cash_usd';
const ADMIN_USER_COLUMNS = 'id,username,display,created_at,last_login,fail_count,locked_until,role,status,start_cash,start_cash_usd';

// 后台搜索按字面匹配：转义 LIKE 的通配符，配合 db.mjs 里的 ESCAPE '\'
const likePattern = (text) => `%${String(text).replace(/[\\%_]/g, (char) => `\\${char}`)}%`;

export class StoreError extends Error {
  constructor(code, status = 503) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

function fail(result, code) {
  if (result && result.error) throw new StoreError(result.error.code === '23505' ? 'duplicate' : code);
  return result.data;
}

export class Store {
  constructor(supabase) {
    this.sb = supabase;
  }

  async getUserByUsername(username) {
    const result = await this.sb.from(TABLES.users)
      .select(USER_COLUMNS)
      .eq('username', username).limit(1);
    const rows = fail(result, 'read_failed');
    return rows?.[0] ?? null;
  }

  async getUserById(id) {
    const result = await this.sb.from(TABLES.users)
      .select(USER_COLUMNS)
      .eq('id', id).maybeSingle();
    return fail(result, 'read_failed') ?? null;
  }

  async insertUser(row) {
    const result = await this.sb.from(TABLES.users).insert(row)
      .select('id,username,display,created_at,role,status,start_cash,start_cash_usd').maybeSingle();
    if (result?.error?.code === '23505') throw new StoreError('username_taken', 409);
    return fail(result, 'write_failed');
  }

  async touchLogin(id, at, resetFail = false) {
    const patch = resetFail ? { last_login: at, fail_count: 0, locked_until: null } : { last_login: at };
    const result = await this.sb.from(TABLES.users).update(patch).eq('id', id).select('id').maybeSingle();
    return fail(result, 'write_failed');
  }

  async bumpFailure(id, failCount, lockedUntil) {
    const result = await this.sb.from(TABLES.users)
      .update({ fail_count: failCount, locked_until: lockedUntil }).eq('id', id).select('id').maybeSingle();
    return fail(result, 'write_failed');
  }

  async insertSession(row) {
    const result = await this.sb.from(TABLES.sessions).insert(row).select('token,user_id,expires_at').maybeSingle();
    return fail(result, 'write_failed');
  }

  async getSession(tokenHash) {
    const result = await this.sb.from(TABLES.sessions)
      .select('token,user_id,expires_at').eq('token', tokenHash).maybeSingle();
    return fail(result, 'read_failed') ?? null;
  }

  async dropSession(tokenHash) {
    const result = await this.sb.from(TABLES.sessions).delete().eq('token', tokenHash).select('token').maybeSingle();
    return fail(result, 'write_failed');
  }

  // 只取未失效的活跃委托，按创建顺序撮合
  async listOpenOrders(userId) {
    const result = await this.sb.from(TABLES.orders)
      .select('id,user_id,secid,code,name,kind,side,mode,qty,limit_price,leaf,status,day,reason,source,created_at,updated_at')
      .eq('user_id', userId).in('status', ['open', 'filling'])
      .order('created_at', { ascending: true }).order('id', { ascending: true })
      .limit(200);
    return fail(result, 'read_failed') ?? [];
  }

  async listTrades(userId) {
    const result = await this.sb.from(TABLES.trades)
      .select('id,order_id,user_id,symbol,code,name,kind,side,qty,price,amount,fee,leaf,day,created_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: true }).order('id', { ascending: true })
      .limit(5000);
    return fail(result, 'read_failed') ?? [];
  }

  async listRecentTrades(userId, limit = 40) {
    const result = await this.sb.from(TABLES.trades)
      .select('id,order_id,symbol,code,name,kind,side,qty,price,amount,fee,leaf,day,created_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false }).order('id', { ascending: false })
      .limit(limit);
    return fail(result, 'read_failed') ?? [];
  }

  // 单笔委托的当前状态：REST 下单后用它回答「到底成交了没有」
  async getOrder(id) {
    const result = await this.sb.from(TABLES.orders)
      .select('id,user_id,secid,code,name,kind,side,mode,qty,limit_price,leaf,status,day,reason,source,fill_price,fill_qty,fill_fee,created_at,updated_at')
      .eq('id', id).maybeSingle();
    return fail(result, 'read_failed') ?? null;
  }

  async insertOrder(row) {    const result = await this.sb.from(TABLES.orders).insert(row).select(
      'id,secid,code,name,kind,side,mode,qty,limit_price,leaf,status,day,reason,source,created_at,updated_at',
    ).maybeSingle();
    return fail(result, 'write_failed');
  }

  // 单行条件更新 = 比较并交换：只有把 open 改成 filling 的那一次请求返回行数，才拥有结算权
  async claimOrder(id) {
    const result = await this.sb.from(TABLES.orders)
      .update({ status: 'filling', updated_at: new Date().toISOString() })
      .eq('id', id).eq('status', 'open').select('id').maybeSingle();
    if (result && result.error) return null;
    return result?.data?.id ? id : null;
  }

  async patchOrder(id, patch, expectStatus) {
    let query = this.sb.from(TABLES.orders).update(patch).eq('id', id);
    if (expectStatus) query = query.eq('status', expectStatus);
    const result = await query.select('id').maybeSingle();
    if (result && result.error) return false;
    return Boolean(result?.data?.id);
  }

  // 成交记录只落库可重放的原始字段：own/borrow 等试算中间量由 leaf 推导，不单独存列
  async insertTrade(row) {
    const columns = ['id', 'order_id', 'user_id', 'symbol', 'code', 'name', 'kind', 'side',
      'qty', 'price', 'amount', 'fee', 'leaf', 'day', 'source', 'created_at'];
    const clean = Object.fromEntries(columns.filter((key) => row[key] !== undefined).map((key) => [key, row[key]]));
    const result = await this.sb.from(TABLES.trades).insert(clean).select('id,order_id').maybeSingle();
    if (result?.error?.code === '23505') return null; // 已有其他执行环境结算过
    return fail(result, 'write_failed');
  }

  async insertEvent(row) {
    const result = await this.sb.from(TABLES.events).insert(row).select('id').maybeSingle();
    if (result?.error?.code === '23505') return null;
    return fail(result, 'write_failed');
  }

  async listEvents(userId, limit = 20) {
    const result = await this.sb.from(TABLES.events)
      .select('id,kind,message,dedup,created_at')
      .eq('user_id', userId).order('created_at', { ascending: false }).limit(limit);
    return fail(result, 'read_failed') ?? [];
  }

  // 日终快照：按 (user_id, day) 唯一索引幂等 upsert，供净值曲线与排行榜使用
  async saveSnapshot(row) {
    const result = await this.sb.from(TABLES.snapshots)
      .upsert(row, { onConflict: 'user_id,day' })
      .select('id').maybeSingle();
    return fail(result, 'write_failed');
  }

  async listSnapshots(userId, limit = 120) {
    const result = await this.sb.from(TABLES.snapshots)
      .select('day,net_assets,total_assets,cash,total_debt,created_at')
      .eq('user_id', userId).order('day', { ascending: false }).limit(limit);
    const rows = fail(result, 'read_failed') ?? [];
    return rows.slice().sort((a, b) => String(a.day).localeCompare(String(b.day)));
  }

  async listWatch(userId) {
    const result = await this.sb.from(TABLES.watchlists)
      .select('id,secid,code,name,kind,sort,created_at')
      .eq('user_id', userId).order('sort', { ascending: true }).order('created_at', { ascending: true }).limit(80);
    return fail(result, 'read_failed') ?? [];
  }

  async addWatch(row) {
    const result = await this.sb.from(TABLES.watchlists).insert(row).select('id,secid,code,name,kind,created_at').maybeSingle();
    if (result?.error?.code === '23505') return null; // 已在自选里
    return fail(result, 'write_failed');
  }

  // 整表覆写顺序：一次同步里逐行写 sort，行数上限 80，失败可由前端重读纠正
  async sortWatch(userId, rows) {
    const results = [];
    for (const row of rows) {
      const result = await this.sb.from(TABLES.watchlists)
        .update({ sort: row.sort }).eq('user_id', userId).eq('secid', row.secid).select('id').maybeSingle();
      if (result && result.error) throw new StoreError(result.error.code ?? 'write_failed');
      results.push(Boolean(result?.data?.id));
    }
    return results;
  }

  async removeWatch(userId, secid) {
    const result = await this.sb.from(TABLES.watchlists).delete().eq('user_id', userId).eq('secid', secid).select('id').maybeSingle();
    if (result && result.error) throw new StoreError(result.error.code ?? 'write_failed');
    return Boolean(result?.data?.id);
  }

  // ── API 密钥：只存摘要，明文永不落库；撤销是打时间戳而不是删行，便于回看「谁在用什么」 ──
  async insertApiKey(row) {
    const result = await this.sb.from(TABLES.api_keys).insert(row)
      .select('id,user_id,name,hint,created_at').maybeSingle();
    if (result?.error?.code === '23505') throw new StoreError('duplicate', 409);
    return fail(result, 'write_failed');
  }

  async getApiKey(digest) {
    const result = await this.sb.from(TABLES.api_keys)
      .select('id,user_id,name,hint,created_at,last_used_at,revoked_at,calls').eq('digest', digest).maybeSingle();
    return fail(result, 'read_failed') ?? null;
  }

  async listApiKeys(userId) {
    const result = await this.sb.from(TABLES.api_keys)
      .select('id,name,hint,created_at,last_used_at,revoked_at,calls').eq('user_id', userId)
      .order('created_at', { ascending: false }).limit(50);
    return fail(result, 'read_failed') ?? [];
  }

  // 使用计数是读路径上的附带写，失败不能影响接口本身，所以这里不抛错
  async touchApiKey(id, at, calls) {
    const result = await this.sb.from(TABLES.api_keys).update({ last_used_at: at, calls }).eq('id', id).select('id').maybeSingle();
    return Boolean(result?.data?.id);
  }

  async revokeApiKey(id, userId, at) {
    // 重复撤销只是把时间戳再盖一次，没有副作用，所以不再额外加 IS NULL 条件（三种数据层写法不同）
    const result = await this.sb.from(TABLES.api_keys)
      .update({ revoked_at: at }).eq('id', id).eq('user_id', userId).select('id').maybeSingle();
    if (result && result.error) return false;
    return Boolean(result?.data?.id);
  }

  async leaderboard(day, limit = 30) {
    const result = await this.sb.from(TABLES.snapshots)
      .select('user_id,day,net_assets,total_assets,cash,total_debt')
      .eq('day', day).order('net_assets', { ascending: false }).limit(limit);
    return fail(result, 'read_failed') ?? [];
  }

  async listUsernames(ids) {
    if (!ids.length) return new Map();
    const result = await this.sb.from(TABLES.users)
      .select('id,display,username,start_cash,start_cash_usd').in('id', ids).limit(ids.length);
    const rows = fail(result, 'read_failed') ?? [];
    return new Map(rows.map((row) => [row.id, row]));
  }

  // ── 后台管理 ────────────────────────────────────────────────
  // 规模假设：自建部署按「几十到几百账户」设计，单次扫描上限 2000 行，
  // 超出通过 truncated 明确告知，绝不静默截断统计数字。
  // 后台路径一律不 select pass_hash，避免口令哈希进入可被日志/响应带出的代码路径。
  async scanUsers() {
    const result = await this.sb.from(TABLES.users)
      .select(ADMIN_USER_COLUMNS).order('created_at', { ascending: false }).limit(2000);
    return fail(result, 'read_failed') ?? [];
  }

  async getUserRow(id) {
    const result = await this.sb.from(TABLES.users).select(ADMIN_USER_COLUMNS).eq('id', id).maybeSingle();
    return fail(result, 'read_failed') ?? null;
  }

  // 构造器没有 or，用户名与昵称分两次查再在 JS 里合并（账户量级小，代价可忽略）
  async searchUsers(query) {
    const pattern = likePattern(query);
    const byName = await this.sb.from(TABLES.users).select(ADMIN_USER_COLUMNS).like('username', pattern).limit(200);
    const byDisplay = await this.sb.from(TABLES.users).select(ADMIN_USER_COLUMNS).like('display', pattern).limit(200);
    const merged = new Map();
    for (const row of [...(fail(byName, 'read_failed') ?? []), ...(fail(byDisplay, 'read_failed') ?? [])]) merged.set(row.id, row);
    return [...merged.values()].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  }

  async setUserRole(id, role) {
    const result = await this.sb.from(TABLES.users).update({ role }).eq('id', id).select('id').maybeSingle();
    return Boolean(result?.data?.id);
  }

  async setUserStatus(id, status) {
    const result = await this.sb.from(TABLES.users).update({ status }).eq('id', id).select('id').maybeSingle();
    return Boolean(result?.data?.id);
  }

  async clearLoginLock(id) {
    const result = await this.sb.from(TABLES.users)
      .update({ fail_count: 0, locked_until: null }).eq('id', id).select('id').maybeSingle();
    return Boolean(result?.data?.id);
  }

  async countAdmins() {
    const result = await this.sb.from(TABLES.users).select('id').eq('role', 'admin').limit(200);
    return (fail(result, 'read_failed') ?? []).length;
  }

  async dropUserSessions(userId) {
    const result = await this.sb.from(TABLES.sessions).delete().eq('user_id', userId).select('token');
    return (fail(result, 'read_failed') ?? []).length;
  }

  async lockedUsers(nowIso) {
    const result = await this.sb.from(TABLES.users).select('id').gt('locked_until', nowIso).limit(500);
    return (fail(result, 'read_failed') ?? []).length;
  }

  async dayStats(day) {
    const orderResult = await this.sb.from(TABLES.orders).select('id,status,reason').eq('day', day).limit(2000);
    const tradeResult = await this.sb.from(TABLES.trades).select('id,fee,amount').eq('day', day).limit(2000);
    const orders = fail(orderResult, 'read_failed') ?? [];
    const trades = fail(tradeResult, 'read_failed') ?? [];
    const count = (status) => orders.filter((row) => row.status === status).length;
    const reasons = {};
    for (const row of orders) {
      if (row.status !== 'rejected' || !row.reason) continue;
      reasons[row.reason] = (reasons[row.reason] ?? 0) + 1;
    }
    return {
      orders: orders.length,
      filled: count('filled'),
      rejected: count('rejected'),
      canceled: count('canceled'),
      live: orders.filter((row) => row.status === 'open' || row.status === 'filling').length,
      trades: trades.length,
      fees: trades.reduce((sum, row) => sum + Number(row.fee ?? 0), 0),
      turnover: trades.reduce((sum, row) => sum + Number(row.amount ?? 0), 0),
      reasons,
      truncated: orders.length >= 2000 || trades.length >= 2000,
    };
  }

  async listOrdersAdmin({ userId = null, day = null, status = null, limit = 50, offset = 0 } = {}) {
    let query = this.sb.from(TABLES.orders)
      .select('id,user_id,secid,code,name,kind,side,mode,qty,limit_price,leaf,status,day,reason,source,created_at,updated_at');
    if (userId) query = query.eq('user_id', userId);
    if (day) query = query.eq('day', day);
    if (status) query = query.eq('status', status);
    const result = await query.order('created_at', { ascending: false }).limit(limit).range(offset, offset + limit - 1);
    return fail(result, 'read_failed') ?? [];
  }

  async eventsSince(iso, limit = 200) {
    const result = await this.sb.from(TABLES.events)
      .select('id,user_id,kind,message,created_at').gte('created_at', iso)
      .order('created_at', { ascending: false }).limit(limit);
    return fail(result, 'read_failed') ?? [];
  }

  async snapshotsForDay(day) {
    const result = await this.sb.from(TABLES.snapshots)
      .select('user_id,day,net_assets,total_assets,cash,total_debt,updated_at').eq('day', day).limit(2000);
    const rows = fail(result, 'read_failed') ?? [];
    return new Map(rows.map((row) => [row.user_id, row]));
  }

  async getSettings() {
    const result = await this.sb.from(TABLES.settings).select('key,value,updated_by,updated_at').limit(200);
    return fail(result, 'read_failed') ?? [];
  }

  async setSetting(key, value, by, at) {
    const result = await this.sb.from(TABLES.settings)
      .upsert({ key, value, updated_by: by, updated_at: at }, { onConflict: 'key' })
      .select('key').maybeSingle();
    return fail(result, 'write_failed');
  }

  async insertAudit(row) {
    const result = await this.sb.from(TABLES.audit)
      .insert(row).select('id').maybeSingle();
    return fail(result, 'write_failed');
  }

  async listAudit(limit = 60, offset = 0) {
    const result = await this.sb.from(TABLES.audit)
      .select('id,actor_id,actor,action,target,detail,created_at')
      .order('created_at', { ascending: false }).limit(limit).range(offset, offset + limit - 1);
    return fail(result, 'read_failed') ?? [];
  }
}
