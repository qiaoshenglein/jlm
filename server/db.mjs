// 自建部署的数据层：用 SQL 实现 functions/store.mjs 需要的查询构造器接口。
// 默认 SQLite（Node 22+ 内置，零依赖），也可切到 PostgreSQL（需 npm install pg）。
// 全部走参数化语句；表名、列名、schema 名一律白名单校验。
import { mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const IDENT = /^[a-z_][a-z0-9_]*$/;
const HERE = dirname(fileURLToPath(import.meta.url));
const requireModule = createRequire(import.meta.url);

export const TABLES = ['users', 'sessions', 'orders', 'trades', 'events', 'snapshots'];
export const SCHEMA_FILE = { sqlite: 'schema.sqlite.sql', postgres: 'schema.postgres.sql' };

const quote = (name) => {
  if (!IDENT.test(name)) throw new Error(`非法标识符：${name}`);
  return `"${name}"`;
};

// 过滤器先记录，最后统一编号占位符，保证参数顺序永远与 SQL 文本一致
const TESTS = {
  eq: (key) => `${quote(key)} = `,
  neq: (key) => `${quote(key)} <> `,
  gt: (key) => `${quote(key)} > `,
  gte: (key) => `${quote(key)} >= `,
  lt: (key) => `${quote(key)} < `,
  lte: (key) => `${quote(key)} <= `,
};

class Query {
  constructor(client, table) {
    this.client = client;
    this.table = table;
    this.op = 'select';
    this.columns = null;
    this.filters = [];
    this.orders = [];
    this.limitCount = null;
    this.offsetCount = null;
    this.payload = null;
    this.onConflict = null;
    this.one = false;
  }

  select(columns) {
    this.columns = String(columns ?? '').split(',').map((c) => c.trim()).filter(Boolean);
    return this;
  }

  insert(payload) { this.op = 'insert'; this.payload = payload; return this; }
  upsert(payload, { onConflict } = {}) { this.op = 'upsert'; this.payload = payload; this.onConflict = onConflict; return this; }
  update(patch) { this.op = 'update'; this.payload = patch; return this; }
  delete() { this.op = 'delete'; return this; }

  eq(key, value) { this.filters.push({ kind: 'eq', key, value }); return this; }
  neq(key, value) { this.filters.push({ kind: 'neq', key, value }); return this; }
  gt(key, value) { this.filters.push({ kind: 'gt', key, value }); return this; }
  gte(key, value) { this.filters.push({ kind: 'gte', key, value }); return this; }
  lt(key, value) { this.filters.push({ kind: 'lt', key, value }); return this; }
  lte(key, value) { this.filters.push({ kind: 'lte', key, value }); return this; }
  in(key, values) { this.filters.push({ kind: 'in', key, value: [...(values ?? [])] }); return this; }

  order(column, { ascending = true } = {}) { this.orders.push(`${quote(column)} ${ascending ? 'ASC' : 'DESC'}`); return this; }
  limit(n) { this.limitCount = Number(n) | 0; return this; }
  range(from, to) { this.offsetCount = Number(from) | 0; this.limitCount = (Number(to) | 0) - (Number(from) | 0) + 1; return this; }
  maybeSingle() { this.one = true; return this; }
  single() { this.one = true; return this; }

  columnsSql() {
    if (!this.columns || this.columns.length === 0) return '*';
    return this.columns.map(quote).join(', ');
  }

  tailSql() {
    let sql = '';
    if (this.orders.length) sql += ` ORDER BY ${this.orders.join(', ')}`;
    if (this.limitCount !== null) sql += ` LIMIT ${this.limitCount}`;
    if (this.offsetCount !== null) sql += ` OFFSET ${this.offsetCount}`;
    return sql;
  }

  // mark(当前参数序号) → 占位符文本；不同方言用 ? 或 $n
  whereSql(mark) {
    if (!this.filters.length) return '';
    const parts = [];
    for (const filter of this.filters) {
      if (filter.kind === 'in') {
        if (!filter.value.length) { parts.push('1 = 0'); continue; }
        const marks = filter.value.map((value) => { this.args.push(this.client.value(value)); return mark(this.args.length); });
        parts.push(`${quote(filter.key)} IN (${marks.join(', ')})`);
        continue;
      }
      this.args.push(this.client.value(filter.value));
      parts.push(TESTS[filter.kind](filter.key) + mark(this.args.length));
    }
    return ` WHERE ${parts.join(' AND ')}`;
  }

  build() {
    this.args = [];
    const table = this.client.qualified(this.table);
    const mark = (index) => this.client.placeholder(index);

    if (this.op === 'select') {
      return { sql: `SELECT ${this.columnsSql()} FROM ${table}${this.whereSql(mark)}${this.tailSql()}`, params: this.args };
    }

    if (this.op === 'insert' || this.op === 'upsert') {
      const rows = Array.isArray(this.payload) ? this.payload : [this.payload];
      if (rows.length !== 1) throw new Error('一次只写入一行');
      const keys = Object.keys(rows[0]);
      const marks = keys.map((key) => {
        this.args.push(this.client.value(rows[0][key]));
        return mark(this.args.length);
      });
      let sql = `INSERT INTO ${table} (${keys.map(quote).join(', ')}) VALUES (${marks.join(', ')})`;
      if (this.op === 'upsert') {
        const conflict = String(this.onConflict ?? '').split(',').map((k) => k.trim()).filter(Boolean);
        if (!conflict.length) throw new Error('upsert 需要 onConflict');
        const updates = keys.filter((key) => !conflict.includes(key));
        const list = updates.length ? updates : conflict;
        const set = list.map((key) => `${quote(key)} = excluded.${quote(key)}`).join(', ');
        sql += ` ON CONFLICT (${conflict.map(quote).join(', ')}) DO UPDATE SET ${set}`;
      }
      return { sql: `${sql} RETURNING ${this.columnsSql()}`, params: this.args };
    }

    if (this.op === 'update') {
      const keys = Object.keys(this.payload);
      const setParts = keys.map((key) => {
        this.args.push(this.client.value(this.payload[key]));
        return `${quote(key)} = ${mark(this.args.length)}`;
      });
      const where = this.whereSql(mark);
      return { sql: `UPDATE ${table} SET ${setParts.join(', ')}${where} RETURNING ${this.columnsSql()}`, params: this.args };
    }

    return { sql: `DELETE FROM ${table}${this.whereSql(mark)} RETURNING ${this.columnsSql()}`, params: this.args };
  }

  async run() {
    const { sql, params } = this.build();
    try {
      const rows = await this.client.execute(sql, params);
      return { data: this.one ? (rows[0] ?? null) : rows, error: null };
    } catch (error) {
      return { data: null, error: this.client.normalizeError(error) };
    }
  }

  then(resolve, reject) { return this.run().then(resolve, reject); }
}

class SqlClient {
  constructor({ driver, schema }) {
    this.driver = driver;
    this.schema = schema || null;
    if (this.schema && !IDENT.test(this.schema)) throw new Error('非法 schema 名');
  }

  qualified(table) {
    if (!IDENT.test(table)) throw new Error(`非法表名：${table}`);
    return this.schema ? `${quote(this.schema)}.${quote(table)}` : quote(table);
  }

  from(table) { return new Query(this, table); }
  excluded() { return 'excluded'; }

  value(input) {
    if (input === undefined) return null;
    if (typeof input === 'boolean') return input ? 1 : 0;
    if (input instanceof Date) return input.toISOString();
    return input;
  }

  normalizeError(error) {
    const text = String(error?.message ?? error);
    // 唯一冲突要识别为 23505：trades.order_id 与快照 (user_id,day) 的幂等全靠它
    if (error?.code === '23505' || /UNIQUE constraint failed|duplicate key value/i.test(text)) {
      return { code: '23505', message: 'duplicate' };
    }
    return { code: 'db_error', message: text.slice(0, 200) };
  }

  async migrate(driver) {
    const sql = readFileSync(join(HERE, SCHEMA_FILE[driver] ?? SCHEMA_FILE.sqlite), 'utf8');
    await this.exec(sql);
    return SCHEMA_FILE[driver] ?? SCHEMA_FILE.sqlite;
  }
}

class SqliteClient extends SqlClient {
  constructor({ path }) {
    super({ driver: 'sqlite', schema: null });
    const { DatabaseSync } = requireModule('node:sqlite');
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA busy_timeout = 5000;');
    this.db.exec('PRAGMA foreign_keys = ON;');
  }

  placeholder() { return '?'; }

  async execute(sql, params) {
    return this.db.prepare(sql).all(...params);
  }

  async exec(script) { this.db.exec(script); }
  async close() { this.db.close(); }
}

class PgClient extends SqlClient {
  constructor({ url, schema, pg }) {
    super({ driver: 'postgres', schema });
    this.pg = pg;
    // int8 默认按字符串返回；金额是微元，量级远小于 2^53，统一转成 Number
    pg.types.setTypeParser(20, (value) => Number(value));
    this.pool = new pg.Pool({ connectionString: url, max: Number(process.env.DB_POOL_MAX ?? 8) });
  }

  placeholder(index) { return `$${index}`; }

  async execute(sql, params) {
    const result = await this.pool.query(sql, params);
    return result.rows.map(normalizeRow);
  }

  async exec(script) { await this.pool.query(script); }
  async close() { await this.pool.end(); }
}

function normalizeRow(row) {
  const out = {};
  for (const [key, value] of Object.entries(row)) {
    out[key] = value instanceof Date ? value.toISOString() : value;
  }
  return out;
}

export async function createDb(config = {}) {
  const driver = config.driver ?? process.env.DB_DRIVER ?? 'sqlite';
  if (driver === 'sqlite') {
    return new SqliteClient({ path: config.path ?? process.env.DB_PATH ?? join(HERE, '..', 'data', 'mirror.db') });
  }
  if (driver === 'postgres' || driver === 'pg') {
    const url = config.url ?? process.env.DATABASE_URL;
    if (!url) throw new Error('使用 PostgreSQL 必须提供 DATABASE_URL');
    let pg;
    try {
      pg = await import('pg');
    } catch {
      throw new Error('使用 PostgreSQL 需要先安装依赖：npm install pg');
    }
    return new PgClient({ url, schema: config.schema ?? process.env.DB_SCHEMA ?? 'app', pg: pg.default ?? pg });
  }
  throw new Error(`不支持的 DB_DRIVER：${driver}（可选 sqlite 或 postgres）`);
}
