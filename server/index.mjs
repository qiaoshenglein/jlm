// 自建部署入口：一个进程同时提供静态前端（dist/）与同源后端接口（/functions/v1/app）。
// 默认 SQLite，零外部依赖；DB_DRIVER=postgres 时走 PostgreSQL。
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { dirname, extname, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDb } from './db.mjs';
import { handle } from '../functions/api.mjs';
import { Store } from '../functions/store.mjs';
import { adminNames, ensureAdmins } from '../functions/admin.mjs';

// 命令行参数优先于环境变量：Windows 的 cmd / PowerShell 里 `PORT=8791 node ...` 那种写法不生效。
// 同名参数取最后一个，方便 `npm run serve -- --port 8899` 覆盖脚本里的默认端口
const flag = (name) => {
  const argv = process.argv.slice(2);
  for (let i = argv.length - 1; i >= 0; i--) {
    const item = argv[i];
    if (item.startsWith(`--${name}=`)) return item.slice(item.indexOf('=') + 1);
    if (item === `--${name}`) return argv[i + 1];
  }
  return undefined;
};

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WEB_DIR = resolve(ROOT, process.env.WEB_DIR ?? 'dist');
const HOST = flag('host') ?? process.env.HOST ?? '127.0.0.1';
const PORT = Number(flag('port') ?? process.env.PORT ?? 8787);
const MAX_BODY = 16 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'content-security-policy': [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "font-src 'self' data:",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; '),
  'x-frame-options': 'DENY',
};

const db = await createDb();
let migrated = null;
if (process.env.DB_AUTO_MIGRATE !== '0') {
  migrated = await db.migrate(db.driver);
}

const log = (line) => console.log(new Date().toISOString(), line);

// 后台引导：ADMIN_USERNAMES 里已注册的账户立刻标为 admin；还没注册的，等其注册后由首次后台请求补上
const adminBoot = await ensureAdmins(new Store(db));

function send(res, status, body, headers = {}) {
  res.writeHead(status, { ...SECURITY_HEADERS, ...headers });
  res.end(body);
}

function notFound(res) {
  send(res, 404, JSON.stringify({ ok: false, code: 'not_found' }), { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) {
      const error = new Error('payload_too_large');
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function serveApi(req, res, url) {
  const started = Date.now();
  let body;
  try {
    body = req.method === 'GET' || req.method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);
  } catch (error) {
    send(res, error.status ?? 400, JSON.stringify({ ok: false, code: 'body_invalid' }),
      { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    return;
  }
  try {
    const request = new Request(new URL(req.url ?? '/', `http://${req.headers.host ?? `${HOST}:${PORT}`}`), {
      method: req.method,
      headers: new Headers(req.headers),
      body: body.length ? body : undefined,
    });
    const response = await handle({ request, supabase: db });
    const payload = Buffer.from(await response.arrayBuffer());
    const headers = { 'cache-control': 'no-store' };
    response.headers.forEach((value, key) => {
      if (['content-type', 'allow'].includes(key)) headers[key] = value;
    });
    res.writeHead(response.status, { ...SECURITY_HEADERS, ...headers });
    res.end(payload);
    log(`${req.method} ${url.pathname}${url.search} ${response.status} ${Date.now() - started}ms`);
  } catch (error) {
    send(res, 500, JSON.stringify({ ok: false, code: 'server_error' }),
      { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    log(`接口异常 ${error?.message ?? error}`);
  }
}

async function serveStatic(res, pathname) {
  const relative = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const target = resolve(WEB_DIR, normalize(relative));
  // 目录穿越防护：解析后的绝对路径必须仍在发布目录内
  if (target !== WEB_DIR && !target.startsWith(WEB_DIR + sep)) return notFound(res);
  try {
    const info = await stat(target);
    if (!info.isFile()) return notFound(res);
    const body = await readFile(target);
    const hashed = relative.startsWith('assets/');
    send(res, 200, body, {
      'content-type': MIME[extname(target)] ?? 'application/octet-stream',
      'cache-control': hashed ? 'public, max-age=31536000, immutable' : 'no-cache',
      'content-length': info.size,
    });
  } catch {
    notFound(res);
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  if (url.pathname === '/healthz') {
    return send(res, 200, JSON.stringify({ ok: true, driver: db.driver, webDir: WEB_DIR }),
      { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  }
  // /functions/v1/app 是网页端与云函数入口，/api/v1/* 是对外 REST 入口，两者共用同一个 handle()
  if (url.pathname.startsWith('/functions/') || url.pathname.startsWith('/api/')) return serveApi(req, res, url);
  if (req.method !== 'GET' && req.method !== 'HEAD') return notFound(res);
  return serveStatic(res, url.pathname);
});

server.headersTimeout = 20_000;
server.requestTimeout = 30_000;

const listenUrls = () => {
  if (HOST !== '0.0.0.0' && HOST !== '::') return [`http://${HOST}:${PORT}`];
  const lan = Object.values(networkInterfaces()).flat()
    .filter((item) => item && item.family === 'IPv4' && !item.internal)
    .map((item) => `http://${item.address}:${PORT}`);
  return [`http://127.0.0.1:${PORT}`, ...lan];
};

server.listen(PORT, HOST, async () => {
  const hasWeb = Boolean(await stat(WEB_DIR).catch(() => null));
  log(`镜盘已启动：${listenUrls().join('  ')} 数据驱动=${db.driver}${migrated ? ` 已应用 ${migrated}` : ' 跳过建表'}`);
  log(`静态目录 ${WEB_DIR}${hasWeb ? '' : ' —— 不存在，请先执行 npm run build'}`);
  log(adminBoot.configured
    ? `后台已启用：管理员 ${adminNames().join('、')}${adminBoot.justGranted.length ? `（本次新授予 ${adminBoot.justGranted.join('、')}）` : ''} · 入口 #/admin`
    : '后台未启用：设置环境变量 ADMIN_USERNAMES=你的用户名 后再启动即可开启');
});

const shutdown = (signal) => {
  log(`收到 ${signal}，正在关闭`);
  server.close(() => {
    db.close?.();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000).unref();
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
