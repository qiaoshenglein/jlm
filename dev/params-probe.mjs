// P1 后台探针：挂牌参数热改、撮合熔断、全平台流水页。用法：node dev/params-probe.mjs
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
const BOSS = 'pp_boss';

const results = [];
const ok = (name, pass, detail = '') => results.push(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ` :: ${detail}` : ''}`);
const freePort = () => new Promise((done) => {
  const probe = createServer();
  probe.listen(0, '127.0.0.1', () => { const p = probe.address().port; probe.close(() => done(p)); });
});

const dir = mkdtempSync(join(tmpdir(), 'pp-probe-'));
const port = await freePort();
const child = spawn(process.execPath, ['server/index.mjs'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DB_DRIVER: 'sqlite', DB_PATH: join(dir, 'pp.db'), ADMIN_USERNAMES: BOSS },
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stdout.on('data', () => {});
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

  browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--mute-audio'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error.message).slice(0, 140)));
  await page.goto(base, { waitUntil: 'domcontentloaded' });

  const session = await page.evaluate(async (boss) => {
    const make = async (username, display) => {
      const response = await fetch('/functions/v1/app?action=register', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password: 'probe12345', display }),
      });
      return response.json();
    };
    const b = await make(boss, '参数管理员');
    const t = await make('pp_trader', '交易员');
    // 造几笔委托：一笔正常、一笔必然废单（数量不是 100 的整数倍会被拒）
    await fetch('/functions/v1/app?action=order', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: t.token, side: 'buy', secid: '1.510300', qty: 100, mode: 'market', leaf: 1 }),
    });
    await fetch('/functions/v1/app?action=order', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: t.token, side: 'buy', secid: '1.510300', qty: 150, mode: 'market', leaf: 1 }),
    });
    localStorage.setItem('mirror.desk.token', b.token);
    return { boss: b.token, trader: t.token };
  }, BOSS);
  await page.goto(`${base}/#/admin`, { waitUntil: 'domcontentloaded' });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.body.innerText.includes('后台管理'), null, { timeout: 25_000 });

  await page.waitForFunction(() => document.body.innerText.includes('风险账户'), null, { timeout: 15_000 });
  const overviewText = await page.evaluate(() => document.body.innerText);
  ok('overview-shows-risk-and-breaker', overviewText.includes('风险账户') && overviewText.includes('撮合'), '概览新增两张卡');

  await page.getByRole('tab', { name: '参数' }).click();
  await page.waitForFunction(() => document.body.innerText.includes('股票佣金'), null, { timeout: 8_000 });
  const feeInput = page.locator('input[aria-label^="股票佣金"]');
  const breaker = page.getByRole('checkbox', { name: '沪深撮合熔断' });
  ok('settings-form-renders', (await feeInput.count()) === 1 && (await breaker.count()) === 1
    && (await page.getByRole('checkbox', { name: '美股撮合熔断' }).count()) === 1
    && (await page.locator('input[aria-label^="平仓线"]').count()) === 1
    && (await page.locator('input[aria-label^="新账户默认美元本金"]').count()) === 1,
    '熔断两把开关 + 美元本金输入框');
  const feeBefore = await feeInput.inputValue();
  await feeInput.fill('5');
  await page.getByRole('button', { name: '保存参数', exact: true }).click();
  await page.getByRole('button', { name: '确认保存', exact: true }).click();
  await page.waitForTimeout(800);
  await page.getByRole('tab', { name: '概览' }).click();
  await page.getByRole('tab', { name: '参数' }).click();
  await page.waitForTimeout(600);
  const feeStored = await page.locator('input[aria-label^="股票佣金"]').inputValue();
  ok('fee-change-persists', feeStored === '5' && feeBefore !== '5', `${feeBefore} → ${feeStored}`);
  await page.locator('input[aria-label^="股票佣金"]').fill(feeBefore);
  await page.getByRole('button', { name: '保存参数', exact: true }).click();
  await page.getByRole('button', { name: '确认保存', exact: true }).click();
  await page.waitForTimeout(600);

  // 美股参数：换一组字段名，且改这里不会动 A 股那一组
  await page.getByRole('tab', { name: '美股参数' }).click();
  await page.waitForFunction(() => document.body.innerText.includes('SEC 费'), null, { timeout: 8_000 });
  const usCommission = page.locator('input[aria-label^="佣金（万分之）"]');
  const usCommissionBefore = await usCommission.inputValue();
  await usCommission.fill('8');
  await page.getByRole('button', { name: '保存参数', exact: true }).click();
  await page.getByRole('button', { name: '确认保存', exact: true }).click();
  await page.waitForTimeout(900);
  const usStored = await page.evaluate(async () => {
    const response = await fetch('/functions/v1/app?action=rules', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ market: 'us' }),
    });
    return response.json();
  });
  const cnAfterUsEdit = await page.evaluate(async () => {
    const response = await fetch('/functions/v1/app?action=rules', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ market: 'cn' }),
    });
    return response.json();
  });
  ok('us-params-isolated', Math.abs((usStored.rules?.us?.fees?.commission ?? 0) * 1e4 - 8) < 0.01
    && Math.abs((cnAfterUsEdit.rules?.cn?.fees?.stockCommission ?? 0) * 1e4 - Number(feeBefore)) < 0.01,
    `美股 万 ${usStored.rules?.us?.fees?.commission * 1e4} · A 股股票佣金仍万 ${cnAfterUsEdit.rules?.cn?.fees?.stockCommission * 1e4}`);
  await usCommission.fill(usCommissionBefore);
  const activityValue = await page.locator('input[aria-label^="FINRA 活动费"]').inputValue();
  const capValue = await page.locator('input[aria-label^="活动费单笔上限"]').inputValue();
  ok('micro-fee-fields-show-clean-values', activityValue === '0.000166' && capValue === '8.3',
    `活动费 ${activityValue} · 上限 ${capValue}`);
  await page.getByRole('button', { name: '保存参数', exact: true }).click();
  await page.getByRole('button', { name: '确认保存', exact: true }).click();
  await page.waitForTimeout(600);
  await page.getByRole('tab', { name: '沪深参数' }).click();
  await page.waitForTimeout(300);

  // 熔断：开 → 下单被拒 + 顶栏提示 → 关
  await breaker.check();
  await page.getByRole('button', { name: '保存参数', exact: true }).click();
  await page.getByRole('button', { name: '确认保存', exact: true }).click();
  await page.waitForTimeout(1_200);
  const pausedOrder = await page.evaluate(async (token) => {
    const response = await fetch('/functions/v1/app?action=order', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, side: 'buy', secid: '1.510300', qty: 200, mode: 'market', leaf: 1 }),
    });
    return response.json();
  }, session.trader);
  ok('breaker-rejects-new-orders', pausedOrder.code === 'match_paused', pausedOrder.code ?? 'ok');
  // 熔断状态是每 3 秒同步时随信封下发的，等提示出现而不是等固定毫秒
  const headerSeen = await page.waitForFunction(
    () => (document.querySelector('header')?.innerText ?? '').includes('暂停沪深撮合'),
    null, { timeout: 9_000 },
  ).then(() => true).catch(() => false);
  const headerText = await page.evaluate(() => (document.querySelector('header')?.innerText ?? '').split('\n').join(' | '));
  ok('desk-header-shows-breaker', headerSeen, headerText.slice(0, 150));
  await breaker.uncheck();
  await page.getByRole('button', { name: '保存参数', exact: true }).click();
  await page.getByRole('button', { name: '确认保存', exact: true }).click();
  await page.waitForTimeout(1_200);
  const resumedOrder = await page.evaluate(async (token) => {
    // 换一个标的，避免撞上「15 秒内完全相同委托」的重复下单拦截
    const response = await fetch('/functions/v1/app?action=order', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, side: 'buy', secid: '1.510050', qty: 100, mode: 'market', leaf: 1 }),
    });
    return response.json();
  }, session.trader);
  // 这里只验「熔断已解除」：能否成交取决于当前时刻是否在交易时段，那是 selftest 用固定时钟覆盖的事
  ok('breaker-off-restores-orders', resumedOrder.code !== 'match_paused', resumedOrder.code ?? 'ok');

  // 分市场熔断：只停美股时 A 股那一边的开关状态必须仍然是开的
  const usBreaker = page.getByRole('checkbox', { name: '美股撮合熔断' });
  await usBreaker.check();
  await page.getByRole('button', { name: '保存参数', exact: true }).click();
  await page.getByRole('button', { name: '确认保存', exact: true }).click();
  await page.waitForTimeout(1_200);
  const splitState = await page.evaluate(async (token) => {
    const post = async (action, payload) => (await fetch(`/functions/v1/app?action=${action}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...payload, token }),
    })).json();
    const order = await post('order', { market: 'us', side: 'buy', secid: '105.AAPL', qty: 1, mode: 'market', leaf: 1 });
    return {
      order: order.code ?? 'ok',
      cn: await post('board', { market: 'cn' }),
      us: await post('board', { market: 'us' }),
    };
  }, session.trader);
  await page.getByRole('tab', { name: '概览' }).click();
  await page.waitForTimeout(700);
  const overviewNow = await page.evaluate(() => document.body.innerText);
  ok('us-breaker-blocks-only-us', splitState.order === 'match_paused'
    && splitState.cn.matchPaused === false && splitState.us.matchPaused === true
    && splitState.cn.markets?.cn?.paused === false && splitState.us.markets?.us?.paused === true,
    `美股下单 ${splitState.order} · A 股熔断 ${splitState.cn.matchPaused}`);
  ok('overview-shows-which-market-paused', overviewNow.includes('美股熔断'), overviewNow.split('\n').find((line) => line.includes('熔断'))?.slice(0, 60) ?? '');
  await page.getByRole('tab', { name: '参数' }).click();
  await page.waitForTimeout(400);
  await usBreaker.uncheck();
  await page.getByRole('button', { name: '保存参数', exact: true }).click();
  await page.getByRole('button', { name: '确认保存', exact: true }).click();
  await page.waitForTimeout(900);

  await page.getByRole('tab', { name: '流水' }).click();
  await page.waitForFunction(() => document.querySelectorAll('tbody tr').length >= 3, null, { timeout: 8_000 });
  const flowRows = await page.locator('tbody tr').count();
  ok('flow-page-lists-orders', flowRows >= 3, `rows=${flowRows}`);
  await page.getByRole('combobox', { name: '按委托状态筛选' }).selectOption('rejected');
  await page.getByRole('button', { name: '应用筛选' }).click();
  await page.waitForTimeout(900);
  const rejectedText = await page.evaluate(() => document.querySelector('tbody')?.innerText ?? '');
  ok('flow-status-filter-works', rejectedText.includes('废单') || (await page.locator('tbody tr').count()) === 0, rejectedText.slice(0, 40).replace(/\n/g, ' '));
  ok('flow-is-read-only', (await page.getByRole('button', { name: '删除' }).count()) === 0);

  const layout = await page.evaluate(() => ({
    overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    overflowY: document.documentElement.scrollHeight - document.documentElement.clientHeight,
  }));
  ok('layout-fits', layout.overflowX <= 0 && layout.overflowY <= 0, JSON.stringify(layout));
  ok('no-page-errors', errors.length === 0, errors.join(' | '));
} catch (error) {
  ok('probe-completed', false, String(error.message).slice(0, 220));
} finally {
  await browser?.close().catch(() => {});
  child.kill();
  console.log(results.join('\n'));
  console.log(`SUMMARY pass=${results.filter((line) => line.startsWith('PASS')).length} fail=${results.filter((line) => line.startsWith('FAIL')).length}`);
}
