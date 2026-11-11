// 整库备份：导出 / 预检 / 导入。
// 表名与列名只认下面这份白名单——文件里出现清单外的表或列一律拒绝，
// 否则一个改过的 JSON 就能往任意字段写任意值。
// 本文件不碰文件系统、不碰 HTTP：运行时差异由 client 的能力（withTx / execute）决定。
import { MICRO, START_CASH, START_CASH_USD } from './rules.mjs';

export const BACKUP_FORMAT = 'mirrordesk-backup';
export const BACKUP_VERSION = 1;
export const MAX_EXPORT_ROWS = 300_000;
const CHUNK = 200;
const MAX_PROBLEMS = 30;

// 类型标记：'text' / 'int' 必填，带 ? 可为 NULL。int 是微元或股数，必须是整数。
const SPECS = {
  users: {
    pk: 'id',
    columns: {
      id: 'text', username: 'text', display: 'text', pass_hash: 'text', created_at: 'text',
      last_login: 'text?', fail_count: 'int', locked_until: 'text?', role: 'text', status: 'text',
      start_cash: 'int?', start_cash_usd: 'int?',
    },
  },
  sessions: {
    pk: 'token',
    columns: { token: 'text', user_id: 'text', expires_at: 'text', created_at: 'text' },
  },
  orders: {
    pk: 'id',
    columns: {
      id: 'text', user_id: 'text', secid: 'text', code: 'text?', name: 'text?', kind: 'text?',
      side: 'text', mode: 'text', qty: 'int', limit_price: 'int?', leaf: 'int', status: 'text',
      day: 'text', reason: 'text?', source: 'text?', fill_price: 'int?', fill_qty: 'int?',
      fill_fee: 'int?', created_at: 'text', updated_at: 'text',
    },
  },
  trades: {
    pk: 'id',
    columns: {
      id: 'text', order_id: 'text?', user_id: 'text', symbol: 'text', code: 'text?', name: 'text?',
      kind: 'text?', side: 'text', qty: 'int', price: 'int', amount: 'int', fee: 'int', leaf: 'int',
      day: 'text', source: 'text?', created_at: 'text',
    },
  },
  events: {
    pk: 'id',
    columns: { id: 'text', user_id: 'text', kind: 'text', message: 'text', dedup: 'text', created_at: 'text' },
  },
  snapshots: {
    pk: 'id',
    columns: {
      id: 'text', user_id: 'text', day: 'text', net_assets: 'int', total_assets: 'int',
      cash: 'int?', total_debt: 'int?', created_at: 'text', updated_at: 'text',
    },
  },
  watchlists: {
    pk: 'id',
    columns: {
      id: 'text', user_id: 'text', secid: 'text', code: 'text?', name: 'text?', kind: 'text?',
      sort: 'int?', created_at: 'text',
    },
  },
  settings: {
    pk: 'key',
    columns: { key: 'text', value: 'text', updated_by: 'text?', updated_at: 'text' },
  },
  audit: {
    pk: 'id',
    columns: {
      id: 'text', actor_id: 'text?', actor: 'text?', action: 'text', target: 'text?',
      detail: 'text?', ip: 'text?', created_at: 'text',
    },
  },
  api_keys: {
    pk: 'id',
    columns: {
      id: 'text', user_id: 'text', name: 'text?', digest: 'text', hint: 'text', created_at: 'text',
      last_used_at: 'text?', revoked_at: 'text?', calls: 'int',
    },
  },
};

// 写入顺序：账户与配置在前，审计最后。表之间没有外键约束，顺序只为了让日志和快照好读。
const WRITE_ORDER = ['users', 'settings', 'api_keys', 'sessions', 'orders', 'trades', 'events', 'snapshots', 'watchlists', 'audit'];
// replace 模式涉及的表（audit 例外：它是平台黑匣子，导入不能把「谁覆盖了数据」一起覆盖掉）
const REPLACE_TABLES = WRITE_ORDER;

