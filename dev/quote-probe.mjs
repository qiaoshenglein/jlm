// 行情源后台的离线回归：把所有上游都假掉，专测配置校验、检测结论与降级标注。
// 不依赖真实行情，出口被上游拒了也能跑；用法：node dev/quote-probe.mjs（内存样本库，绝不碰 data/mirror.db）
const RealDate = Date;
const beijing = new RealDate(Date.now() + 8 * 3600_000);
const day = `${beijing.getUTCFullYear()}-${String(beijing.getUTCMonth() + 1).padStart(2, '0')}-${String(beijing.getUTCDate()).padStart(2, '0')}`;
let clock = new RealDate(`${day}T05:30:00Z`).getTime();
globalThis.Date = class extends RealDate {
  constructor(...args) { super(args.length ? args[0] : clock); }
  static now() { return clock; }
};

const { handle } = await import('../functions/api.mjs');
const quotes = await import('../functions/quotes.mjs');
const { createFixtureDb } = await import('./fixture-db.mjs');
const db = createFixtureDb({ persist: false });
const supabase = { from: (name) => db.from(name) };

// ---- 假上游 ----
const row = (market, code, name, price) => ({
  f2: price, f3: 1.5, f4: 0.1, f5: 1000, f6: 1e7, f7: 2, f8: 1.2,
  f12: code, f13: market, f14: name, f15: price * 1.05, f16: price * 0.95, f17: price * 0.99,
  f18: price * 0.98, f20: 1e10, f124: Math.floor(clock / 1000),
});
const cnStocks = (pz) => Array.from({ length: Math.min(pz, 150) }, (_, i) => row(1, `60${String(10000 + i)}`, `假A股${i}`, 10 + i / 20));
const usRows = (pz) => Array.from({ length: Math.min(pz, 200) }, (_, i) => row(i % 3 === 0 ? 106 : 105, `U${String(1000 + i)}`, `假美股${i}${i % 7 === 0 ? 'ETF' : ''}`, 50 + i));
const usIdx = [{ ...row(100, 'DJIA', '道琼斯', 52000), }, { ...row(100, 'SPX', '标普500', 7600) }, { ...row(100, 'NDX', '纳斯达克', 25000) }, { ...row(100, 'NDX100', '纳斯达克100', 28000) }];
const cnIdx = quotes.KEY_INDEXES.map(([secid, name], i) => {
  const [market, code] = secid.split('.');
  return row(Number(market), code, name, 3000 + i);
});
const one = (price, name) => ({
  f43: price, f44: price * 1.02, f45: price * 0.98, f46: price * 0.99, f47: 1000, f48: 1e6,
  f57: 'X', f58: name, f60: price * 0.98, f86: Math.floor(clock / 1000), f168: 1, f169: 0.01, f170: 1.2, f171: 0.1,
});
let failSingle = false;
let calls = [];
globalThis.fetch = async (url) => {
  const u = String(url);
  calls.push(u);
  if (u.includes('/api/qt/stock/get')) {
    if (failSingle) throw new Error('forced_socket_reset');
    const secid = new URL(u).searchParams.get('secid');
    if (secid === '133.USDCNH') return new Response(JSON.stringify({ data: one(6.67, '美元兑离岸人民币') }));
    return new Response(JSON.stringify({ data: one(4.2, '假ETF') }));
  }
  if (u.includes('/api/qt/clist/get')) {
    const fs = new URL(u).searchParams.get('fs') ?? '';
    const pz = Number(new URL(u).searchParams.get('pz') ?? 5);
    if (fs.startsWith('b:')) return new Response(JSON.stringify({ data: { diff: cnIdx } }));
    if (fs.startsWith('i:100.')) return new Response(JSON.stringify({ data: { diff: usIdx } }));
    if (fs.startsWith('i:')) {
      const secid = fs.slice(2);
      const [market, code] = secid.split('.');
      return new Response(JSON.stringify({ data: { diff: [row(Number(market), code, '假单标', 123.4)] } }));
    }
    if (fs.includes('105')) return new Response(JSON.stringify({ data: { diff: usRows(pz) } }));
    return new Response(JSON.stringify({ data: { diff: cnStocks(pz) } }));
  }
  if (u.includes('/api/suggest/get')) {
    return new Response(JSON.stringify({ QuotationCodeTable: { Data: [{ QuoteID: '1.600519', Code: '600519', Name: '贵州茅台', Classify: 'AStock', SecurityTypeName: '沪A' }] } }));
  }
  if (u.includes('trends2')) {
    return new Response(JSON.stringify({ data: { name: '假标的', preClose: 10, trends: ['2026-11-11 09:30,10.1,100,10.05', '2026-11-11 09:31,10.2,120,10.06'] } }));
  }
  if (u.includes('/api/qt/stock/kline/get')) {
    return new Response(JSON.stringify({ data: { klines: ['2026-11-10,10,10.2,10.3,9.9,1e6', '2026-11-11,10.2,10.4,10.5,10.1,1.2e6'] } }));
  }
  throw new Error(`未假定的上游：${u.slice(0, 60)}`);
};

