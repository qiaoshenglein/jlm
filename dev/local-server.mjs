// 本地后端：真实行情 + 内存账本，让前端在开发机上端到端跑通。
// 用法：node dev/local-server.mjs   （默认 127.0.0.1:8000，Vite 已代理 /functions/v1/app）
import { createServer } from 'node:http';
import { handle } from '../functions/api.mjs';
import { createFixtureDb } from './fixture-db.mjs';

const db = createFixtureDb();
const supabase = { from: (name) => db.from(name) };
const port = Number(process.env.PORT ?? 8000);
const host = '127.0.0.1';

const server = createServer((req, res) => {
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', async () => {
    const url = new URL(req.url ?? '/', `http://${host}:${port}`);
    try {
      const request = new Request(url, {
        method: req.method,
        headers: new Headers(req.headers),
        body: req.method === 'GET' || req.method === 'HEAD' ? undefined : Buffer.concat(chunks),
      });
      const response = await handle({ request, supabase });
      const body = await response.text();
      res.writeHead(response.status, {
        'content-type': response.headers.get('content-type') ?? 'application/json',
        'cache-control': 'no-store',
      });
      res.end(body);
    } catch (error) {
      res.writeHead(500, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ ok: false, code: 'local_server_error' }));
      console.error('[local]', error?.stack ?? error);
    }
  });
});

server.listen(port, host, () => {
  console.log(`本地行情与撮合服务已启动： http://${host}:${port}/functions/v1/app?action=board`);
  console.log(`本地样本数据表：${JSON.stringify(db.stats())}`);
});
