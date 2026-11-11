// 美股视图目测截图：node dev/us-shot.mjs  ->  dev/.shots/us-*.png（临时脚本，看完可删）
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

const dir = mkdtempSync(join(tmpdir(), 'us-shot-'));
const port = await freePort();
const child = spawn(process.execPath, ['server/index.mjs'], {
  cwd: ROOT,
  env: {
    ...process.env, PORT: String(port), HOST: '127.0.0.1',
    DB_DRIVER: 'sqlite', DB_PATH: join(dir, 'us.db'), ADMIN_USERNAMES: 'us_boss',
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
  const trader = await page.evaluate(async () => {
    const r = await fetch('/functions/v1/app?action=register', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: `us_${Date.now().toString(36)}`, password: 'probe12345', display: '美股视图' }),
    });
    const d = await r.json();
    if (d?.ok) localStorage.setItem('mirror.desk.token', d.token);
    return d?.token ?? '';
  });
  // 先买两笔，让持仓与成交里有美元标的，截图才看得到双币种排版
  await page.evaluate(async (token) => {
    const board = await (await fetch('/functions/v1/app?action=board', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ market: 'us', token }),
    })).json();
    const picks = (board.market?.stocks ?? []).filter((q) => q.last > 5e6 && q.last < 8e8).slice(0, 2);
    for (const [index, quote] of picks.entries()) {
      await fetch('/functions/v1/app?action=order', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ market: 'us', token, side: index === 0 ? 'buy' : 'margin_buy', secid: quote.secid, qty: 40, mode: 'market', leaf: index === 0 ? 1 : 2 }),
      });
    }
  }, trader);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelectorAll('.dense-row:not([aria-hidden])').length > 0, null, { timeout: 25_000 });

  await page.getByRole('group', { name: '交易市场与开市状态' }).getByRole('button', { name: /美股/ }).click();
  await page.waitForFunction(() => localStorage.getItem('mirror.desk.market') === 'us', null, { timeout: 8_000 });
  await page.waitForTimeout(2_200);
  await page.getByRole('tab', { name: '个股' }).click();
  await page.waitForTimeout(600);
  await page.locator('.dense-row:not([aria-hidden])').first().click();
  await page.waitForTimeout(2_600);
  await page.screenshot({ path: join(OUT, 'us-desk.png') });
  await page.getByRole('button', { name: '持仓' }).click();
  await page.waitForTimeout(900);
  await page.screenshot({ path: join(OUT, 'us-positions.png') });
  await page.getByRole('button', { name: '风控与排行' }).click();
  await page.waitForTimeout(1_400);
  await page.screenshot({ path: join(OUT, 'us-risk.png') });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(1_200);
  await page.screenshot({ path: join(OUT, 'us-mobile.png') });
  await page.setViewportSize({ width: 1440, height: 900 });

  const boss = await page.evaluate(async () => {
    const r = await fetch('/functions/v1/app?action=register', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'us_boss', password: 'probe12345', display: '美股后台' }),
    });
    const d = await r.json();
    localStorage.setItem('mirror.desk.token', d.token);
    return Boolean(d?.ok);
  });
  await page.goto(`${base}/#/admin`, { waitUntil: 'domcontentloaded' });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.body.innerText.includes('后台管理'), null, { timeout: 25_000 });
  await page.getByRole('tab', { name: '参数' }).click();
  await page.waitForFunction(() => document.body.innerText.includes('股票佣金'), null, { timeout: 8_000 });
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(OUT, 'us-admin-params-cn.png') });
  await page.getByRole('tab', { name: '美股参数' }).click();
  await page.waitForTimeout(600);
  await page.screenshot({ path: join(OUT, 'us-admin-params-us.png') });
  await page.getByRole('tab', { name: '账户' }).click();
  await page.waitForTimeout(900);
  await page.screenshot({ path: join(OUT, 'us-admin-users.png'), clip: { x: 0, y: 120, width: 1440, height: 480 } });
  console.log('us shots written to', OUT, 'boss=', boss);
} finally {
  await browser?.close().catch(() => {});
  child.kill();
}
