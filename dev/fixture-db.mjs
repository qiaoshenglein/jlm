// 本地调试用的内存数据库，模仿 PostgREST 的查询构造器与唯一约束冲突语义。
// 只存在于 dev/，不会进入发布包；线上走 adapter.mjs 注入的真实客户端。
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const STATE_FILE = fileURLToPath(new URL('./.local-db.json', import.meta.url));

const UNIQUE = {
  users: [['username']],
  sessions: [],
  orders: [],
  trades: [['order_id']],
  events: [['user_id', 'dedup']],
  snapshots: [['user_id', 'day']],
  watchlists: [['user_id', 'secid']],
  settings: [['key']],
  audit: [],
};
const PRIMARY = {
  users: 'id', sessions: 'token', orders: 'id', trades: 'id', events: 'id', snapshots: 'id',
  watchlists: 'id', settings: 'key', audit: 'id',
};

const clone = (value) => JSON.parse(JSON.stringify(value));

// 与 schema 里的 DEFAULT 对齐：调用方没写权限列时也要拿到值，否则后台测试会对着 undefined 断言
const COLUMN_DEFAULTS = { users: { role: 'user', status: 'active' } };

export function createFixtureDb({ persist = true } = {}) {
  const tables = new Map(Object.keys(UNIQUE).map((name) => [name, []]));
  if (persist && existsSync(STATE_FILE)) {
    try {
      const saved = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
      for (const [name, rows] of Object.entries(saved)) if (tables.has(name)) tables.set(name, rows);
    } catch { /* 起步状态损坏时直接忽略，重建空表 */ }
  }
  const save = () => {
    if (!persist) return;
    try { writeFileSync(STATE_FILE, JSON.stringify(Object.fromEntries(tables))); } catch { /* 落盘失败不影响调试 */ }
  };

  const conflict = (table, row, ignoreId) => {
    for (const keys of [...(UNIQUE[table] ?? []), [PRIMARY[table]]].filter(Boolean)) {
      if (keys.some((key) => row[key] === undefined || row[key] === null)) continue;
      const hit = tables.get(table).find((existing) => existing !== ignoreId
        && keys.every((key) => String(existing[key]) === String(row[key])));
      if (hit) return { code: '23505', message: `duplicate key value violates unique constraint "${table}_${keys.join('_')}"` };
    }
    return null;
  };

  return {
    stats() {
      return Object.fromEntries([...tables].map(([name, rows]) => [name, rows.length]));
    },
    from(name) {
      const table = tables.get(name);
      if (!table) throw new Error(`missing_table:${name}`);
      return new Builder(name, table, conflict, save);
    },
  };
}

class Builder {
  constructor(name, table, conflict, save) {
    this.name = name;
    this.table = table;
    this.conflict = conflict;
    this.save = save;
    this.op = 'select';
    this.columns = null;
    this.filters = [];
    this.orders = [];
    this.count = Infinity;
    this.payload = null;
    this.onConflict = null;
    this.one = false;
  }

  select(columns) { this.columns = String(columns ?? '').split(',').map((c) => c.trim()).filter(Boolean); return this; }
  insert(payload) { this.op = 'insert'; this.payload = payload; return this; }
  upsert(payload, { onConflict } = {}) { this.op = 'upsert'; this.payload = payload; this.onConflict = onConflict; return this; }
  update(patch) { this.op = 'update'; this.payload = patch; return this; }
  delete() { this.op = 'delete'; return this; }

  eq(key, value) { this.filters.push((row) => String(row[key]) === String(value)); return this; }
  neq(key, value) { this.filters.push((row) => String(row[key]) !== String(value)); return this; }
  in(key, values) { const set = new Set(values.map(String)); this.filters.push((row) => set.has(String(row[key]))); return this; }
  // 比较类过滤与 SQL 对齐：列值为 NULL 时结果是 UNKNOWN，不匹配
  gte(key, value) { this.filters.push((row) => row[key] != null && row[key] >= value); return this; }
  lt(key, value) { this.filters.push((row) => row[key] != null && String(row[key]) < String(value)); return this; }
  lte(key, value) { this.filters.push((row) => row[key] != null && row[key] <= value); return this; }
  gt(key, value) { this.filters.push((row) => row[key] != null && String(row[key]) > String(value)); return this; }
  // 与 db.mjs 的 LIKE 对齐：store 只会传「%转义后的字面串%」，这里按子串包含处理
  like(key, value) {
    const text = String(value ?? '').replace(/%/g, '').replace(/\\([%_\\])/g, '$1');
    this.filters.push((row) => String(row[key] ?? '').includes(text));
    return this;
  }
  order(column, { ascending = true } = {}) { this.orders.push({ column, ascending }); return this; }
  limit(n) { this.count = n; return this; }
  range(from, to) { this.from = from; this.to = to; return this; }
  maybeSingle() { this.one = true; return this; }
  single() { this.one = true; return this; }

  matches() {
    let rows = this.table.filter((row) => this.filters.every((test) => test(row)));
    for (const { column, ascending } of [...this.orders].reverse()) {
      rows = [...rows].sort((a, b) => {
        const left = a[column] ?? '', right = b[column] ?? '';
        if (left === right) return 0;
        const result = left > right ? 1 : -1;
        return ascending ? result : -result;
      });
    }
    if (this.from !== undefined) rows = rows.slice(this.from, (this.to ?? rows.length) + 1);
    return rows.slice(0, this.count);
  }

  shape(row) {
    if (!this.columns) return clone(row);
    const out = {};
    for (const column of this.columns) if (column !== '*') out[column] = row[column];
    return out;
  }

  emit(rows) {
    if (this.one) return rows.length ? this.shape(rows[0]) : null;
    return rows.map((row) => this.shape(row));
  }

  run() {
    if (this.op === 'select') {
      return { data: this.emit(this.matches()), error: null };
    }
    if (this.op === 'insert') {
      const input = Array.isArray(this.payload) ? this.payload : [this.payload];
      const rows = input.map((row) => ({ ...(COLUMN_DEFAULTS[this.name] ?? {}), ...row }));
      for (const row of rows) {
        const error = this.conflict(this.name, row);
        if (error) return { data: null, error };
      }
      this.table.push(...rows);
      this.save();
      return { data: this.emit(rows), error: null };
    }
    if (this.op === 'upsert') {
      const row = this.payload;
      const keys = String(this.onConflict ?? PRIMARY[this.name]).split(',').map((key) => key.trim());
      const existing = this.table.find((candidate) => keys.every((key) => String(candidate[key]) === String(row[key])));
      if (existing) Object.assign(existing, row);
      else this.table.push(row);
      this.save();
      return { data: this.emit(existing ? [existing] : [row]), error: null };
    }
    if (this.op === 'update') {
      const targets = this.matches();
      for (const row of targets) Object.assign(row, this.payload);
      this.save();
      return { data: this.emit(targets), error: null };
    }
    if (this.op === 'delete') {
      const targets = this.matches();
      const drop = new Set(targets);
      const kept = this.table.filter((row) => !drop.has(row));
      this.table.length = 0;
      this.table.push(...kept);
      this.save();
      return { data: this.emit(targets), error: null };
    }
    throw new Error(`bad_op:${this.op}`);
  }

  then(resolve, reject) {
    return Promise.resolve().then(() => this.run()).then(resolve, reject);
  }
}