const SCOPES = {
  data: ['users', 'orders', 'trades', 'events', 'snapshots', 'watchlists', 'api_keys'],
  config: ['settings'],
  audit: ['audit'],
  sessions: ['sessions'],
};

export const BACKUP_TABLES = Object.keys(SPECS);
const USER_REFS = ['orders', 'trades', 'events', 'snapshots', 'watchlists', 'api_keys', 'sessions'];

const quoteIdent = (name) => {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`非法标识符：${name}`);
  return `"${name}"`;
};
const qualify = (schema, table) => (schema ? `${quoteIdent(schema)}.${quoteIdent(table)}` : quoteIdent(table));
const mark = (driver, index) => (driver === 'sqlite' ? '?' : `$${index}`);

const hex = (buffer) => [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
const sha256 = (text) => crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)).then(hex);

/** 对任意子集求同一个口径的校验和：比对账本时用它排除易变列（如 last_login） */
export const checksumOf = (value) => sha256(canonical(value));

// 校验和必须与键序无关：同一份数据从不同驱动读出来要得到同一个值
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  if (value === undefined) return 'null';
  return JSON.stringify(value);
}

const scopedTables = (include) => BACKUP_TABLES.filter((name) =>
  Object.entries(SCOPES).some(([scope, list]) => include[scope] && list.includes(name)));

// 只保留白名单列，int 一律截断成整数，缺失的可空列写 null
function normalizeRow(spec, row) {
  const out = {};
  for (const [column, kind] of Object.entries(spec.columns)) {
    const value = row[column];
    if (!kind.startsWith('int')) {
      out[column] = value === undefined ? null : value;
    } else if (value === null || value === undefined || value === '') {
      out[column] = kind === 'int' ? 0 : null;
    } else {
      out[column] = Math.trunc(Number(value));
    }
  }
  return out;
}

// 单行校验：返回清洗后的行与问题列表。必填列缺失、类型不符、未知列都在这里挡掉。
function checkRow(spec, row, index) {
  const issues = [];
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    return { row: null, issues: [`第 ${index + 1} 行不是对象`] };
  }
  for (const key of Object.keys(row)) {
    if (!(key in spec.columns)) issues.push(`第 ${index + 1} 行含清单外的列 ${key}`);
  }
  const out = {};
  for (const [column, kind] of Object.entries(spec.columns)) {
    const value = row[column];
    const missing = value === undefined || value === null;
    // 空串对文本列是合法值（邀请码、备注、拒单原因都可能就是空），对整数列不是
    const blankInt = typeof value === 'string' && value.trim() === '';
    if (kind === 'text' || kind === 'int') {
      if (missing || (kind === 'int' && blankInt)) {
        issues.push(`第 ${index + 1} 行缺少必填列 ${column}`);
        continue;
      }
      if (kind === 'int') {
        const num = Number(value);
        if (!Number.isFinite(num)) {
          issues.push(`第 ${index + 1} 行 ${column} 不是数字`);
          continue;
        }
        out[column] = Math.trunc(num);
      } else {
        out[column] = typeof value === 'string' ? value : String(value);
      }
      continue;
    }
    if (missing || blankInt) {
      out[column] = null;
      continue;
    }
    if (kind === 'int?') {
      const num = Number(value);
      if (!Number.isFinite(num)) {
        issues.push(`第 ${index + 1} 行 ${column} 不是数字`);
        continue;
      }
      out[column] = Math.trunc(num);
    } else if (typeof value === 'string') {
      out[column] = value;
    } else {
      issues.push(`第 ${index + 1} 行 ${column} 应为文本`);
    }
  }
  return { row: issues.length ? null : out, issues };
}

async function readTable(client, name) {
  const result = await client.from(name).select(Object.keys(SPECS[name].columns).join(','));
  if (result.error) throw new Error(`read_failed:${name}`);
  return result.data ?? [];
}

/**
 * 导出整库。默认全站数据 + 配置 + 审计，不含会话摘要。只读，任何运行时都能跑。
 */
