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
};

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
      .select('id,username,display,pass_hash,created_at,last_login,fail_count,locked_until')
      .eq('username', username).limit(1);
    const rows = fail(result, 'read_failed');
    return rows?.[0] ?? null;
  }

  async getUserById(id) {
    const result = await this.sb.from(TABLES.users)
      .select('id,username,display,pass_hash,created_at,last_login,fail_count,locked_until')
      .eq('id', id).maybeSingle();
    return fail(result, 'read_failed') ?? null;
  }

  async insertUser(row) {
    const result = await this.sb.from(TABLES.users).insert(row).select('id,username,display,created_at').maybeSingle();
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

  async insertOrder(row) {
    const result = await this.sb.from(TABLES.orders).insert(row).select(
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

  async leaderboard(day, limit = 30) {
    const result = await this.sb.from(TABLES.snapshots)
      .select('user_id,day,net_assets,total_assets,cash,total_debt')
      .eq('day', day).order('net_assets', { ascending: false }).limit(limit);
    return fail(result, 'read_failed') ?? [];
  }

  async listUsernames(ids) {
    if (!ids.length) return new Map();
    const result = await this.sb.from(TABLES.users)
      .select('id,display,username').in('id', ids).limit(ids.length);
    const rows = fail(result, 'read_failed') ?? [];
    return new Map(rows.map((row) => [row.id, row]));
  }
}
