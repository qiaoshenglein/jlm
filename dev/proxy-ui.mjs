// 后台「代理出口」这块的界面回归 + 出图：node dev/proxy-ui.mjs
// 全程本地 mock（假代理 / 假行情源 / 假列表 API），不打任何第三方域名。
// 用自己的临时库与快照目录，绝不碰 data/mirror.db；端口自动取空闲口，不碰 8787。
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { connect } from 'node:net';
import { createServer as httpServer } from 'node:http';
import { createServer as httpsServer } from 'node:https';
import { createServer as tlsServer } from 'node:tls';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require('D:/game/cf-transport-ship/node_modules/playwright-core');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const ROOT = resolve(import.meta.dirname, '..');
const SHOTS = join(ROOT, 'dev', '.shots');

process.env.PROXY_ALLOW_PRIVATE = '1';
// 假源与假列表 API 都是自签证书：只在这个测试子进程里不校验（生产路径不受影响）
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const results = [];
const ok = (name, pass, detail = '') => {
  results.push({ name, pass: Boolean(pass), detail });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ` :: ${String(detail).slice(0, 150)}` : ''}`);
};
const listenOn = (server) => new Promise((done) => server.listen(0, '127.0.0.1', () => done(server.address().port)));
const wait = (ms) => new Promise((done) => setTimeout(done, ms));
const QUOTE = JSON.stringify({ data: { total: 2, diff: [{ f2: 12.3, f12: '600000', f13: 1, f14: 'A' }, { f2: 8.1, f12: '000001', f13: 0, f14: 'B' }] } });

const home = mkdtempSync(join(tmpdir(), 'pxui-'));
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-keyout', join(home, 'k.pem'), '-out', join(home, 'c.pem'),
  '-days', '2', '-nodes', '-subj', '/CN=push2.eastmoney.com', '-addext', 'subjectAltName=DNS:push2.eastmoney.com,IP:127.0.0.1'], { stdio: 'ignore' });
const key = readFileSync(join(home, 'k.pem'), 'utf8').replace(/\r\n/g, '\n');
const cert = readFileSync(join(home, 'c.pem'), 'utf8').replace(/\r\n/g, '\n');

// 假行情源：https，任何请求都回一段能用的行情
const origin = tlsServer({ key, cert }, (socket) => {
  let buf = '';
  socket.on('data', (chunk) => {
    buf += chunk.toString('latin1');
    if (buf.indexOf('\r\n\r\n') < 0) return;
    socket.end(`HTTP/1.1 200 OK\r\ncontent-type: application/json\r\nconnection: close\r\n\r\n${QUOTE}`);
  });
  socket.on('error', () => {});
});
const originPort = await listenOn(origin);

// 假代理：ok 给数据，deny 回 403，throttle 回 429
function mockProxy(kind) {
  const server = createServer((socket) => {
    socket.on('error', () => {});
    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const at = buffer.indexOf('\r\n\r\n');
      if (at < 0) return;
      const head = buffer.subarray(0, at).toString('latin1');
      socket.removeAllListeners('data');
      if (kind === 'deny') { socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
      if (head.startsWith('CONNECT')) {
        socket.write('HTTP/1.1 200 Connection established\r\n\r\n');
        const raw = connect(originPort, '127.0.0.1');
        raw.on('error', () => socket.destroy());
        const rest = buffer.subarray(at + 4);
        if (rest.length) socket.unshift(rest);
        socket.pipe(raw).pipe(socket);
        return;
      }
      if (kind === 'throttle') { socket.end('HTTP/1.1 429 Too Many Requests\r\nconnection: close\r\n\r\n'); return; }
      socket.end(`HTTP/1.1 200 OK\r\ncontent-type: application/json\r\nconnection: close\r\n\r\n${QUOTE}`);
    });
  });
  return server;
}
const goodPort = await listenOn(mockProxy('ok'));
const denyPort = await listenOn(mockProxy('deny'));

let listPayload = JSON.stringify({ code: 200, data: { proxies: [ `127.0.0.1:${goodPort}` ], count: 1 } });
const listApi = httpsServer({ key, cert }, (req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(listPayload);
});
const listPort = await listenOn(listApi);
const listUrl = `https://127.0.0.1:${listPort}/get_proxy.php`;

const port = await new Promise((done) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => done(p)); }); });
const base = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, ['server/index.mjs'], {
  cwd: ROOT,
  env: {
    ...process.env, PORT: String(port), HOST: '127.0.0.1',
    DB_DRIVER: 'sqlite', DB_PATH: join(home, 'ui.db'), BACKUP_DIR: join(home, 'bk'),
    ADMIN_USERNAMES: 'pxui_admin', PROXY_ALLOW_PRIVATE: '1',
  },
  stdio: ['ignore', 'ignore', 'pipe'],
});
child.stderr.on('data', (chunk) => process.stderr.write(chunk));

