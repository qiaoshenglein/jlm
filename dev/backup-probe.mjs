// 备份功能回归。第一部分打数据层，第二部分起一个真实服务打接口层与落盘。
// 全程用临时 sqlite 文件与临时备份目录，绝不碰 data/mirror.db，也不需要行情源。
// 用法：node dev/backup-probe.mjs
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createDb } from '../server/db.mjs';
import { applyBackup, backupOverview, checksumOf, exportBackup, inspectBackup, planBackup } from '../functions/backup.mjs';

const ROOT = resolve(import.meta.dirname, '..');

const results = [];
const ok = (name, pass, detail = '') => {
  results.push(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  return pass;
};

const dir = mkdtempSync(join(tmpdir(), 'bak-probe-'));
const src = await createDb({ driver: 'sqlite', path: join(dir, 'src.db') });
const dst = await createDb({ driver: 'sqlite', path: join(dir, 'dst.db') });
await src.migrate('sqlite');
await dst.migrate('sqlite');

const ids = ['u1', 'u2', 'u3'];
async function seed(client, { tag = '', audits = 2, sessions = true } = {}) {
  for (const [index, id] of ids.entries()) {
    await client.from('users').insert({
      id, username: `${tag || 'user'}${index}`, display: `账户${index}`, pass_hash: 'pbkdf2-sha256$1$a$b',
      created_at: `2026-11-0${index + 1}T01:00:00.000Z`, last_login: null, fail_count: 0, locked_until: null,
      role: index === 0 ? 'admin' : 'user', status: 'active',
      start_cash: 1_000_000_000_000 + index, start_cash_usd: 100_000_000_000 + index,
    });
  }
  await client.from('settings').insert({ key: 'register_enabled', value: '1', updated_by: 'u1', updated_at: '2026-11-05T00:00:00.000Z' });
  await client.from('settings').insert({ key: 'start_cash', value: '1000000000000', updated_by: 'u1', updated_at: '2026-11-05T00:00:00.000Z' });
  await client.from('orders').insert({
    id: 'o1', user_id: 'u1', secid: '1.600519', code: '600519', name: '贵州茅台', kind: 'stock',
    side: 'buy', mode: 'market', qty: 100, limit_price: null, leaf: 1, status: 'filled', day: '2026-11-05',
    reason: null, source: 'web', fill_price: 1_500_000_000, fill_qty: 100, fill_fee: 5_000_000,
    created_at: '2026-11-05T02:00:00.000Z', updated_at: '2026-11-05T02:00:01.000Z',
  });
  await client.from('trades').insert({
    id: 't1', order_id: 'o1', user_id: 'u1', symbol: '1.600519', code: '600519', name: '贵州茅台', kind: 'stock',
    side: 'buy', qty: 100, price: 1_500_000_000, amount: 150_000_000_000, fee: 5_000_000, leaf: 1,
    day: '2026-11-05', source: 'web', created_at: '2026-11-05T02:00:01.000Z',
  });
  await client.from('snapshots').insert({
    id: 's1', user_id: 'u1', day: '2026-11-05', net_assets: 900_000_000_000, total_assets: 1_050_000_000_000,
    cash: 750_000_000_000, total_debt: 0, created_at: '2026-11-05T07:00:00.000Z', updated_at: '2026-11-05T07:00:00.000Z',
  });
  await client.from('watchlists').insert({
    id: 'w1', user_id: 'u2', secid: '0.399006', code: '399006', name: '创业板指', kind: 'index', sort: 1,
    created_at: '2026-11-04T02:00:00.000Z',
  });
  await client.from('api_keys').insert({
    id: 'k1', user_id: 'u1', name: '脚本', digest: 'abc', hint: 'mk_live_ab…cd', created_at: '2026-11-05T02:00:00.000Z',
    last_used_at: null, revoked_at: null, calls: 3,
  });
  for (let i = 0; i < audits; i += 1) {
    await client.from('audit').insert({
      id: `${tag}a${i}`, actor_id: 'u1', actor: `${tag}user0`, action: 'settings_update', target: 'settings',
      detail: '{}', ip: '127.0.0.1', created_at: `2026-11-05T0${i}:00:00.000Z`,
    });
  }
  if (sessions) {
    await client.from('sessions').insert({ token: `${tag}tk1`, user_id: 'u1', expires_at: '2026-12-05T00:00:00.000Z', created_at: '2026-11-05T00:00:00.000Z' });
  }
}

await seed(src);
await seed(dst, { tag: 'dst', audits: 3 });

const source = await backupOverview(src);
ok('源库种子数据到位', source.tables.users === 3 && source.tables.orders === 1 && source.tables.audit === 2,
  Object.entries(source.tables).filter(([, n]) => n).map(([k, n]) => `${k}=${n}`).join(' '));

const document = await exportBackup(src, { now: new Date('2026-11-06T00:00:00Z'), meta: { driver: 'sqlite' } });
ok('导出：逐表计数与源库一致',
  Object.entries(document.counts).every(([name, n]) => source.tables[name] === n) && document.rows === 12,
  `${document.rows} 行 · ${document.bytes} 字节 · checksum ${document.checksum.slice(0, 12)}`);
ok('导出：默认不含会话摘要', document.tables.sessions === undefined && document.counts.audit === 2);
ok('导出：校验和与键序无关（同数据两次导出一致）',
  (await exportBackup(src, { now: new Date('2026-11-06T00:00:00Z') })).checksum === document.checksum);
ok('导出：可带会话摘要', (await exportBackup(src, { include: { sessions: true } })).counts.sessions === 1);

const report = await inspectBackup(document);
ok('预检：合法文件通过并给出两种模式', report.ok && report.modes.replace && report.modes.config,
  `${report.problems.length} 个问题 · ${report.warnings.length} 条提示`);
const plan = await planBackup(dst, report, 'replace');
ok('预检：与本机对照逐表给出动作', plan.rows.length === 10
  && plan.rows.find((row) => row.table === 'audit').action === '保留并追加'
  && plan.rows.find((row) => row.table === 'users').action === '清空后写入',
  plan.rows.map((row) => `${row.table}:${row.current}→${row.incoming}`).join(' '));

const applied = await applyBackup(dst, report, { mode: 'replace', now: new Date('2026-11-06T01:00:00Z') });
const after = await backupOverview(dst);
ok('导入：逐表行数与文件一致（会话被清空、审计只追加）',
  Object.entries(document.counts).every(([name, n]) => (name === 'audit' ? 5 : n) === after.tables[name])
  && after.tables.sessions === 0,
  Object.entries(after.tables).filter(([, n]) => n).map(([k, n]) => `${k}=${n}`).join(' '));
ok('导入：审计不被覆盖，本机历史保留（2 源 + 3 本机）', after.tables.audit === 5 && applied.cleared.audit === undefined,
  `applied=${JSON.stringify(applied.applied)}`);
// 审计会被追加，比对时要排除它
const noAudit = (client) => exportBackup(client, { include: { audit: false }, now: new Date('2026-11-06T00:00:00Z') });
ok('导入：内容与源库逐字段相同（排除审计追加）',
  (await noAudit(dst)).checksum === (await noAudit(src)).checksum,
  `耗时 ${applied.took_ms}ms · 需重新登录=${applied.reauth_required}`);

// config 模式：只动 settings
const dst2 = await createDb({ driver: 'sqlite', path: join(dir, 'dst2.db') });
await dst2.migrate('sqlite');
await seed(dst2, { tag: 'keep', audits: 1 });
const before = await backupOverview(dst2);
const configOnly = await exportBackup(src, { include: { data: false, audit: false } });
const configReport = await inspectBackup(configOnly);
ok('只导配置时文件里只有 settings', configReport.ok && Object.keys(configReport.tables).join() === 'settings'
  && !configReport.modes.replace && configReport.modes.config, JSON.stringify(configReport.counts));
await applyBackup(dst2, configReport, { mode: 'config' });
const mid = await backupOverview(dst2);
ok('并配置：users/订单/流水一行不动', mid.tables.users === before.tables.users && mid.tables.trades === before.tables.trades
  && mid.tables.audit === before.tables.audit, `users=${mid.tables.users} trades=${mid.tables.trades}`);
await dst2.close();

// 篡改与坏数据必须被挡下
const tampered = JSON.parse(JSON.stringify(document));
tampered.tables.pwned = [{ x: 1 }];
const r1 = await inspectBackup(tampered);
ok('清单外的表被拒绝', !r1.ok && r1.problems.some((item) => item.table === 'pwned'), r1.problems[0]?.message);

const badColumn = JSON.parse(JSON.stringify(document));
badColumn.tables.users[0].is_super_admin = true;
const r2 = await inspectBackup(badColumn);
ok('清单外的列被拒绝', !r2.ok && r2.problems.some((item) => /is_super_admin/.test(item.message)), r2.problems[0]?.message);

const orphan = JSON.parse(JSON.stringify(document));
orphan.tables.orders[0].user_id = 'ghost';
const r3 = await inspectBackup(orphan);
ok('孤儿委托被拒绝', !r3.ok && r3.problems.some((item) => /user_id/.test(item.message ?? '')), r3.problems[0]?.message);

const badMoney = JSON.parse(JSON.stringify(document));
badMoney.tables.trades[0].price = '1.5元';
const r4 = await inspectBackup(badMoney);
ok('金额列非整数被拒绝', !r4.ok, r4.problems[0]?.message);

const missingPk = JSON.parse(JSON.stringify(document));
delete missingPk.tables.users[1].username;
const r5 = await inspectBackup(missingPk);
ok('必填列缺失被拒绝', !r5.ok && r5.problems.some((item) => item.table === 'users'), r5.problems[0]?.message);

const dup = JSON.parse(JSON.stringify(document));
dup.tables.users.push({ ...dup.tables.users[0] });
const r6 = await inspectBackup(dup);
ok('主键重复被拒绝', !r6.ok && r6.problems.some((item) => /重复/.test(item.message ?? '')), r6.problems[0]?.message);

const wrongFormat = { ...document, format: 'someone-elses-dump' };
ok('格式标识不符被拒绝', !(await inspectBackup(wrongFormat)).ok);
ok('版本高于程序被拒绝', !(await inspectBackup({ ...document, version: 99 })).ok);
ok('非对象输入被拒绝', !(await inspectBackup('字符串')).ok && !(await inspectBackup(null)).ok);

// 留空的配置项（邀请码默认就是空串）不能被当成「缺少必填列」——这是真实数据里最常见的形状
const blankSetting = JSON.parse(JSON.stringify(document));
blankSetting.tables.settings.push({ key: 'invite_code', value: '', updated_by: null, updated_at: '2026-11-05T00:00:00.000Z' });
const rBlank = await inspectBackup(blankSetting);
ok('空串配置项不被当成缺失列', rBlank.ok && rBlank.counts.settings === 3,
  rBlank.problems.map((item) => item.message).join('；') || `settings=${rBlank.counts.settings}`);

const edited = JSON.parse(JSON.stringify(document));
edited.tables.users[0].display = '改过的昵称';
const r7 = await inspectBackup(edited);
ok('改动过的文件校验和被复核并提示', r7.ok && r7.checksum !== document.checksum
  && r7.warnings.some((line) => /checksum/.test(line)), r7.warnings.find((line) => /checksum/.test(line)));

// 事务原子性：中途失败必须整笔回滚
const dst3 = await createDb({ driver: 'sqlite', path: join(dir, 'dst3.db') });
await dst3.migrate('sqlite');
await seed(dst3, { tag: 'boom', audits: 1 });
const pristine = await exportBackup(dst3, { now: new Date('2026-11-06T00:00:00Z') });
const realTx = dst3.withTx.bind(dst3);
dst3.withTx = (fn) => {
  let calls = 0;
  return realTx(async (run) => {
    const wrapped = async (sql, params) => {
      calls += 1;
      if (calls === 12) throw new Error('模拟中途失败');
      return run(sql, params);
    };
    return fn(wrapped);
  });
};
let threw = null;
try {
  await applyBackup(dst3, report, { mode: 'replace' });
} catch (error) {
  threw = error.message;
}
dst3.withTx = realTx;
const untouched = await exportBackup(dst3, { now: new Date('2026-11-06T00:00:00Z') });
ok('导入中途失败整笔回滚，数据与失败前逐字相同', Boolean(threw) && untouched.checksum === pristine.checksum,
  `${threw ?? '没有异常'} · ${untouched.checksum.slice(0, 8)}`);

// ---- 第二部分：接口层。真实服务 + 独立临时库 + 临时备份目录，仍然不碰 data/mirror.db ----
const api = await createDb({ driver: 'sqlite', path: join(dir, 'api.db') });
await api.migrate('sqlite');
await seed(api, { audits: 1 });
await api.close();
// 给 bak_boss 一个能登录的口令，并塞 200 条委托，让导出文件天然超过 16KB 的默认请求体上限
const fill = await createDb({ driver: 'sqlite', path: join(dir, 'api.db') });
const { hashPassword } = await import('../functions/auth.mjs');
await fill.from('users').update({ username: 'bak_boss', display: '备份管理员', role: 'admin', pass_hash: await hashPassword('probe12345') }).eq('id', 'u1');
for (let i = 0; i < 200; i += 1) {
  await fill.from('orders').insert({
    id: `bulk${i}`, user_id: 'u2', secid: '1.600519', code: '600519', name: '贵州茅台', kind: 'stock',
    side: 'buy', mode: 'limit', qty: 100 + i, limit_price: 1_500_000_000 + i, leaf: 1, status: 'open',
    day: '2026-11-05', reason: null, source: 'web', fill_price: null, fill_qty: null, fill_fee: null,
    created_at: `2026-11-05T0${i % 6}:0${i % 6}:00.000Z`, updated_at: '2026-11-05T03:00:00.000Z',
  });
}
await fill.close();

const freePort = () => new Promise((done) => {
  const probe = createServer();
  probe.listen(0, '127.0.0.1', () => { const p = probe.address().port; probe.close(() => done(p)); });
});
const port = await freePort();
const backupDir = join(dir, 'backups');
const child = spawn(process.execPath, ['server/index.mjs'], {
  cwd: ROOT,
  env: {
    ...process.env, PORT: String(port), HOST: '127.0.0.1', DB_DRIVER: 'sqlite',
    DB_PATH: join(dir, 'api.db'), ADMIN_USERNAMES: 'bak_boss', BACKUP_DIR: backupDir, BACKUP_KEEP: '2',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stderr.on('data', (chunk) => process.stderr.write(chunk));
const base = `http://127.0.0.1:${port}`;
const call = async (action, payload = {}, token = null) => {
  const response = await fetch(`${base}/functions/v1/app?action=${action}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(token ? { ...payload, token } : payload),
  });
  return { status: response.status, json: await response.json() };
};
const snapshotFiles = () => (existsSync(backupDir) ? readdirSync(backupDir) : []).filter((name) => name.startsWith('pre-import-'));

try {
  for (let i = 0; i < 80; i++) {
    try {
      if ((await fetch(`${base}/healthz`, { cache: 'no-store' })).ok) break;
    } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  const login = await call('login', { username: 'bak_boss', password: 'probe12345' });
  const bt = login.json.token;
  ok('接口层：管理员已登录临时实例', login.status === 200 && Boolean(bt));

  const guest = await call('register', { username: 'bak_guest', password: 'probe12345', display: '普通账户' });
  const denied = await call('admin_backup_export', {}, guest.json.token);
  ok('非管理员拿不到备份接口', denied.status === 403 && denied.json.code === 'not_admin', `${denied.status} ${denied.json.code}`);

  const viaGet = await fetch(`${base}/functions/v1/app?action=admin_backup_export`, { headers: { 'content-type': 'application/json' } });
  ok('导出只接受 POST', viaGet.status === 405, String(viaGet.status));

  const exported = await call('admin_backup_export', {}, bt);
  const doc = exported.json.document;
  ok('导出接口返回整库文档', exported.status === 200 && doc?.counts?.orders === 201 && doc.counts.users === 4,
    `${doc?.rows} 行 · ${Math.round((doc?.bytes ?? 0) / 1024)}KB · checksum ${String(doc?.checksum).slice(0, 8)}`);
  ok('导出文件超过 16KB（默认请求体上限）', (doc?.bytes ?? 0) > 16 * 1024);

  const preview = await call('admin_backup_preview', { document: doc }, bt);
  ok('预检返回两种模式的对照表', preview.json.ok === true && preview.json.plans.replace && preview.json.plans.config
    && preview.json.plans.replace.rows.length === 10 && preview.json.checksum === doc.checksum,
    `replace: ${preview.json.plans?.replace?.rows?.filter((row) => row.incoming).length} 张表有数据`);

  const broken = JSON.parse(JSON.stringify(doc));
  broken.tables.users[0].secret_flag = true;
  const previewBad = await call('admin_backup_preview', { document: broken }, bt);
  ok('预检把非法文件挡在写入之前', previewBad.status === 400 && previewBad.json.code === 'backup_invalid'
    && Array.isArray(previewBad.json.problems) && /secret_flag/.test(previewBad.json.message), previewBad.json.message);

  const noConfirm = await call('admin_backup_apply', { document: doc, mode: 'replace', ack: doc.checksum.slice(0, 6) }, bt);
  ok('缺少显式确认时拒绝执行', noConfirm.status === 400 && noConfirm.json.code === 'confirm_required', noConfirm.json.code);

  const wrongAck = await call('admin_backup_apply', { document: doc, mode: 'replace', ack: 'zzzzzz', confirm: true }, bt);
  ok('校验和不一致时拒绝执行', wrongAck.status === 400 && wrongAck.json.code === 'backup_ack_mismatch'
    && wrongAck.json.expect === doc.checksum.slice(0, 6), `expect=${wrongAck.json.expect}`);

  const noMode = await call('admin_backup_apply', { document: doc, ack: doc.checksum.slice(0, 6), confirm: true }, bt);
  ok('不给 mode 时不会默认成最具破坏性的一档', noMode.status === 400 && noMode.json.code === 'backup_mode_unavailable',
    `${noMode.json.code} mode=${JSON.stringify(noMode.json.mode)}`);

  // 只并配置：先改一个开关，再用文件里的旧值并回来，业务数据必须一行不动
  const configDoc = (await call('admin_backup_export', { include: { data: false, audit: false } }, bt)).json.document;
  await call('admin_settings', { patch: { register_enabled: false }, confirm: true }, bt);
  const afterToggle = await call('admin_settings', {}, bt);
  const configApplied = await call('admin_backup_apply', { document: configDoc, mode: 'config', ack: configDoc.checksum.slice(0, 6), confirm: true }, bt);
  const restored = await call('admin_settings', {}, bt);
  ok('只并配置：注册开关被文件里的值并回来', configApplied.status === 200 && afterToggle.json.settings.register_enabled === false
    && restored.json.settings.register_enabled === true && configApplied.json.applied.settings === configDoc.tables.settings.length,
    `applied=${JSON.stringify(configApplied.json.applied)}`);
  const afterConfig = await call('admin_backup_export', {}, bt);
  ok('只并配置不碰业务数据', afterConfig.json.document.counts.orders === doc.counts.orders
    && afterConfig.json.document.counts.users === doc.counts.users, `orders=${afterConfig.json.document.counts.orders}`);

  // 覆盖全站：会话被清掉，必须重新登录；账本与配置逐字回来
  // 比对要排除会自然变化的列（重新登录会写 users.last_login，也会新建 sessions）
  const stable = async (doc) => checksumOf({
    orders: doc.tables.orders, trades: doc.tables.trades, snapshots: doc.tables.snapshots,
    watchlists: doc.tables.watchlists, api_keys: doc.tables.api_keys, settings: doc.tables.settings,
    users: doc.tables.users.map((row) => ({ ...row, last_login: null })),
  });
  const noAudit = { include: { audit: false } };
  const beforeReplace = (await call('admin_backup_export', noAudit, bt)).json.document;
  const fullDoc = (await call('admin_backup_export', {}, bt)).json.document;
  const applied = await call('admin_backup_apply', { document: fullDoc, mode: 'replace', ack: fullDoc.checksum.slice(0, 6), confirm: true }, bt);
  const deadSession = await call('admin_backup_export', {}, bt);
  const relogin = await call('login', { username: 'bak_boss', password: 'probe12345' });
  const afterReplace = (await call('admin_backup_export', noAudit, relogin.json.token)).json.document;
  ok('覆盖导入成功并给出安全快照路径', applied.status === 200 && applied.json.mode === 'replace'
    && applied.json.reauth_required === true && existsSync(applied.json.snapshot?.path ?? ''),
  `status=${applied.status} code=${applied.json.code ?? 'ok'} msg=${String(applied.json.message ?? '').slice(0, 60)} 快照=${applied.json.snapshot?.bytes ?? 0}B ${applied.json.took_ms ?? 0}ms`);
  ok('覆盖导入后会话失效、重新登录可用', deadSession.status === 401 && relogin.status === 200,
    `${deadSession.status} → ${relogin.status}`);
  ok('覆盖导入后账本与配置逐字一致（排除会自然变化的列）', (await stable(afterReplace)) === (await stable(beforeReplace))
    && afterReplace.counts.users === beforeReplace.counts.users
    && afterReplace.tables.users.some((row) => row.role === 'admin'),
    `orders=${afterReplace.counts.orders} users=${afterReplace.counts.users} 管理员仍在位`);

  const audit = await call('admin_audit', { limit: 200 }, relogin.json.token);
  const actions = (audit.json.rows ?? []).map((row) => row.action);
  ok('导入这件事本身留在审计里，且历史审计没被覆盖抹掉', actions.includes('admin_backup_apply')
    && actions.includes('admin_backup_export') && actions.includes('admin_settings'),
  `${actions.length} 条审计 · ${[...new Set(actions)].join(',')}`);

  // 第三次导入触发快照轮换：BACKUP_KEEP=2，目录里最多只能有 2 份
  const third = await call('admin_backup_apply', { document: afterReplace, mode: 'config', ack: afterReplace.checksum.slice(0, 6), confirm: true }, relogin.json.token);
  const kept = snapshotFiles();
  ok('导入前快照自动落盘且只保留最近 2 份', third.status === 200 && kept.length === 2,
    `${kept.length} 份：${kept.map((name) => name.slice(12, 34)).join(' / ')}`);
  ok('快照文件本身可被再次解析为备份文档，并比常规导出多带会话摘要', (() => {
    const parsed = JSON.parse(readFileSync(join(backupDir, kept[kept.length - 1]), 'utf8'));
    return parsed.format === 'mirrordesk-backup' && parsed.meta?.reason === 'pre-import'
      && parsed.tables.users?.length === 4 && (parsed.tables.sessions?.length ?? 0) >= 1;
  })());
} catch (error) {
  ok('接口层跑完', false, String(error?.message ?? error).slice(0, 200));
} finally {
  child.kill();
}

// ---- 第三部分：命令行。同一个备份文件，用 CLI 恢复到另一个库 ----
const cli = (args, env = {}) => {
  const result = spawnSync(process.execPath, ['scripts/backup.mjs', ...args], {
    cwd: ROOT, encoding: 'utf8',
    env: { ...process.env, DB_DRIVER: 'sqlite', DB_PATH: join(dir, 'cli.db'), BACKUP_DIR: join(dir, 'cli-backups'), ...env },
  });
  return { code: result.status, out: `${result.stdout ?? ''}${result.stderr ?? ''}` };
};

const cliFile = join(dir, 'cli-backup.json');
writeFileSync(cliFile, JSON.stringify(document), 'utf8');

const cliExport = cli(['export']);
ok('CLI export：空库也能出一份合法文档', cliExport.code === 0 && /已导出/.test(cliExport.out),
  cliExport.out.split('\n').find((line) => line.includes('已导出'))?.trim().slice(0, 90) ?? cliExport.out.slice(0, 80));

const cliPreview = cli(['preview', cliFile], { DB_PATH: join(dir, 'src.db') });
ok('CLI preview：列出两种模式与逐表对照', cliPreview.code === 0 && cliPreview.out.includes('模式 replace')
  && cliPreview.out.includes('保留并追加'), `退出码 ${cliPreview.code}`);

const tamperFile = join(dir, 'tampered.json');
writeFileSync(tamperFile, JSON.stringify(badColumn), 'utf8');
const cliBad = cli(['preview', tamperFile], { DB_PATH: join(dir, 'src.db') });
ok('CLI preview：非法文件退出码 1 且逐项报因', cliBad.code === 1 && /未通过校验/.test(cliBad.out),
  cliBad.out.split('\n').find((line) => line.includes('问题'))?.trim().slice(0, 80) ?? '');

const cliNoYes = cli(['import', cliFile], { DB_PATH: join(dir, 'dst.db') });
ok('CLI import replace 不带 --yes 时拒绝执行', cliNoYes.code === 2 && /--yes/.test(cliNoYes.out),
  cliNoYes.out.split('\n').find((line) => line.includes('replace 会清空'))?.trim().slice(0, 70) ?? '');

const cliImport = cli(['import', cliFile, '--mode', 'replace', '--yes'], { DB_PATH: join(dir, 'dst.db') });
const cliDst = await createDb({ driver: 'sqlite', path: join(dir, 'dst.db') });
const cliAfter = await backupOverview(cliDst);
await cliDst.close();
ok('CLI import：整库恢复到位并留下导入前快照', cliImport.code === 0
  && cliAfter.tables.users === 3 && cliAfter.tables.orders === 1 && cliAfter.tables.audit === 5
  && readdirSync(join(dir, 'cli-backups')).some((name) => name.startsWith('pre-import-')),
  `users=${cliAfter.tables.users} audit=${cliAfter.tables.audit} ${cliImport.out.split('\n').find((line) => line.includes('导入完成：'))?.trim().slice(0, 60) ?? ''}`);

const cliConfig = cli(['import', cliFile, '--mode', 'config'], { DB_PATH: join(dir, 'dst.db') });
ok('CLI import --mode config 不需要 --yes（只动配置）', cliConfig.code === 0 && /写入 2/.test(cliConfig.out),
  cliConfig.out.split('\n').find((line) => line.includes('导入完成：'))?.trim().slice(0, 60) ?? '');

await src.close();
await dst.close();
await dst3.close();
await new Promise((r) => setTimeout(r, 300));
try {
  rmSync(dir, { recursive: true, force: true });
} catch { /* Windows 上 sqlite 文件句柄可能还没释放，临时目录交给系统清理 */ }

const failures = results.filter((line) => line.startsWith('FAIL')).length;
console.log(results.join('\n'));
console.log(`\nSUMMARY pass=${results.length - failures} fail=${failures}`);
process.exit(failures ? 1 : 0);
