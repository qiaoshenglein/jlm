// 后台界面出图：node dev/admin-shot.mjs  ->  dev/.shots/admin-*.png
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require('D:/game/cf-transport-ship/node_modules/playwright-core');
const ROOT = resolve(import.meta.dirname, '..');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const OUT = join(ROOT, 'dev', '.shots');
mkdirSync(OUT, { recursive: true });

const freePort = () => new Promise((done) => {
  const p = createServer();
  p.listen(0, '127.0.0.1', () => { const n = p.address().port; p.close(() => done(n)); });
});

const dir = mkdtempSync(join(tmpdir(), 'adm-shot-'));
const port = await freePort();
const child = spawn(process.execPath, ['server/index.mjs'], {
  cwd: ROOT,
  env: {
    ...process.env, PORT: String(port), HOST: '127.0.0.1',
    DB_DRIVER: 'sqlite', DB_PATH: join(dir, 'a.db'), ADMIN_USERNAMES: 'shot_boss',
    // 备份页会真的覆盖一次，导入前快照必须落在临时目录，不能进 data/backups
    BACKUP_DIR: join(dir, 'backups'),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stdout.on('data', () => {});
child.stderr.on('data', (c) => process.stderr.write(c));

const base = `http://127.0.0.1:${port}`;
let browser = null;
try {
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(`${base}/healthz`, { cache: 'no-store' }); if (r.ok) break; } catch { /* wait */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--font-render-hinting=none'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.evaluate(async () => {
    const make = async (username, display) => {
      const r = await fetch('/functions/v1/app?action=register', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password: 'shot12345', display }),
      });
      return r.json();
    };
    const boss = await make('shot_boss', '主管理员');
    await make('zhang_san', '张三');
    await make('li_si', '李四');
    localStorage.setItem('mirror.desk.token', boss.token);
  });
  await page.goto(`${base}/#/admin`, { waitUntil: 'domcontentloaded' });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.body.innerText.includes('后台管理'), null, { timeout: 25_000 });
  await page.waitForTimeout(900);
  await page.screenshot({ path: join(OUT, 'admin-overview.png') });

  await page.getByRole('tab', { name: '账户' }).click();
  await page.waitForFunction(() => document.querySelectorAll('tbody tr').length >= 3, null, { timeout: 8_000 });
  await page.getByRole('button', { name: '资金调整' }).first().click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(OUT, 'admin-users.png') });

  await page.getByRole('tab', { name: '参数' }).click();
  await page.waitForFunction(() => document.body.innerText.includes('注册邀请码'), null, { timeout: 8_000 });
  await page.screenshot({ path: join(OUT, 'admin-settings.png') });

  await page.getByRole('tab', { name: '行情源' }).click();
  await page.waitForFunction(() => /立即检测 \d+ 项/.test(document.body.innerText), null, { timeout: 12_000 });
  await page.screenshot({ path: join(OUT, 'admin-quote.png') });
  await page.getByRole('button', { name: /立即检测 \d+ 项/ }).click();
  await page.waitForFunction(() => document.querySelectorAll('table tbody tr').length >= 8, null, { timeout: 60_000 });
  await page.screenshot({ path: join(OUT, 'admin-quote-check.png') });

  await page.getByRole('tab', { name: '流水' }).click();
  await page.waitForTimeout(900);
  await page.screenshot({ path: join(OUT, 'admin-flow.png') });

  // 制造几条审计再出图
  await page.getByRole('tab', { name: '账户' }).click();
  await page.waitForTimeout(400);
  await page.getByRole('button', { name: '冻结', exact: true }).first().click();
  await page.getByRole('button', { name: '确认冻结', exact: true }).click();
  await page.waitForTimeout(600);
  await page.getByRole('tab', { name: '审计' }).click();
  await page.waitForFunction(() => document.querySelectorAll('tbody tr').length >= 1, null, { timeout: 8_000 });
  await page.screenshot({ path: join(OUT, 'admin-audit.png') });

  // 备份页：导出 → 下载 → 回传 → 预检 → 真的覆盖一次（这个库是临时库，可以随便折腾）
  await page.getByRole('tab', { name: '备份' }).click();
  await page.waitForFunction(() => document.body.innerText.includes('生成导出'), null, { timeout: 10_000 });
  await page.screenshot({ path: join(OUT, 'admin-backup-empty.png') });

  await page.getByRole('button', { name: '生成导出' }).click();
  await page.waitForFunction(() => document.body.innerText.includes('checksum'), null, { timeout: 20_000 });
  const backupPath = join(dir, 'shot-backup.json');
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 20_000 }),
    page.getByRole('button', { name: '下载 JSON' }).click(),
  ]);
  await download.saveAs(backupPath);
  await page.screenshot({ path: join(OUT, 'admin-backup-export.png') });

  await page.setInputFiles('input[type=file]', backupPath);
  await page.waitForFunction(() => document.body.innerText.includes('预检'), null, { timeout: 10_000 });
  await page.getByRole('button', { name: '预检', exact: true }).click();
  await page.waitForFunction(() => document.body.innerText.includes('校验通过'), null, { timeout: 25_000 });
  await page.screenshot({ path: join(OUT, 'admin-backup-preview.png') });

  const prefix = await page.evaluate(() => document.body.innerText.match(/checksum\s+([0-9a-f]{12})/)?.[1]?.slice(0, 6) ?? '');
  await page.getByLabel('校验和前 6 位').fill(prefix);
  await page.getByRole('button', { name: '确认覆盖全站' }).click();
  await page.getByRole('button', { name: '再点一次执行覆盖' }).click();
  await page.waitForFunction(() => document.body.innerText.includes('导入前快照'), null, { timeout: 30_000 });
  await page.getByText('导入前快照').scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(OUT, 'admin-backup-applied.png') });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(700);
  await page.screenshot({ path: join(OUT, 'admin-mobile.png') });
  console.log('admin shots written to', OUT);
} finally {
  await browser?.close().catch(() => {});
  child.kill();
}