export async function exportBackup(client, { include = {}, now = new Date(), meta = {} } = {}) {
  const scope = { data: true, config: true, audit: true, sessions: false, ...include };
  for (const key of Object.keys(scope)) {
    if (!(key in SCOPES)) throw new Error(`unknown_scope:${key}`);
  }
  const tables = {};
  let rows = 0;
  for (const name of scopedTables(scope)) {
    const list = (await readTable(client, name))
      .map((row) => normalizeRow(SPECS[name], row))
      .sort((a, b) => String(a[SPECS[name].pk]).localeCompare(String(b[SPECS[name].pk])));
    tables[name] = list;
    rows += list.length;
  }
  if (rows > MAX_EXPORT_ROWS) throw new Error(`too_many_rows:${rows}`);
  const counts = Object.fromEntries(Object.entries(tables).map(([name, list]) => [name, list.length]));
  const document = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    created_at: now.toISOString(),
    meta: {
      driver: meta.driver ?? null,
      schema: meta.schema ?? null,
      scopes: Object.entries(scope).filter(([, on]) => on).map(([key]) => key),
      by: meta.by ?? null,
      reason: meta.reason ?? null,
    },
    rows,
    counts,
    checksum: await checksumOf(tables),
    tables,
  };
  document.bytes = JSON.stringify(document).length;
  return document;
}

/**
 * 预检：逐表逐行按白名单校验，再查账户引用是否成对、校验和是否自洽。
 * 不做任何写入，也不要求 client——纯函数（只有一个 await 是算校验和）。
 */
export async function inspectBackup(document) {
  const problems = [];
  const warnings = [];
  const add = (table, message) => {
    if (problems.length < MAX_PROBLEMS) problems.push({ table, message });
    else problems[MAX_PROBLEMS - 1] = { table: null, message: `问题过多，仅列出前 ${MAX_PROBLEMS} 条` };
  };

  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    return { ok: false, problems: [{ table: null, message: '文件不是合法的 JSON 对象' }], warnings, tables: {}, counts: {}, rows: 0, modes: { replace: false, config: false } };
  }
  if (document.format !== BACKUP_FORMAT) add(null, `格式标识不符：期望 ${BACKUP_FORMAT}，实际 ${String(document.format ?? '缺失')}`);
  if (!Number.isInteger(document.version) || document.version > BACKUP_VERSION) {
    add(null, `备份版本 ${String(document.version)} 高于当前程序（v${BACKUP_VERSION}），请先升级再导入`);
  }
  const source = document.tables;
  if (!source || typeof source !== 'object' || Array.isArray(source)) add(null, '缺少 tables 段，或它不是对象');

  const tables = {};
  const counts = {};
  let rows = 0;
  let checksum = null;
  if (source && typeof source === 'object' && !Array.isArray(source)) {
    for (const name of Object.keys(source)) {
      const spec = SPECS[name];
      if (!spec) {
        add(name, `未知数据表「${name}」：清单外的表不接受`);
        continue;
      }
      const list = source[name];
      if (!Array.isArray(list)) {
        add(name, `${name} 不是数组`);
        continue;
      }
      const clean = [];
      const seen = new Set();
      const local = [];
      for (let index = 0; index < list.length; index += 1) {
        const { row, issues } = checkRow(spec, list[index], index);
        if (row) {
          const key = String(row[spec.pk]);
          if (seen.has(key)) {
            if (local.length < 4) local.push(`主键 ${spec.pk}=${key} 重复`);
            continue;
          }
          seen.add(key);
          clean.push(row);
        } else if (local.length < 4) local.push(...issues.slice(0, 2));
      }
      if (local.length) add(name, `${name}：${local.join('；')}`);
      tables[name] = clean.sort((a, b) => String(a[spec.pk]).localeCompare(String(b[spec.pk])));
      counts[name] = clean.length;
      rows += clean.length;
    }

    const userIds = tables.users ? new Set(tables.users.map((row) => row.id)) : null;
    if (userIds) {
      for (const name of USER_REFS) {
        const list = tables[name];
        if (!list?.length) continue;
        const orphans = list.filter((row) => !userIds.has(row.user_id)).length;
        if (orphans) add(name, `${name} 有 ${orphans} 行的 user_id 在 users 里不存在`);
      }
    } else if (SCOPES.data.some((name) => tables[name]?.length)) {
      add(null, '文件带了业务数据却没有 users 表：这些记录将不属于任何账户。');
    }
    if (rows > MAX_EXPORT_ROWS) add(null, `合计 ${rows} 行，超过单次导入上限 ${MAX_EXPORT_ROWS}，请改用 VACUUM INTO / pg_dump`);

    const recomputed = await checksumOf(tables);
    if (document.checksum && document.checksum !== recomputed) {
      warnings.push('文件里的 checksum 与实际内容不符（被改动过，或来自更早版本）；已按文件实际内容重新计算。');
    }
    checksum = recomputed;
  }
  const modes = {
    replace: Boolean(tables.users?.length),
    config: Boolean(tables.settings?.length),
  };
  if (!modes.replace) warnings.push('文件里没有账户数据，「覆盖全站」不可选。');
  if (!modes.config) warnings.push('文件里没有 settings 段，「只并配置」不可选。');
  if (tables.sessions?.length) warnings.push('文件包含会话摘要：导入后旧实例上已登录的浏览器会在新实例继续有效。');
  else warnings.push('文件不含会话：导入完成后所有人都要重新登录（包括你自己）。');
  if (!tables.audit?.length) warnings.push('文件不含审计流水：本机已有审计会原样保留，导入只追加新记录。');

  return {
    ok: problems.length === 0,
    problems,
    warnings,
    tables,
    counts,
    rows,
    modes,
    checksum,
    format: document.format ?? null,
    version: document.version ?? null,
    created_at: document.created_at ?? null,
    meta: document.meta ?? {},
    hasSessions: Boolean(tables.sessions?.length),
    hasUsers: Boolean(tables.users?.length),
    scopes: document.meta?.scopes ?? Object.keys(tables),
  };
}

