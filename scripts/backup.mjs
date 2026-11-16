// 命令行整库备份：不经过 HTTP，大库恢复与 cron 归档走这条路最稳。
// 用法：
//   node scripts/backup.mjs export [--out 路径] [--only-config] [--with-sessions] [--no-audit] [--proxy-plain]
// 代理列表 API 的地址默认打码导出（那串 URL 常常就是凭证）；要原样带走加 --proxy-plain。
//   node scripts/backup.mjs preview <备份文件>
//   node scripts/backup.mjs import <备份文件> [--mode replace|config] [--yes] [--no-snapshot]
// 数据库连接沿用服务的环境变量：DB_DRIVER / DB_PATH / DATABASE_URL / DB_SCHEMA。
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createDb } from '../server/db.mjs';
import { createBackupFiles } from '../server/backups.mjs';
import { applyBackup, backupOverview, exportBackup, inspectBackup, planBackup } from '../functions/backup.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const argv = process.argv.slice(2);
const command = argv[0];
const positional = argv.slice(1).filter((item) => !item.startsWith('--'));
const has = (name) => argv.includes(`--${name}`);
const flag = (name, fallback = null) => {
  const inline = argv.find((item) => item.startsWith(`--${name}=`));
  if (inline) return inline.slice(inline.indexOf('=') + 1);
  const index = argv.indexOf(`--${name}`);
  return index >= 0 && argv[index + 1] && !argv[index + 1].startsWith('--') ? argv[index + 1] : fallback;
};

const USAGE = `用法：
  node scripts/backup.mjs export [--out 路径] [--only-config] [--with-sessions] [--no-audit] [--proxy-plain]
  node scripts/backup.mjs preview <备份文件>
  node scripts/backup.mjs import <备份文件> [--mode replace|config] [--yes] [--no-snapshot]`;

const pad = (text, width) => String(text).padEnd(width, ' ');
function table(rows) {
  for (const row of rows) console.log(`  ${pad(row[0], 12)}${pad(row[1], 10)}${row[2] ?? ''}`);
}

const db = await createDb();
// 恢复到新机器时表可能还不存在；migrate 是幂等的，重复执行安全
if (!has('no-migrate')) await db.migrate(db.driver);
const files = createBackupFiles({
  dir: resolve(ROOT, process.env.BACKUP_DIR ?? join('data', 'backups')),
  keep: Math.max(1, Number(process.env.BACKUP_KEEP ?? 10)),
});

const current = await backupOverview(db);
console.log(`库：${db.driver}${db.schema ? ` schema=${db.schema}` : ''} · 合计 ${current.rows} 行`);

if (command === 'export') {
  const include = {
    data: !has('only-config'),
    config: true,
    audit: !has('no-audit'),
    sessions: has('with-sessions'),
  };
  const document = await exportBackup(db, {
    include, proxyPlain: has('proxy-plain'),
    meta: { driver: db.driver, schema: db.schema ?? null, by: 'cli' },
  });
  const out = resolve(ROOT, flag('out') ?? join(files.dir, `export-${document.created_at.replace(/[:.]/g, '-').slice(0, 19)}.json`));
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, JSON.stringify(document), 'utf8');
  table(Object.entries(document.counts).map(([name, n]) => [name, `${n} 行`, '']));
  console.log(`已导出 ${out}\n  ${document.rows} 行 · ${Math.round(document.bytes / 1024)}KB · checksum ${document.checksum}`);
  console.log('  文件含口令散列与 API 密钥摘要（都不 reversible），但仍要当凭据保管。');
} else if (command === 'preview' || command === 'import') {
  const path = positional[0] ? resolve(ROOT, positional[0]) : null;
  if (!path) {
    console.error(`${USAGE}\n\n缺少备份文件路径。`);
    process.exit(2);
  }
  let parsed = null;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    console.error(`读不了这个文件：${String(error.message).slice(0, 160)}`);
    process.exit(1);
  }
  const report = await inspectBackup(parsed);
  console.log(`文件：${report.rows} 行 · 导出于 ${report.created_at ?? '未知'} · checksum ${report.checksum ?? '无'}`);
  table(Object.entries(report.counts).map(([name, n]) => [name, `${n} 行`, '']));
  for (const line of report.warnings) console.log(`  提示 ${line}`);
  if (!report.ok) {
    for (const item of report.problems) console.log(`  问题 [${item.table ?? '文件'}] ${item.message}`);
    console.error(`\n未通过校验（${report.problems.length} 处），没有做任何改动。`);
    process.exit(1);
  }
  if (command === 'preview') {
    for (const mode of ['replace', 'config']) {
      if (!report.modes[mode]) {
        console.log(`\n模式 ${mode}：这份文件不支持${mode === 'replace' ? '（没有账户数据）' : '（没有 settings）'}`);
        continue;
      }
      const plan = await planBackup(db, report, mode);
      console.log(`\n模式 ${mode}：`);
      table(plan.rows.map((row) => [row.table, `${row.current}→${row.incoming}`, row.action]));
      for (const note of plan.notes) console.log(`  注意 ${note}`);
    }
    console.log(`\n预检通过。执行导入：node scripts/backup.mjs import ${positional[0]} --mode replace --yes`);
  } else {
    const wanted = flag('mode') ?? (report.modes.replace ? 'replace' : 'config');
    if (!['replace', 'config'].includes(wanted) || !report.modes[wanted]) {
      console.error(`--mode 只能是 replace 或 config，且这份文件要支持它（replace=${report.modes.replace} config=${report.modes.config}）。`);
      process.exit(2);
    }
    if (wanted === 'replace' && !has('yes')) {
      console.error('replace 会清空并覆盖整库账户、委托、成交、快照与配置。确认无误后加 --yes 再执行。');
      process.exit(2);
    }
    let snapshot = null;
    if (!has('no-snapshot')) {
      const before = await exportBackup(db, { meta: { driver: db.driver, by: 'cli', reason: 'pre-import' } });
      snapshot = await files.save(JSON.stringify(before));
      console.log(`导入前快照：${snapshot.path}（${Math.round(snapshot.bytes / 1024)}KB，目录保留 ${snapshot.kept} 份）`);
    }
    const result = await applyBackup(db, report, { mode: wanted });
    table(Object.entries(result.applied).map(([name, n]) => [name, `写入 ${n}`, `清空 ${result.cleared[name] ?? 0}`]));
    console.log(`\n导入完成：${wanted} · ${result.rows} 行 · ${result.took_ms}ms · checksum ${result.checksum}`);
    console.log(wanted === 'replace' && result.reauth_required
      ? '  文件里没有会话：所有人都要重新登录，包括你自己。'
      : '  配置已写入数据库；运行中的服务最多 2 秒后自动跟上参数缓存。');
    if (snapshot) console.log(`  要回滚：node scripts/backup.mjs import ${snapshot.path} --mode replace --yes`);
  }
} else {
  console.log(USAGE);
}

await db.close?.();