async function call(action, payload = {}, token) {
  const r = await handle({
    request: new Request(`http://x/functions/v1/app?action=${action}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(token ? { ...payload, token } : payload),
    }),
    supabase,
  });
  return { status: r.status, json: await r.json() };
}
let passed = 0;
let failed = 0;
const ok = (name, pass, detail = '') => {
  if (pass) passed += 1; else failed += 1;
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

process.env.ADMIN_USERNAMES = 'qq_boss';
const boss = await call('register', { username: 'qq_boss', password: 'probe12345', display: '行情后台' });
const bt = boss.json.token;

const board = await call('board');
ok('假上游能建起 A 股池', (board.json.market?.indexes?.length ?? 0) >= 5 && (board.json.market?.stocks?.length ?? 0) >= 20,
  `指数 ${board.json.market?.indexes?.length} · 个股 ${board.json.market?.stocks?.length}`);

const status = await call('admin_quote_status', {}, bt);
ok('行情源状态可读', status.json.ok === true && status.json.probes?.length === 8 && status.json.hosts?.length >= 2,
  `域名 ${status.json.hosts?.join(', ')}`);

const check = await call('admin_quote_check', {}, bt);
ok('检测：八个端点全部可用时结论为 ok', check.json.verdict === 'ok' && check.json.okCount === 8,
  `${check.json.okCount}/${check.json.total} · 建议 ${(check.json.advice ?? []).length} 条`);

failSingle = true;
quotes.setQuoteSource({ cnTtlMs: 0 }); // 强制重新取，绕开缓存
const check2 = await call('admin_quote_check', {}, bt);
const single = (check2.json.results ?? []).find((row2) => row2.key === 'single');
const fx = (check2.json.results ?? []).find((row2) => row2.key === 'fx');
ok('检测：单标的接口挂掉时结论为 partial 并给出建议',
  check2.json.verdict === 'partial' && single?.ok === false && fx?.ok === false
  && (check2.json.advice ?? []).some((text) => text.includes('单标的')),
  `结论 ${check2.json.verdict} · 可用 ${check2.json.okCount}/${check2.json.total}`);

const board2 = await call('board');
ok('单标的接口挂掉时池子仍然可用并标注降级',
  (board2.json.market?.stocks?.length ?? 0) >= 20 && board2.json.market?.status?.partial?.includes('ETF'),
  `个股 ${board2.json.market?.stocks?.length} · partial=${board2.json.market?.status?.partial ?? '无'}`);

const boardUs = await call('board', { market: 'us' });
ok('美股池与指数来自板块接口（不依赖单标的接口）',
  (boardUs.json.market?.stocks?.length ?? 0) >= 10 && (boardUs.json.market?.indexes?.length ?? 0) === 4
  && boardUs.json.market?.breadth === null,
  `个股 ${boardUs.json.market?.stocks?.length} · 指数 ${boardUs.json.market?.indexes?.length} · 涨跌家数 ${String(boardUs.json.market?.breadth)}`);

failSingle = false;
const badSave = await call('admin_settings', { patch: { quote_source: { listHost: 'evil.example.com', usPoolSize: 99999 } }, confirm: true }, bt);
ok('白名单域名与越界数值被逐项拒绝',
  badSave.status === 400 && badSave.json.rejected?.length === 2, (badSave.json.rejected ?? []).join('；'));

const goodSave = await call('admin_settings', {
  patch: { quote_source: { listHost: 'push2delay.eastmoney.com', usPoolSize: 60, etfs: ['1.510300', 'bad', '0.159915', '1.510050'] } },
  confirm: true,
}, bt);
const after = (await call('admin_quote_status', {}, bt)).json;
ok('合法改动立即生效、非法代码剔除、审计留痕',
  goodSave.json.ok === true && after.source.listHost === 'push2delay.eastmoney.com' && after.source.usPoolSize === 60
  && after.source.etfs?.length === 3 && JSON.stringify(goodSave.json.changed).includes('quote_source.listHost'),
  `域名 ${after.source.listHost} · 美股池 ${after.source.usPoolSize} · ETF ${after.source.etfs?.length} 条`);

const boardDelay = await call('board', { market: 'us' });
ok('换域名后下一次请求就走新域名', calls.some((text) => text.includes('push2delay')) && (boardDelay.json.market?.stocks?.length ?? 0) >= 5,
  `已请求过的域名：${[...new Set(calls.map((text) => text.split('/')[2]))].join(', ')}`);

const usPoolAfter = (await call('admin_quote_check', {}, bt)).json;
ok('检测结论跟着新配置走（池子变小）', usPoolAfter.total === 8 && usPoolAfter.results.some((row2) => row2.key === 'us_board' && row2.ok),
  `结论 ${usPoolAfter.verdict} · ${usPoolAfter.okCount}/${usPoolAfter.total}`);

const reset = await call('admin_settings', { patch: { quote_source: status.json.defaults }, confirm: true }, bt);
const afterReset = (await call('admin_quote_status', {}, bt)).json;
ok('恢复默认配置生效', reset.json.ok === true && afterReset.source.listHost === 'push2.eastmoney.com'
  && afterReset.source.usPoolSize === 200 && afterReset.source.etfs?.length === 8,
  `域名 ${afterReset.source.listHost} · 美股池 ${afterReset.source.usPoolSize} · ETF ${afterReset.source.etfs?.length}`);

const nonAdmin = await call('admin_quote_status', {}, boss.json.token.replace(/^./, 'x'));
ok('无效凭证读不到行情源状态', nonAdmin.status === 401, nonAdmin.json.code);

console.log(`\nSUMMARY pass=${passed} fail=${failed}`);
process.exit(failed ? 1 : 0);