/** 预检之外的「与本机对照」：每张表当前多少行、导入后多少行、会清空还是只并 */
export async function planBackup(client, report, mode) {
  const rows = [];
  for (const name of REPLACE_TABLES) {
    if (mode === 'config' && name !== 'settings') continue;
    let current = null;
    try {
      current = (await client.from(name).select(Object.keys(SPECS[name].columns).slice(0, 1).join(','))).data?.length ?? null;
    } catch { /* 表不存在时按 null 报 */ }
    const incoming = report.tables[name]?.length ?? 0;
    rows.push({
      table: name,
      current,
      incoming,
      action: mode === 'config' ? '只并配置' : name === 'audit' ? '保留并追加' : incoming ? '清空后写入' : '清空（文件里没有）',
    });
  }
  const notes = [];
  if (mode === 'replace') {
    if (!report.tables.settings?.length) notes.push('文件里没有 settings：覆盖后挂牌参数、行情源配置、注册开关全部回到出厂默认。');
    if (!report.tables.audit?.length) notes.push('审计不会被清空，本机历史记录会保留。');
  }
  return { mode, rows, notes, checksum: report.checksum, rows_to_write: report.rows };
}

/**
 * 应用导入。replace 清空后整表写入（audit 只并），config 只 upsert settings。
 * 只有拿到事务能力（client.withTx）的自建部署才允许执行：云上做不到全有或全无，宁可拒。
 */
