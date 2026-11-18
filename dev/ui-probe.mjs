// UI geometry probe: fixed-height paginated stock list. Run: node dev/ui-probe.mjs
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

const results = [];
const ok = (name, pass, detail = '') => results.push(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ` :: ${detail}` : ''}`);
const at = (text) => { const m = text.match(/(\d+)\s*\/\s*(\d+)/); return m ? [Number(m[1]), Number(m[2])] : null; };
const freePort = () => new Promise((done) => {
  const probe = createServer();
  probe.listen(0, '127.0.0.1', () => { const p = probe.address().port; probe.close(() => done(p)); });
});

const dir = mkdtempSync(join(tmpdir(), 'mkt-probe-'));
const port = await freePort();
const child = spawn(process.execPath, ['server/index.mjs'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DB_DRIVER: 'sqlite', DB_PATH: join(dir, 'probe.db'), BACKUP_DIR: join(dir, 'backups') },
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stdout.on('data', () => {});
child.stderr.on('data', (chunk) => process.stderr.write(chunk));

const base = `http://127.0.0.1:${port}`;
let browser = null;
try {
  let up = false;
  for (let i = 0; i < 40; i++) {
    try {
      const ping = await fetch(`${base}/healthz`, { cache: 'no-store' });
      if (ping.ok) { up = true; break; }
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  ok('server-up', up, base);

  // 上游拒连时每条断言都会变成超时，先把「行情源不可用」和「探针本身失败」分开说清楚。
  // 注意 board 在取不到行情时仍回 ok:true（只是池子为空），所以闸门看的是行数而不是 ok。
  const quoteGate = await fetch(`${base}/functions/v1/app?action=board`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  }).then((r) => r.json()).catch(() => ({ market: null }));
  const pool = quoteGate?.market?.stocks?.length ?? 0;
  if (pool < 20) {
    console.log(`FAIL 行情源不可用 — 个股池只有 ${pool} 条${quoteGate?.market?.status?.note ? ` · ${quoteGate.market.status.note}` : ''}`);
    console.log('探针未运行：以下断言全部依赖真实行情列表。稍后重试，或用后台「行情源」页逐项探测定位。');
    child.kill();
    process.exit(2);
  }

  browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--mute-audio'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error.message).slice(0, 120)));
  await page.goto(base, { waitUntil: 'domcontentloaded' });

  const auth = await page.evaluate(async () => {
    const response = await fetch('/functions/v1/app?action=register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ username: `pg_${Date.now().toString(36)}`, password: 'probe12345', display: 'pg' }),
    });
    const data = await response.json();
    if (data?.ok) localStorage.setItem('mirror.desk.token', data.token);
    return Boolean(data?.ok);
  });
  ok('register-throwaway-user', auth === true);
  await page.reload({ waitUntil: 'domcontentloaded' });

  await page.waitForFunction(() => document.querySelectorAll('.dense-row:not([aria-hidden])').length > 0, null, { timeout: 25_000 });

  const snap = () => page.evaluate(() => {
    const panel = document.querySelector('[aria-label="行情分类"]').closest('.panel');
    const body = panel.querySelector('footer').previousElementSibling;
    const rows = [...body.querySelectorAll('.dense-row:not([aria-hidden])')];
    const boxes = [...body.querySelectorAll('.dense-row')];
    const foot = panel.querySelector('footer');
    const h = (el) => Math.round(el.getBoundingClientRect().height);
    return {
      rows: rows.length,
      boxes: boxes.length,
      first: rows[0]?.textContent?.slice(0, 6) ?? '',
      panelH: h(panel),
      panelW: Math.round(panel.getBoundingClientRect().width),
      bodyH: h(body),
      kids: [...panel.children].map(h).join(','),
      rowH: rows.length ? h(rows[0]) : 0,
      listScroll: body.scrollHeight - body.clientHeight,
      uniform: (() => {
        const list = [...body.querySelectorAll('.dense-row')].map(h);
        return list.every((value) => Math.abs(value - list[0]) <= 1) ? list[0] : -1;
      })(),
      clipped: [...body.querySelectorAll('.dense-row')].filter((el) => el.scrollHeight > el.clientHeight + 1).length,
      pager: foot.textContent.replace(/\s+/g, ' ').trim(),
      footBottom: Math.round(foot.getBoundingClientRect().bottom),
      overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });

  // 1) desktop, a tab with more than one page
  await page.getByRole('tab', { name: '个股' }).click();
  await page.waitForFunction(() => document.querySelectorAll('.dense-row:not([aria-hidden])').length === 10, null, { timeout: 8_000 });
  const p1 = await snap();
  const pageOne = at(p1.pager);
  ok('rows-equal-10', p1.rows === 10 && p1.boxes === 10, `rows=${p1.rows} boxes=${p1.boxes}`);
  ok('pager-shows-page-1', Boolean(pageOne) && pageOne[0] === 1 && pageOne[1] >= 2, p1.pager);
  ok('row-height-uniform', p1.uniform > 0, `row=${p1.rowH} uniform=${p1.uniform} kids=${p1.kids} panelW=${p1.panelW}`);
  ok('no-row-clipping', p1.clipped === 0, `clipped=${p1.clipped} row=${p1.rowH} kids=${p1.kids}`);
  ok('chrome-single-line', p1.kids.split(',').map(Number)[0] <= 46, `header=${p1.kids}`);
  ok('page-count-matches-height', p1.boxes === Math.max(1, Math.min(10, Math.floor(p1.bodyH / p1.rowH))), `boxes=${p1.boxes} body=${p1.bodyH} row=${p1.rowH}`);
  ok('list-not-scrollable', p1.listScroll <= 1, `scroll=${p1.listScroll}`);

  // 2) next page: content changes, geometry does not
  await page.getByRole('button', { name: '下一页' }).click();
  await page.waitForTimeout(150);
  const p2 = await snap();
  const pageTwo = at(p2.pager);
  ok('next-page-advances', Boolean(pageTwo) && pageTwo[0] === 2, p2.pager);
  ok('next-page-new-content', p2.first !== p1.first, `${p1.first} -> ${p2.first}`);
  ok('next-page-height-stable', p2.panelH === p1.panelH && p2.bodyH === p1.bodyH, `panel ${p1.panelH}/${p2.panelH} body ${p1.bodyH}/${p2.bodyH}`);

  // 3) a short (empty) list must not shrink the window
  await page.getByRole('tab', { name: '自选' }).click();
  await page.waitForTimeout(250);
  const p3 = await snap();
  ok('empty-list-still-10-boxes', p3.boxes === 10 && p3.rows === 0, `boxes=${p3.boxes} rows=${p3.rows}`);
  ok('empty-list-height-stable', p3.panelH === p1.panelH, `${p1.panelH} vs ${p3.panelH}`);
  ok('empty-list-pager-blank', p3.pager.includes('—') && !at(p3.pager), p3.pager);

  // 4) keyboard selection past the page edge flips the page automatically
  await page.getByRole('tab', { name: '个股' }).click();
  await page.waitForTimeout(250);
  for (let i = 0; i < 11; i++) await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(250);
  const p4 = await snap();
  const marked = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.dense-row:not([aria-hidden])')];
    const hit = rows.find((el) => getComputedStyle(el).boxShadow.includes('inset'));
    return hit ? hit.textContent.slice(0, 6) : null;
  });
  const pageFour = at(p4.pager);
  ok('keyboard-flips-page', Boolean(pageFour) && pageFour[0] === 2, p4.pager);
  ok('keyboard-selection-visible', Boolean(marked), String(marked));

  // 5) search results use the same window
  const box = page.locator('input[aria-label^="搜索标的"]');
  await box.fill('600');
  await page.waitForTimeout(1_800);
  const p5 = await snap();
  ok('search-rows-max-10', p5.rows > 0 && p5.rows <= 10 && p5.boxes === 10, `rows=${p5.rows} boxes=${p5.boxes}`);
  ok('search-height-stable', p5.panelH === p1.panelH, `${p1.panelH} vs ${p5.panelH}`);
  await box.fill('');
  await page.waitForTimeout(300);

  // 5b) 手感：光标、整行热区、按下即选中、悬停预热、滚轮与翻页键、星标乐观更新
  await page.getByRole('tab', { name: '个股' }).click();
  await page.waitForTimeout(400);

  const cursor = await page.evaluate(() => {
    const row = document.querySelector('.dense-row:not([aria-hidden])');
    return { row: getComputedStyle(row).cursor, star: getComputedStyle(row.querySelector('button[aria-label*="自选"]')).cursor };
  });
  ok('cursor-says-clickable', cursor.row === 'pointer' && cursor.star === 'pointer', JSON.stringify(cursor));

  const press = await page.evaluate(async () => {
    const target = document.querySelectorAll('.dense-row:not([aria-hidden])')[4];
    const t0 = performance.now();
    target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' }));
    await new Promise((r) => requestAnimationFrame(r));
    return { ms: Math.round(performance.now() - t0), hit: target.getAttribute('aria-pressed') === 'true' };
  });
  ok('pointerdown-selects-in-one-frame', press.hit && press.ms < 60, `hit=${press.hit} ms=${press.ms}`);

  const rowBox = await page.locator('.dense-row:not([aria-hidden])').nth(7).boundingBox();
  await page.mouse.move(rowBox.x + rowBox.width - 42, rowBox.y + rowBox.height / 2);
  await page.mouse.down();
  await page.mouse.up();
  await page.waitForTimeout(150);
  const pressed = await page.evaluate(() => document.querySelectorAll('.dense-row[aria-pressed="true"]').length);
  ok('whole-row-is-hit-area', pressed === 1, `selected=${pressed}`);

  await page.waitForTimeout(900);
  const chartState = await page.evaluate(() => ({
    loading: /图表加载中/.test(document.body.innerText),
    named: Boolean(document.querySelector('h2')?.textContent),
  }));
  ok('hover-prefetch-kills-chart-wait', !chartState.loading && chartState.named, JSON.stringify(chartState));

  const chartLatency = await page.evaluate(async () => {
    const call = async (secid) => {
      const t0 = performance.now();
      const response = await fetch('/functions/v1/app?action=chart', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ secid, kind: 'trends' }),
      });
      await response.json();
      return Math.round(performance.now() - t0);
    };
    const cold = await call('1.601318');
    const warm = await call('1.601318');
    const again = await call('1.601318');
    return { cold, warm, again };
  });
  ok('server-chart-cache', chartLatency.warm < chartLatency.cold, JSON.stringify(chartLatency));

  // 5c) 周 K 与 MACD：三档切换、副图真画出来了、周线确实是另一份数据
  const chartSvg = page.locator('svg[role="img"][aria-label*="K 线"]');
  const toggles = await page.evaluate(() => [...document.querySelectorAll('header button[aria-pressed]')].map((b) => b.textContent.trim()));
  ok('chart-has-day-and-week-toggles', ['分时', '日 K', '周 K'].every((label) => toggles.includes(label)), JSON.stringify(toggles));

  const bottomDays = () => page.evaluate(() => {
    const svg = [...document.querySelectorAll('svg[role="img"]')].find((el) => /K 线/.test(el.getAttribute('aria-label') ?? ''));
    if (!svg) return null;
    const h = Number(svg.getAttribute('height'));
    return {
      label: svg.getAttribute('aria-label'),
      days: [...svg.querySelectorAll('text')].filter((t) => Number(t.getAttribute('y')) === h - 3).map((t) => t.textContent),
      macdText: [...svg.querySelectorAll('text')].some((t) => (t.textContent ?? '').includes('MACD 12/26/9')),
      dif: svg.querySelectorAll('path[stroke="var(--info)"]').length,
      dea: svg.querySelectorAll('path[stroke="var(--primary)"]').length,
      candles: svg.querySelectorAll('g[opacity]').length,
    };
  });

  await page.getByRole('button', { name: '日 K', exact: true }).click();
  await page.waitForFunction(() => /日 K 线/.test([...document.querySelectorAll('svg[role="img"]')]
    .map((el) => el.getAttribute('aria-label') ?? '').join('|')), null, { timeout: 20_000 }).catch(() => {});
  await page.waitForTimeout(300);
  const daily = await bottomDays();
  ok('daily-kline-draws-macd-subplot',
    Boolean(daily?.macdText) && daily.dif >= 1 && daily.dea >= 1 && /MACD DIF /.test(daily.label ?? ''),
    JSON.stringify(daily));

  const chartBox = await chartSvg.boundingBox();
  await page.mouse.move(chartBox.x + chartBox.width * 0.5, chartBox.y + chartBox.height * 0.25);
  await page.waitForTimeout(250);
  const hoverMacd = await page.evaluate(() => [...document.querySelectorAll('svg[role="img"] text')]
    .map((t) => t.textContent ?? '').filter((t) => t.includes('DIF') && t.includes('DEA') && t.includes('柱')));
  ok('crosshair-readout-carries-macd', hoverMacd.length >= 1, JSON.stringify(hoverMacd).slice(0, 140));

  await page.getByRole('button', { name: '周 K', exact: true }).click();
  await page.waitForFunction(() => /周 K 线/.test([...document.querySelectorAll('svg[role="img"]')]
    .map((el) => el.getAttribute('aria-label') ?? '').join('|')), null, { timeout: 25_000 }).catch(() => {});
  await page.waitForTimeout(300);
  const weekly = await bottomDays();
  // 周线同样画满一屏，起点必须比日线更早（否则就是拿了日线冒充周线）
  ok('weekly-kline-is-a-longer-span',
    Boolean(weekly?.macdText) && /^周 K 线/.test(weekly.label ?? '') && weekly.candles >= 20
    && (weekly.days[0] ?? '9999') < (daily.days[0] ?? '0000') && (weekly.days.at(-1) ?? '') >= (daily.days.at(-1) ?? ''),
    `周 ${weekly?.days?.[0]}→${weekly?.days?.at(-1)}（${weekly?.candles} 根）· 日 ${daily?.days?.[0]}→${daily?.days?.at(-1)}（${daily?.candles} 根）`);
  await page.mouse.move(chartBox.x + 4, chartBox.y + 4);

  await page.mouse.move(rowBox.x + 60, rowBox.y + 6);
  const beforeWheel = at((await snap()).pager);
  await page.mouse.wheel(0, 140);
  await page.waitForTimeout(350);
  const afterWheel = at((await snap()).pager);
  ok('wheel-turns-page', Boolean(beforeWheel && afterWheel) && afterWheel[0] === beforeWheel[0] + 1, `${beforeWheel} -> ${afterWheel}`);

  await page.mouse.click(700, 300);
  const beforeKey = at((await snap()).pager);
  await page.keyboard.press('PageDown');
  await page.waitForTimeout(300);
  const afterKey = at((await snap()).pager);
  ok('pagedown-turns-page', Boolean(beforeKey && afterKey) && afterKey[0] === beforeKey[0] + 1, `${beforeKey} -> ${afterKey}`);

  let syncs = 0;
  page.on('request', (req) => { if (req.url().includes('action=sync')) syncs += 1; });
  // 先对齐 3 秒轮询的相位，再判定「点星标不该额外触发全量同步」
  await page.waitForRequest((req) => req.url().includes('action=sync'), { timeout: 6_000 }).catch(() => {});
  syncs = 0;
  await page.route('**/action=watch_add', async (route) => {
    await new Promise((r) => setTimeout(r, 400));
    await route.continue();
  });
  const star = page.locator('.dense-row:not([aria-hidden])').nth(1).locator('button[aria-label*="自选"]');
  const starLabel = await star.getAttribute('aria-label');
  await star.click();
  const flipped = await page.evaluate((label) => document.querySelector(`button[aria-label="${label}"]`) === null, starLabel);
  await page.waitForTimeout(250);
  ok('star-flips-before-server', flipped, `label=${starLabel}`);
  ok('watch-toggle-skips-full-sync', syncs === 0, `syncs=${syncs}`);
  await page.unroute('**/action=watch_add');

  // 5c) 搜索：回车直接选第一条，✕ 清空
  await box.fill('600519');
  await page.waitForTimeout(900);
  await box.press('Enter');
  // 上游被拒时检索要一两秒才回来，等固定时长会把「慢」误判成「选错标的」
  await page.waitForFunction(() => (document.querySelector('h2')?.textContent ?? '').includes('贵州茅台'), null, { timeout: 15_000 }).catch(() => {});
  const picked = await page.evaluate(() => document.querySelector('h2')?.textContent ?? '');
  ok('enter-picks-first-result', picked.includes('贵州茅台'), `head=${picked}`);
  const clear = page.getByRole('button', { name: '清空搜索' });
  ok('clear-button-present', await clear.count() === 1);
  await clear.click();
  await page.waitForTimeout(300);
  ok('clear-button-empties-input', (await box.inputValue()) === '');

  // 6) layout hygiene
  const p6 = await snap();
  ok('no-horizontal-overflow', p6.overflowX <= 0, `overflowX=${p6.overflowX}`);
  ok('pager-inside-viewport', p6.footBottom <= 900, `footBottom=${p6.footBottom}`);

  // 7) 市场开关：切到美股后，列表、现金池、下单口径要整体跟着换，且不能把版面撑坏
  const marketGroup = page.getByRole('group', { name: '交易市场与开市状态' });
  await marketGroup.getByRole('button', { name: /美股/ }).click();
  await page.waitForFunction(() => localStorage.getItem('mirror.desk.market') === 'us', null, { timeout: 8_000 });
  await page.waitForTimeout(1_600);
  const usDesk = await page.evaluate(() => {
    const chips = [...document.querySelectorAll('[role="group"][aria-label^="交易市场"] button')]
      .map((button) => `${button.innerText.trim().split('\n')[0]}=${button.getAttribute('aria-pressed')}`);
    return {
      chips,
      header: (document.querySelector('header')?.innerText ?? '').replace(/\n/g, ' | '),
      rows: document.querySelectorAll('.dense-row:not([aria-hidden])').length,
      overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });
  ok('switch-marks-only-active-market', usDesk.chips.some((chip) => chip.startsWith('美股') && chip.endsWith('true'))
    && usDesk.chips.some((chip) => chip.startsWith('沪深') && chip.endsWith('false')), usDesk.chips.join(' / '));
  ok('switch-swaps-cash-pools', usDesk.header.includes('美股可用')
    && /\$\s?[\d,]+\.\d\d/.test(usDesk.header) && usDesk.header.includes('折合人民币净资产')
    && usDesk.header.includes('沪深净资产'), usDesk.header.slice(0, 240));
  await page.getByRole('tab', { name: '指数' }).click();
  await page.waitForFunction(() => /道琼斯|标普|纳斯达克/.test(document.body.innerText), null, { timeout: 10_000 });
  const usList = await snap();
  const usPanelText = await page.evaluate(() => {
    const panel = document.querySelector('[aria-label="行情分类"]')?.closest('.panel');
    return (panel?.innerText ?? '').replace(/\n/g, ' ');
  });
  ok('switch-follows-through-the-list', /道琼斯|标普/.test(usPanelText) && !usPanelText.includes('上证指数'),
    usPanelText.slice(0, 90));
  ok('switch-keeps-pagination-and-width', usList.rows >= 1 && usList.rows <= 10 && usList.overflowX <= 0,
    `rows=${usList.rows} boxes=${usList.boxes} overflowX=${usList.overflowX}`);
  await page.getByRole('tab', { name: '个股' }).click();
  await page.waitForFunction(() => document.querySelectorAll('.dense-row:not([aria-hidden])').length > 0, null, { timeout: 10_000 });
  await page.locator('.dense-row:not([aria-hidden])').first().click();
  await page.waitForTimeout(900);
  const usTicket = await page.evaluate(() => {
    const panel = [...document.querySelectorAll('.panel')].find((el) => el.innerText.includes('下单'));
    return (panel?.innerText ?? '').replace(/\n/g, ' | ');
  });
  ok('us-ticket-uses-lot-and-fee-wording', usTicket.includes('1 股起') && !usTicket.includes('100 整数倍')
    && usTicket.includes('无每日涨跌停') && usTicket.includes('T+0'), usTicket.slice(0, 160));
  const usQtyDefault = await page.locator('#order-qty').inputValue();
  ok('us-qty-default-shrinks-to-one-lot', Number(usQtyDefault) > 0 && Number(usQtyDefault) <= 100, `qty=${usQtyDefault}`);

  // 规则说明跟着市场走：美股那一页要讲 T+0、无涨跌停与两个现金池
  await page.getByRole('button', { name: '规则' }).click();
  await page.waitForFunction(() => document.body.innerText.includes('交易规则与结算口径'), null, { timeout: 5_000 });
  const rulesText = await page.evaluate(() => document.body.innerText);
  ok('rules-panel-covers-both-markets', rulesText.includes('两个现金池') && rulesText.includes('常规时段')
    && rulesText.includes('T+0') && rulesText.includes('无每日涨跌停'),
    `命中 ${[rulesText.includes('两个现金池'), rulesText.includes('常规时段'), rulesText.includes('T+0')].filter(Boolean).length}/3`);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);

  await page.keyboard.press('m');
  await page.waitForFunction(() => localStorage.getItem('mirror.desk.market') === 'cn', null, { timeout: 8_000 });
  await page.waitForTimeout(1_400);
  const backToCn = await page.evaluate(() => {
    const panel = [...document.querySelectorAll('.panel')].find((el) => el.innerText.includes('下单'));
    return {
      ticket: (panel?.innerText ?? '').replace(/\n/g, ' | '),
      header: (document.querySelector('header')?.innerText ?? '').replace(/\n/g, ' | '),
      overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });
  ok('m-key-toggles-back-to-cn', backToCn.ticket.includes('100 整数倍') && backToCn.header.includes('沪深可用')
    && backToCn.header.includes('美股净资产') && backToCn.overflowX <= 0, backToCn.header.slice(0, 180));

  // 8) API 面板：快捷键打开、生成密钥、示例带上真实密钥与域名
  const headerBox = await page.evaluate(() => {
    const head = document.querySelector('header');
    const row = head.children[0];
    const tops = [...row.children].map((el) => Math.round(el.getBoundingClientRect().top));
    return {
      height: Math.round(head.getBoundingClientRect().height),
      rows: new Set(tops.map((top) => (top < 30 ? 0 : 1))).size,
      spread: Math.max(...tops) - Math.min(...tops),
    };
  });
  // 头部金额列本来就是「标签在上、数字在下」两行文字，所以判「有没有换行」看子项顶端是否齐平
  ok('header-still-single-row-with-api', headerBox.rows === 1 && headerBox.spread <= 8 && headerBox.height <= 92,
    `height=${headerBox.height} 行=${headerBox.rows} 顶端差=${headerBox.spread}`);
  await page.keyboard.press('a');
  await page.waitForFunction(() => document.body.innerText.includes('API 接口与密钥'), null, { timeout: 6_000 });
  const drawer = page.locator('[role="dialog"][aria-label="API 与密钥"]');
  ok('api-drawer-opens-on-a-key', (await drawer.count()) === 1
    && (await page.getByRole('tab', { name: '我的密钥' }).count()) === 1
    && (await page.getByRole('button', { name: '生成密钥' }).count()) === 1);
  await page.locator('input[aria-label="密钥备注名"]').fill('探针脚本');
  await page.getByRole('button', { name: '生成密钥' }).click();
  await page.waitForFunction(() => /mk_live_[0-9a-f]{32}/.test(document.body.innerText), null, { timeout: 8_000 });
  const keyPanel = await page.evaluate(() => {
    const dialog = document.querySelector('[role="dialog"][aria-label="API 与密钥"]');
    const text = dialog?.innerText ?? '';
    return {
      plain: (text.match(/mk_live_[0-9a-f]{32}/) ?? [''])[0],
      once: text.includes('只显示这一次'),
      rows: dialog ? dialog.querySelectorAll('tbody tr').length : 0,
      copy: text.includes('复制'),
      revoke: text.includes('撤销'),
      limit: text.includes('最多 10 把'),
    };
  });
  ok('api-key-generated-and-listed', /^mk_live_[0-9a-f]{32}$/.test(keyPanel.plain) && keyPanel.once
    && keyPanel.rows === 1 && keyPanel.copy && keyPanel.revoke && keyPanel.limit,
    `rows=${keyPanel.rows} · 明文 ${keyPanel.plain.slice(0, 12)}…`);
  await page.getByRole('tab', { name: '接口与示例' }).click();
  await page.waitForTimeout(500);
  const docs = await page.evaluate(() => {
    const text = document.querySelector('[role="dialog"][aria-label="API 与密钥"]')?.innerText ?? '';
    const key = (text.match(/mk_live_[0-9a-f]{32}/) ?? [''])[0];
    return {
      endpoints: ['/api/v1/markets', '/api/v1/account', '/api/v1/order', '/api/v1/positions', '/api/v1/cancel', '/api/v1/sync']
        .filter((path) => text.includes(path)).length,
      fields: text.includes('immediate') && text.includes('leverage') && text.includes('symbol'),
      curlWithKey: text.includes('x-api-key: mk_live_') && key.length === 40,
      origin: text.includes(location.origin),
      preCount: document.querySelectorAll('[role="dialog"] pre').length,
    };
  });
  ok('api-docs-list-endpoints-with-real-key', docs.endpoints >= 6 && docs.fields && docs.curlWithKey
    && docs.origin && docs.preCount >= 4, `端点 ${docs.endpoints} 条 · pre ${docs.preCount} 段 · 带密钥 ${docs.curlWithKey}`);
  await page.getByRole('tab', { name: '错误码' }).click();
  await page.waitForTimeout(400);
  const errText = await page.evaluate(() => document.querySelector('[role="dialog"][aria-label="API 与密钥"]')?.innerText ?? '');
  ok('api-error-table-covers-key-cases', errText.includes('key_invalid') && errText.includes('insufficient_cash')
    && errText.includes('match_paused') && errText.includes('too_many_requests'),
    `命中 ${[errText.includes('key_invalid'), errText.includes('insufficient_cash'), errText.includes('match_paused')].filter(Boolean).length}/3`);
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.body.innerText.includes('API 接口与密钥'), null, { timeout: 5_000 });
  ok('api-drawer-closes-on-escape', true);

  // 8b) 面板显隐：F 专注、[ ] \ 单独收放、边缘把手一键召回、状态写进 localStorage
  // 切回沪深时 switchMarket 会清掉选中项，没有图表就量不出「收起侧栏后图变大了多少」
  await page.locator('.dense-row:not([aria-hidden])').first().click();
  await page.waitForFunction(() => [...document.querySelectorAll('svg[role="img"]')]
    .some((s) => /分时|K 线/.test(s.getAttribute('aria-label') ?? '')), null, { timeout: 10_000 });
  const layout = () => page.evaluate(() => {
    const main = document.querySelector('main');
    const svg = [...document.querySelectorAll('svg[role="img"]')]
      .find((item) => /分时|K 线/.test(item.getAttribute('aria-label') ?? ''));
    const box = svg?.getBoundingClientRect();
    const toggles = [...document.querySelectorAll('[aria-label="面板显隐"] button')]
      .map((b) => `${b.textContent.trim()}=${b.getAttribute('aria-pressed')}`);
    return {
      cols: getComputedStyle(main).gridTemplateColumns.split(' ').filter(Boolean).length,
      list: document.querySelectorAll('main input[aria-label^="搜索标的"]').length,
      ticket: document.querySelectorAll('#order-qty').length,
      // 行情分类里也有一个「持仓」标签，但它带 role=tab；账本那一排是 aria-selected 的普通按钮
      book: [...document.querySelectorAll('button[aria-selected]:not([role="tab"])')]
        .filter((b) => b.textContent.startsWith('持仓')).length,
      chartW: Math.round(box?.width ?? 0),
      chartH: Math.round(box?.height ?? 0),
      handles: [...document.querySelectorAll('main > button[aria-label^="展开"]')].map((b) => b.getAttribute('aria-label')),
      toggles,
      scrollY: document.documentElement.scrollHeight - document.documentElement.clientHeight,
      saved: localStorage.getItem('mirror.desk.panels'),
    };
  });
  const base8 = await layout();
  // 图表尺寸由 ResizeObserver 转一圈才落地，收起面板后立刻量会读到旧值，所以按条件轮询
  const waitChart = async (predicate) => {
    for (let i = 0; i < 40; i++) {
      const size = await page.evaluate(() => {
        const svg = [...document.querySelectorAll('svg[role="img"]')]
          .find((item) => /分时|K 线/.test(item.getAttribute('aria-label') ?? ''));
        const box = svg?.getBoundingClientRect();
        return { w: Math.round(box?.width ?? 0), h: Math.round(box?.height ?? 0) };
      });
      if (predicate(size)) return size;
      await page.waitForTimeout(50);
    }
    return { w: 0, h: 0 };
  };
  ok('panel-toggles-listed-in-footer', base8.cols === 3 && base8.list === 1 && base8.ticket === 1 && base8.book === 1
    && base8.toggles.length === 4 && base8.toggles.slice(0, 3).every((t) => t.endsWith('=true')) && base8.chartW > 300,
    `cols=${base8.cols} list=${base8.list} ticket=${base8.ticket} book=${base8.book} chart=${base8.chartW}x${base8.chartH} toggles=${base8.toggles.join(' ')}`);

  await page.keyboard.press('f');
  await page.waitForFunction(() => document.querySelectorAll('#order-qty').length === 0, null, { timeout: 5_000 });
  await waitChart((size) => size.w > base8.chartW + 200 && size.h > base8.chartH + 80);
  const focused = await layout();
  ok('f-key-hides-all-three-panels', focused.cols === 1 && focused.list === 0 && focused.ticket === 0 && focused.book === 0
    && focused.toggles.some((t) => t.includes('退出专注=true')),
    `cols=${focused.cols} list=${focused.list} ticket=${focused.ticket} book=${focused.book} toggles=${focused.toggles.join(' ')}`);
  ok('focus-mode-grows-the-chart', focused.chartW > base8.chartW + 200 && focused.chartH > base8.chartH + 80,
    `${base8.chartW}x${base8.chartH} → ${focused.chartW}x${focused.chartH}`);
  ok('focus-mode-keeps-handles-and-no-page-scroll', focused.handles.length === 2 && focused.scrollY <= 0,
    `handles=${focused.handles.join('|')} scrollY=${focused.scrollY}`);

  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.querySelectorAll('#order-qty').length === 1, null, { timeout: 5_000 });
  await waitChart((size) => size.w > 0 && size.w <= base8.chartW + 40);
  const restored = await layout();
  ok('escape-exits-focus-mode', restored.cols === 3 && restored.chartW === base8.chartW && restored.book === 1,
    `cols=${restored.cols} chartW=${restored.chartW}（基准 ${base8.chartW}） book=${restored.book}`);

  await page.keyboard.press('[');
  await page.waitForFunction(() => document.querySelectorAll('main input[aria-label^="搜索标的"]').length === 0, null, { timeout: 5_000 });
  const noList = await layout();
  ok('bracket-key-hides-only-the-list', noList.cols === 2 && noList.list === 0 && noList.ticket === 1 && noList.book === 1
    && noList.chartW > base8.chartW && noList.handles.join() === '展开行情列表',
    `cols=${noList.cols} list=${noList.list} ticket=${noList.ticket} book=${noList.book} chartW=${base8.chartW}→${noList.chartW} handles=${noList.handles.join('|')}`);
  await page.locator('main > button[aria-label="展开行情列表"]').click();
  await page.waitForFunction(() => document.querySelectorAll('main input[aria-label^="搜索标的"]').length === 1, null, { timeout: 5_000 });
  ok('edge-handle-brings-the-list-back', (await layout()).cols === 3);

  await page.keyboard.press('\\');
  await page.waitForFunction(() => [...document.querySelectorAll('button[aria-selected]:not([role="tab"])')]
    .filter((b) => b.textContent.startsWith('持仓')).length === 0, null, { timeout: 5_000 });
  await waitChart((size) => size.h > base8.chartH + 80);
  const noBook = await layout();
  ok('backslash-key-hides-only-the-book', noBook.book === 0 && noBook.list === 1 && noBook.ticket === 1
    && noBook.chartH > base8.chartH + 80, `book=${noBook.book} list=${noBook.list} ticket=${noBook.ticket} chartH=${base8.chartH}→${noBook.chartH}`);
  ok('panel-state-persists-to-localstorage', JSON.parse(noBook.saved ?? '{}').book === false
    && JSON.parse(noBook.saved ?? '{}').list === true, noBook.saved ?? 'null');
  await page.keyboard.press('\\');
  await page.waitForFunction(() => [...document.querySelectorAll('button[aria-selected]:not([role="tab"])')]
    .some((b) => b.textContent.startsWith('持仓')), null, { timeout: 5_000 });
  ok('book-returns-on-second-backslash', (await layout()).book === 1);

  // 9) mobile shell: smaller page size, everything on screen
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(600);
  const m = await page.evaluate(() => {
    const panel = document.querySelector('[aria-label="行情分类"]').closest('.panel');
    const body = panel.querySelector('footer').previousElementSibling;
    const foot = panel.querySelector('footer');
    return {
      boxes: body.querySelectorAll('.dense-row').length,
      rows: body.querySelectorAll('.dense-row:not([aria-hidden])').length,
      listScroll: body.scrollHeight - body.clientHeight,
      bodyH: Math.round(body.getBoundingClientRect().height),
      rowH: Math.round((body.querySelector('.dense-row')?.getBoundingClientRect().height) ?? 0),
      overflowY: document.documentElement.scrollHeight - document.documentElement.clientHeight,
      overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      footBottom: Math.round(foot.getBoundingClientRect().bottom),
      pager: foot.textContent.replace(/\s+/g, ' ').trim(),
    };
  });
  ok('mobile-page-fits', m.boxes >= 3 && m.boxes <= 10 && m.rows > 0, `boxes=${m.boxes} rows=${m.rows} body=${m.bodyH} row=${m.rowH}`);
  ok('mobile-list-not-scrollable', m.listScroll <= 1, `scroll=${m.listScroll} boxes=${m.boxes} body=${m.bodyH}`);
  ok('mobile-no-document-scroll', m.overflowY <= 0 && m.overflowX <= 0, `y=${m.overflowY} x=${m.overflowX}`);
  ok('mobile-pager-visible', m.footBottom <= 844, `footBottom=${m.footBottom} ${m.pager}`);

  ok('no-page-errors', errors.length === 0, errors.join(' | '));
} catch (error) {
  ok('probe-completed', false, String(error.message).slice(0, 220));
} finally {
  await browser?.close().catch(() => {});
  child.kill();
  console.log(results.join('\n'));
  console.log(`SUMMARY pass=${results.filter((line) => line.startsWith('PASS')).length} fail=${results.filter((line) => line.startsWith('FAIL')).length}`);
}