let browser = null;
try {
  for (let i = 0; i < 60; i += 1) {
    try { const ping = await fetch(`${base}/healthz`); if (ping.ok) break; } catch { /* 等启动 */ }
    await wait(150);
  }
  const account = await fetch(`${base}/functions/v1/app?action=register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'pxui_admin', password: 'pxui12345678', display: '代理运维' }),
  }).then((response) => response.json());
  ok('后台账户就绪', Boolean(account.token), JSON.stringify(account).slice(0, 60));

  browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1280 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error.message).slice(0, 120)));
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.evaluate((value) => localStorage.setItem('mirror.desk.token', value), account.token);
  await page.goto(`${base}/#/admin`, { waitUntil: 'domcontentloaded' });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.body.innerText.includes('后台'), null, { timeout: 30_000 });
  await page.getByRole('tab', { name: '行情源' }).click();
  await page.waitForFunction(() => document.body.innerText.includes('代理出口'), null, { timeout: 30_000 });
  ok('代理区块渲染出来了', true);

  const text = () => page.evaluate(() => {
    const box = [...document.querySelectorAll('section')].find((el) => el.innerText.includes('代理出口'));
    return (box?.innerText ?? '').replace(/\n+/g, ' ');
  });
  ok('默认是关着的', /未启用/.test(await text()), (await text()).slice(0, 70));

  const bootUrl = await page.getByLabel('代理列表 API').inputValue();
  ok('API 地址出厂就填好内置接口', bootUrl === 'https://proxy.scdn.io/api/get_proxy.php', bootUrl);
  await page.getByLabel('启用代理').check();
  await page.getByLabel('代理列表 API').fill(listUrl);
  await page.getByLabel('手动代理').fill(`127.0.0.1:${goodPort}, 127.0.0.1:${denyPort}`);
  await page.getByRole('button', { name: '保存代理配置' }).click();
  await page.getByRole('button', { name: '确认保存' }).click();
  await page.waitForFunction(() => document.body.innerText.includes('代理配置已保存'), null, { timeout: 25_000 });
  await wait(600);
  ok('保存后开关翻成已启用', /已启用/.test(await text()), (await text()).slice(0, 90));

  const block = page.locator('section', { hasText: '代理出口' }).first();
  await block.scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(SHOTS, 'admin-proxy.png') });

  await page.getByRole('button', { name: '立即获取新代理' }).click();
  await page.waitForFunction(() => /已取回|没取到|获取代理失败/.test(document.body.innerText), null, { timeout: 40_000 });
  const pull = await page.evaluate(() => document.body.innerText.match(/已取回 \d+ 个代理[^\n]*|没取到新代理[^\n]*|获取代理失败/)?.[0] ?? '');
  ok('取列表回了真实条数', /已取回 1 个/.test(pull), pull);

  listPayload = JSON.stringify({ code: 200, data: { proxies: [`127.0.0.1:${goodPort}`, `127.0.0.1:${denyPort}`], count: 2 } });
  await page.getByRole('button', { name: '逐代理活性检测' }).click();
  await page.waitForFunction(() => /代理检测完成|代理检测失败/.test(document.body.innerText), null, { timeout: 60_000 });
  const rows = await page.evaluate(() => {
    const box = [...document.querySelectorAll('section')].find((el) => el.innerText.includes('代理出口'));
    return [...(box?.querySelectorAll('table tbody tr') ?? [])].map((tr) => tr.innerText.replace(/\s+/g, ' '));
  });
  ok('检测表逐条给结果', rows.length >= 2, `${rows.length} 行`);
  ok('可用的那条标出来了', rows.some((line) => /可用/.test(line) && !/不可用/.test(line)), rows.join(' | ').slice(0, 150));
  ok('不通的那条说清原因', rows.some((line) => /已被封|不可用/.test(line)), rows.join(' | ').slice(0, 150));
  await block.scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(SHOTS, 'admin-proxy-check.png') });

  const masked = await page.evaluate(() => document.body.innerText.includes('SECRET') === false);
  ok('界面上不出现密钥字样', masked);
  ok('页面没有报错', errors.length === 0, errors.join(' | '));
} catch (error) {
  ok('探针跑通', false, String(error?.message ?? error));
} finally {
  await browser?.close().catch(() => {});
  child.kill();
  for (const server of [origin, listApi]) server.close();
  // 临时目录可能还被刚终止的服务进程占着，清不掉就交给系统回收，不影响结论
  try { rmSync(home, { recursive: true, force: true }); } catch { /* 占位 */ }
}

const failed = results.filter((row) => !row.pass);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length ? 1 : 0);
