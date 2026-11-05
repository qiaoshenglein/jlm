// 后台管理 UI 探针：权限入口、二次确认、冻结与注册开关的真实点击路径。
// 用法：node dev/admin-probe.mjs   （独立临时库，绝不碰 data/mirror.db）
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require('D:/game/cf-transport-ship/node_modules/playwright-core');
const ROOT = resolve(import.meta.dirname, '..');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BOSS = 'probe_boss';
const VICTIM = 'probe_victim';

const results = [];
const ok = (name, pass, detail = '') => results.push(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ` :: ${detail}` : ''}`);
const freePort = () => new Promise((done) => {
  const probe = createServer();
  probe.listen(0, '127.0.0.1', () => { const p = probe.address().port; probe.close(() => done(p)); });
});

const dir = mkdtempSync(join(tmpdir(), 'adm-probe-'));
const port = await freePort();
const child = spawn(process.execPath, ['server/index.mjs'], {
  cwd: ROOT,
  env: {
    ...process.env, PORT: String(port), HOST: '127.0.0.1',
    DB_DRIVER: 'sqlite', DB_PATH: join(dir, 'adm.db'), ADMIN_USERNAMES: BOSS,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let boot = '';
child.stdout.on('data', (chunk) => { boot += chunk.toString(); });
child.stderr.on('data', (chunk) => process.stderr.write(chunk));

const base = `http://127.0.0.1:${port}`;
let browser = null;
try {
  let up = false;
  for (let i = 0; i < 40; i++) {
    try { const ping = await fetch(`${base}/healthz`, { cache: 'no-store' }); if (ping.ok) { up = true; break; } } catch { /* wait */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  ok('server-up', up, base);
  await new Promise((r) => setTimeout(r, 300));
  ok('startup-logs-admin', /ADMIN|管理员|后台/.test(boot), boot.split('\n').filter((line) => /后台/.test(line)).join(' ').slice(0, 90));

  browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--mute-audio'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error.message).slice(0, 140)));
  await page.goto(base, { waitUntil: 'domcontentloaded' });

  const tokens = await page.evaluate(async ({ boss, victim }) => {
    const make = async (username) => {
      const response = await fetch('/functions/v1/app?action=register', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password: 'probe12345', display: username === boss ? '主管理员' : '被测试账户' }),
      });
      return response.json();
    };
    const b = await make(boss);
    const v = await make(victim);
    localStorage.setItem('mirror.desk.token', b.token);
    return { boss: b.token, victim: v.token, bossOk: Boolean(b.ok), victimOk: Boolean(v.ok) };
  }, { boss: BOSS, victim: VICTIM });
  ok('two-accounts-created', tokens.bossOk && tokens.victimOk);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelectorAll('.dense-row:not([aria-hidden])').length > 0, null, { timeout: 25_000 });

  ok('admin-entry-visible', (await page.getByRole('button', { name: '后台', exact: true }).count()) === 1);
  await page.getByRole('button', { name: '后台', exact: true }).click();
  await page.waitForFunction(() => document.body.innerText.includes('后台管理'), null, { timeout: 8_000 });
  ok('hash-route-opens-admin', page.url().endsWith('#/admin'), page.url());

  const cards = await page.evaluate(() => [...document.querySelectorAll('p.num')].map((el) => el.textContent.trim()));
  ok('overview-renders-stats', cards.length >= 5 && cards.includes('2'), `cards=${cards.length} 账户总数=${cards[0]}`);

  await page.getByRole('tab', { name: '账户' }).click();
  await page.waitForFunction(() => document.querySelectorAll('tbody tr').length >= 2, null, { timeout: 8_000 });
  const rowCount = await page.locator('tbody tr').count();
  ok('users-table-lists-accounts', rowCount >= 2, `rows=${rowCount}`);

  const box = page.locator('input[aria-label="搜索账户"]');
  await box.fill(VICTIM);
  await page.waitForFunction(() => document.querySelectorAll('tbody tr').length === 1, null, { timeout: 8_000 });
  ok('admin-search-filters', (await page.locator('tbody tr').count()) === 1, VICTIM);

  const freeze = page.getByRole('button', { name: '冻结', exact: true });
  await freeze.click();
  const armed = await page.getByRole('button', { name: '确认冻结', exact: true }).count();
  ok('danger-action-arms-first', armed === 1, `armed=${armed}`);
  await page.getByRole('button', { name: '确认冻结', exact: true }).click();
  await page.waitForFunction(() => document.body.innerText.includes('已冻结'), null, { timeout: 8_000 });
  ok('freeze-applies', true, '行内状态变为已冻结');

  const frozenOrder = await page.evaluate(async (token) => {
    const response = await fetch('/functions/v1/app?action=order', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, side: 'buy', secid: '1.510300', qty: 100, mode: 'market', leaf: 1 }),
    });
    return response.json();
  }, tokens.victim);
  ok('frozen-account-cannot-trade', frozenOrder.code === 'account_frozen', frozenOrder.code ?? 'ok');

  await page.getByRole('button', { name: '解冻', exact: true }).click();
  await page.getByRole('button', { name: '确认解冻', exact: true }).click();
  await page.waitForFunction(() => !document.body.innerText.includes('已冻结'), null, { timeout: 8_000 });
  const unfrozenOrder = await page.evaluate(async (token) => {
    const response = await fetch('/functions/v1/app?action=order', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, side: 'buy', secid: '1.510300', qty: 100, mode: 'market', leaf: 1 }),
    });
    return response.json();
  }, tokens.victim);
  // 收盘时段下单会被其它规则拦，这里只验证「冻结」这道闸门已经放开
  ok('unfreeze-restores-trading', unfrozenOrder.code !== 'account_frozen', unfrozenOrder.code ?? 'ok');

  await page.getByRole('tab', { name: '参数' }).click();
  await page.waitForFunction(() => document.body.innerText.includes('允许新账户注册'), null, { timeout: 8_000 });
  await page.getByRole('checkbox', { name: '允许新账户注册' }).uncheck();
  await page.getByRole('button', { name: '保存参数', exact: true }).click();
  await page.getByRole('button', { name: '确认保存', exact: true }).click();
  await page.waitForTimeout(700);
  const blocked = await page.evaluate(async () => {
    const response = await fetch('/functions/v1/app?action=register', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'probe_late', password: 'probe12345' }),
    });
    return response.json();
  });
  ok('register-switch-takes-effect', blocked.code === 'register_closed', blocked.code ?? 'ok');
  await page.getByRole('checkbox', { name: '允许新账户注册' }).check();
  await page.getByRole('button', { name: '保存参数', exact: true }).click();
  await page.getByRole('button', { name: '确认保存', exact: true }).click();
  await page.waitForTimeout(600);

  await page.getByRole('tab', { name: '审计' }).click();
  await page.waitForFunction(() => document.querySelectorAll('tbody tr').length >= 3, null, { timeout: 8_000 });
  const auditText = await page.evaluate(() => document.querySelector('tbody')?.innerText ?? '');
  ok('audit-records-admin-actions', auditText.includes('冻结账户') && auditText.includes('修改参数'),
    `审计行数=${await page.locator('tbody tr').count()}`);
  ok('audit-hides-secrets', !auditText.includes('pass_hash') && !auditText.includes(tokens.boss.slice(0, 12)));

  const layout = await page.evaluate(() => ({
    overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    overflowY: document.documentElement.scrollHeight - document.documentElement.clientHeight,
    panelBottom: Math.round(document.querySelector('.panel')?.getBoundingClientRect().bottom ?? 0),
  }));
  ok('admin-layout-fits-viewport', layout.overflowX <= 0 && layout.overflowY <= 0 && layout.panelBottom <= 900, JSON.stringify(layout));

  // 顶栏与后台面板各有一个「返回交易台」，两个都要能用
  const exitCount = await page.getByRole('button', { name: '返回交易台', exact: true }).count();
  ok('two-exit-buttons', exitCount === 2, `count=${exitCount}`);
  await page.getByRole('button', { name: '返回交易台', exact: true }).first().click();
  await page.waitForFunction(() => document.body.innerText.includes('镜盘') && !location.hash, null, { timeout: 8_000 });
  ok('back-to-desk', true, 'hash 清空并回到交易台');

  // 普通用户直接敲 #/admin：入口不存在，接口也拿不到数据
  await page.evaluate((token) => localStorage.setItem('mirror.desk.token', token), tokens.victim);
  await page.goto(`${base}/#/admin`, { waitUntil: 'domcontentloaded' });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.body.innerText.includes('镜盘'), null, { timeout: 15_000 });
  const denied = await page.evaluate(async (token) => {
    const response = await fetch('/functions/v1/app?action=admin_overview', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }),
    });
    return { status: response.status, code: (await response.json()).code };
  }, tokens.victim);
  ok('non-admin-blocked-server-side', denied.status === 403 && denied.code === 'not_admin', `${denied.status} ${denied.code}`);
  ok('non-admin-sees-no-admin-ui', !(await page.evaluate(() => document.body.innerText.includes('ADMIN DESK'))));

  ok('no-page-errors', errors.length === 0, errors.join(' | '));
} catch (error) {
  ok('probe-completed', false, String(error.message).slice(0, 220));
} finally {
  await browser?.close().catch(() => {});
  child.kill();
  console.log(results.join('\n'));
  console.log(`SUMMARY pass=${results.filter((line) => line.startsWith('PASS')).length} fail=${results.filter((line) => line.startsWith('FAIL')).length}`);
}