export async function applyBackup(client, report, { mode, now = new Date(), actor = null } = {}) {
  if (typeof client.withTx !== 'function') throw new Error('backup_runtime_unsupported');
  if (!['replace', 'config'].includes(mode)) throw new Error(`unknown_mode:${mode}`);
  if (!report.ok) {
    const error = new Error('backup_invalid');
    error.extra = { problems: report.problems.slice(0, 20) };
    throw error;
  }
  if (!report.modes[mode]) throw new Error(`mode_unavailable:${mode}`);

  const driver = client.driver ?? 'sqlite';
  const schema = driver === 'postgres' ? (client.schema ?? 'app') : null;
  const applied = {};
  const cleared = {};
  const startedAt = Date.now();

  await client.withTx(async (run) => {
    if (mode === 'config') {
      const columns = Object.keys(SPECS.settings.columns);
      for (const group of chunkOf(report.tables.settings, CHUNK)) {
        const values = group.map((_, i) => `(${columns.map((__, k) => mark(driver, i * columns.length + k + 1)).join(', ')})`).join(', ');
        const sql = `INSERT INTO ${qualify(schema, 'settings')} (${columns.map(quoteIdent).join(', ')}) VALUES ${values}`
          + ` ON CONFLICT (${quoteIdent('key')}) DO UPDATE SET `
          + columns.filter((column) => column !== 'key')
            .map((column) => `${quoteIdent(column)} = ${driver === 'sqlite' ? 'excluded' : 'EXCLUDED'}.${quoteIdent(column)}`).join(', ');
        await run(sql, group.flatMap((row) => columns.map((column) => row[column] ?? null)));
        applied.settings = (applied.settings ?? 0) + group.length;
      }
      return;
    }

    for (const name of [...REPLACE_TABLES].reverse()) {
      if (name === 'audit') continue;
      const removed = await run(`DELETE FROM ${qualify(schema, name)}`, []);
      cleared[name] = countAffected(removed);
    }

    for (const name of WRITE_ORDER) {
      const list = report.tables[name] ?? [];
      applied[name] = 0;
      if (!list.length) continue;
      const columns = Object.keys(SPECS[name].columns);
      for (const group of chunkOf(list, CHUNK)) {
        const values = group.map((_, i) => `(${columns.map((__, k) => mark(driver, i * columns.length + k + 1)).join(', ')})`).join(', ');
        // 只有审计用「冲突即跳过」：其它表刚被清空，出现主键冲突说明数据本身有问题，必须报错回滚
        const conflict = name === 'audit' && driver === 'sqlite' ? ' OR IGNORE' : '';
        const onConflict = name === 'audit' && driver === 'postgres' ? ` ON CONFLICT (${quoteIdent(SPECS[name].pk)}) DO NOTHING` : '';
        const sql = `INSERT${conflict} INTO ${qualify(schema, name)} (${columns.map(quoteIdent).join(', ')}) VALUES ${values}${onConflict}`;
        const result = await run(sql, group.flatMap((row) => columns.map((column) => row[column] ?? null)));
        applied[name] += countAffected(result, group.length);
      }
    }
  });

  return {
    mode,
    applied,
    cleared,
    checksum: report.checksum,
    rows: report.rows,
    took_ms: Date.now() - startedAt,
    reauth_required: mode === 'replace' && !report.hasSessions,
    at: now.toISOString(),
    actor,
  };
}

const chunkOf = (list, size) => {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
};

// SQLite 的 DELETE/INSERT 不返回行数的统一形态：node:sqlite 的 run() 才有 changes
const countAffected = (result, fallback = 0) => {
  if (typeof result === 'number') return result;
  if (result && typeof result.changes === 'number') return result.changes;
  if (Array.isArray(result)) return result.length;
  return fallback;
};

/** 当前库的规模概览：后台页、CLI 与预检结果都复用这一份 */
export async function backupOverview(client) {
  const tables = {};
  for (const name of BACKUP_TABLES) {
    try {
      tables[name] = (await readTable(client, name)).length;
    } catch {
      tables[name] = null;
    }
  }
  return {
    driver: client.driver ?? null,
    schema: client.schema ?? null,
    tables,
    rows: Object.values(tables).reduce((sum, n) => sum + (n ?? 0), 0),
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    max_rows: MAX_EXPORT_ROWS,
    defaults: { start_cash: START_CASH, start_cash_usd: START_CASH_USD, micro: MICRO },
  };
}
