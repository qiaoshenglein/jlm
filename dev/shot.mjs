// eyeball shots for the paginated list: node dev/shot.mjs  ->  dev/.shots/*.png
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

const dir = mkdtempSync(join(tmpdir(), 'mkt-shot-'));
const port = await freePort();
const child = spawn(process.execPath, ['server/index.mjs'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DB_DRIVER: 'sqlite', DB_PATH: join(dir, 's.db'), BACKUP_DIR: join(dir, 'backups') },
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
  const token = await page.evaluate(async () => {
    const r = await fetch('/functions/v1/app?action=register', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: `sh_${Date.now().toString(36)}`, password: 'probe12345', display: 'shot' }),
    });
    const d = await r.json();
    if (d?.ok) localStorage.setItem('mirror.desk.token', d.token);
    return d?.token ?? '';
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelectorAll('.dense-row:not([aria-hidden])').length > 0, null, { timeout: 25_000 });

  for (const item of [
    { secid: '1.600519', code: '600519', name: '贵州茅台', kind: 'stock' },
    { secid: '1.510300', code: '510300', name: '沪深300ETF', kind: 'etf' },
    { secid: '0.399006', code: '399006', name: '创业板指', kind: 'index' },
  ]) {
    await page.evaluate(async (payload) => {
      await fetch('/functions/v1/app?action=watch_add', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
      });
    }, { ...item, token });
  }

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelectorAll('.dense-row:not([aria-hidden])').length > 0, null, { timeout: 25_000 });
  await page.getByRole('tab', { name: '自选' }).click();
  await page.waitForTimeout(900);
  await page.screenshot({ path: join(OUT, 'desk-watch.png') });

  await page.getByRole('tab', { name: '个股' }).click();
  await page.waitForTimeout(400);
  await page.locator('.dense-row:not([aria-hidden])').first().click();
  await page.waitForTimeout(2_500);
  await page.screenshot({ path: join(OUT, 'desk-chart.png') });

  // 日 K / 周 K + MACD 副图：十字线停在图上，读数框里要能看到 DIF/DEA/柱
  await page.getByRole('button', { name: '日 K', exact: true }).click();
  await page.waitForTimeout(2_500);
  const chartBox = await page.locator('svg[role="img"][aria-label*="K 线"]').boundingBox();
  await page.mouse.move(chartBox.x + chartBox.width * 0.62, chartBox.y + chartBox.height * 0.3);
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(OUT, 'chart-daily-macd.png') });
  await page.getByRole('button', { name: '周 K', exact: true }).click();
  await page.waitForTimeout(2_500);
  await page.mouse.move(chartBox.x + chartBox.width * 0.62, chartBox.y + chartBox.height * 0.3);
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(OUT, 'chart-weekly-macd.png') });
  await page.getByRole('button', { name: '分时', exact: true }).click();
  await page.waitForTimeout(900);

  await page.getByRole('button', { name: '疏' }).click();
  await page.waitForTimeout(600);
  await page.screenshot({ path: join(OUT, 'desk-roomy.png') });
  await page.getByRole('button', { name: '紧' }).click();
  await page.waitForTimeout(600);
  await page.screenshot({ path: join(OUT, 'desk-compact.png') });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(900);
  await page.screenshot({ path: join(OUT, 'mobile-quote.png') });
  console.log('shots written to', OUT);
} finally {
  await browser?.close().catch(() => {});
  child.kill();
}
