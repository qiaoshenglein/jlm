// 行情源链的离线回归：三家上游全部假掉，专测「谁挂了→换成谁→冷却→全挂怎么办」，
// 以及配置校验、检测结论、降级标注。不依赖网络，上游被封时照样能跑。
// 用法：node dev/quote-probe.mjs
// 字段索引在这里是写死的（与 quote-sources.mjs 一一对应）：解析器改了索引，这条必须炸。
const RealDate = Date;
const beijing = new RealDate(Date.now() + 8 * 3600_000);
const day = `${beijing.getUTCFullYear()}-${String(beijing.getUTCMonth() + 1).padStart(2, '0')}-${String(beijing.getUTCDate()).padStart(2, '0')}`;
// 上一个「同一天」的日期，用来给周线造假数据：周 K 的首根必须落在这天
const weekAgo = new RealDate(new RealDate(`${day}T00:00:00Z`).getTime() - 7 * 86400_000).toISOString().slice(0, 10);
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

const tsSec = Math.floor(clock / 1000);
// 东财板块行
const emRow = (market, code, name, price) => ({
  f2: price, f3: 1.5, f4: 0.1, f5: 1000, f6: 1e7, f7: 2, f8: 1.2,
  f12: code, f13: market, f14: name, f15: price * 1.05, f16: price * 0.95, f17: price * 0.99,
  f18: price * 0.98, f20: 1e10, f124: tsSec,
});
const emOne = (price, code, name) => ({
  f43: price, f44: price * 1.05, f45: price * 0.95, f46: price * 0.99, f47: 1000, f48: 1e7,
  f57: code, f58: name, f60: price * 0.98, f86: tsSec, f168: 1.2, f169: 0.01, f170: 1.5, f171: 0.1,
});
// 腾讯快照：~ 分隔的字段数组，索引就是实测到的那一套
function qqFields(name, code, price, us = false) {
  const a = new Array(us ? 73 : 88).fill('');
  a[1] = name; a[2] = code; a[3] = String(price); a[4] = String(price * 0.98); a[5] = String(price * 0.99);
  a[6] = '1000';
  a[30] = us ? `${day} 10:00:00` : `${day.replace(/-/g, '')}150003`;
  a[32] = '1.5'; a[33] = String(price * 1.05); a[34] = String(price * 0.95);
  if (us) { a[37] = String(price * 1000); a[45] = '2000'; }
  else { a[35] = `${price}/1000/${price * 1e4}`; a[37] = String(price); a[38] = '0.32'; a[45] = '2000'; a[47] = String(price * 0.98 * 1.1); a[48] = String(price * 0.98 * 0.9); }
  return a;
}
// 新浪快照：逗号分隔，0 名称 1 开 2 昨收 3 价 4 高 5 低 8 量(股) 9 额(元) 30 日期 31 时间
function sinaFields(name, price) {
  const a = new Array(33).fill('0');
  a[0] = name; a[1] = String(price * 0.99); a[2] = String(price * 0.98); a[3] = String(price);
  a[4] = String(price * 1.05); a[5] = String(price * 0.95); a[8] = '100000'; a[9] = String(price * 1e4);
  a[30] = day; a[31] = '15:00:03';
  return a;
}
// ---- 假上游：三家各一套 URL 形状，开关控制谁活着 ----
const alive = { em: true, tx: true, sina: true };
const flags = { txNoWeek: false };
let calls = [];
const QQ_RANK = Array.from({ length: 80 }, (_, i) => `sz${300000 + i}`);
globalThis.fetch = async (input) => {
  const u = String(input);
  calls.push(u);
  const host = u.split('/')[2] ?? '';
  const json = (obj) => new Response(JSON.stringify(obj), { headers: { 'content-type': 'application/json' } });
  const text = (s) => new Response(s, { headers: { 'content-type': 'text/plain; charset=gbk' } });

  if (host.includes('eastmoney.com')) {
    if (!alive.em) throw new Error('forced_socket_reset');
    if (host.startsWith('searchapi')) {
      return json({ QuotationCodeTable: { Data: [{ QuoteID: '1.600519', Code: '600519', Name: '假茅台', Classify: 'AStock', SecurityTypeName: '沪A' }] } });
    }
    if (u.includes('/api/qt/stock/get')) {
      const secid = new URL(u).searchParams.get('secid');
      if (secid === '133.USDCNH') return json({ data: emOne(6.67, 'USDCNH', '美元兑离岸人民币') });
      return json({ data: emOne(4.2, String(secid).split('.')[1], '假ETF') });
    }
    if (u.includes('/api/qt/clist/get')) {
      const fs = new URL(u).searchParams.get('fs') ?? '';
      const pz = Number(new URL(u).searchParams.get('pz') ?? 5);
      if (fs.startsWith('b:')) {
        return json({ data: { diff: quotes.KEY_INDEXES.map(([secid, name], i) => { const [m, code] = secid.split('.'); return emRow(Number(m), code, name, 3000 + i); }) } });
      }
      if (fs.startsWith('i:100.')) {
        return json({ data: { diff: quotes.US_INDEXES.map(([secid, name], i) => emRow(100, secid.split('.')[1], name, 5000 + i)) } });
      }
      if (fs.startsWith('i:')) {
        const secid = fs.slice(2);
        const [m, code] = secid.split('.');
        return json({ data: { diff: [emRow(Number(m), code, '假单标', 123.4)] } });
      }
      if (fs.includes('105')) {
        return json({ data: { diff: Array.from({ length: Math.min(pz, 200) }, (_, i) => emRow(i % 3 === 0 ? 106 : 105, `US${i}`, `假美股${i}${i % 7 === 0 ? 'ETF' : ''}`, 50 + i)) } });
      }
      return json({ data: { diff: Array.from({ length: Math.min(pz, 150) }, (_, i) => emRow(1, `60${10000 + i}`, `假A股${i}`, 10 + i / 20)) } });
    }
    if (u.includes('/api/qt/stock/trends2/get')) {
      return json({ data: { name: '假标的', preClose: 10, trends: [`${day} 09:30,10.1,100,10.05`, `${day} 09:31,10.2,120,10.06`] } });
    }
    if (u.includes('/api/qt/stock/kline/get')) {
      // klt=101 日线、102 周线：周线必须回不同的周，否则断言分不清到底走没走原生周线
      if (u.includes('klt=102')) {
        return json({ data: { klines: [`${weekAgo},9.6,10,10.4,9.5,4800`, `${day},10,10.2,10.3,9.9,1000`, `${day},10.2,10.4,10.5,10.1,1200`] } });
      }
      if (!u.includes('klt=101')) throw new Error(`未假定的 klt：${u.slice(u.indexOf('klt='), u.indexOf('klt=') + 12)}`);
      return json({ data: { klines: [`${day},10,10.2,10.3,9.9,1000`, `${day},10.2,10.4,10.5,10.1,1200`] } });
    }
  }

  if (host === 'qt.gtimg.cn') {
    if (!alive.tx) throw new Error('forced_socket_reset');
    const codes = decodeURIComponent(u.slice(u.indexOf('/q=') + 3)).split(',');
    if (codes[0] === 'whUSDCNY') {
      const a = new Array(20).fill(''); a[1] = 'USDCNY'; a[3] = '6.6715';
      return text(`v_whUSDCNY="${a.join('~')}";`);
    }
    const body = codes.map((native) => {
      const us = native.startsWith('us');
      const code = us ? native.slice(2).toUpperCase() : native.slice(2);
      const price = us ? 100 + code.length : 20 + (Number(code.slice(-3)) % 50);
      return `v_${native}="${qqFields(us ? `US${code}` : `TX${code}`, us ? `${code}.OQ` : code, price, us).join('~')}"`;
    }).join(';');
    return text(`${body};`);
  }
  if (host === 'proxy.finance.qq.com') {
    if (!alive.tx) throw new Error('forced_socket_reset');
    const params = new URL(u).searchParams;
    const offset = Number(params.get('offset') ?? 0);
    const count = Number(params.get('count') ?? 0);
    if (count > 200) return json({ code: 1619377101, msg: 'over limit', data: { rank_list: [] } });
    const slice = QQ_RANK.slice(offset, offset + count);
    return json({ code: 0, data: { total: 4606, rank_list: slice.map((native, i) => ({ code: native, name: `RANK${i}`, zxj: String(11 + i), zdf: '1.5' })) } });
  }
  if (host.includes('ifzq.gtimg.cn')) {
    if (!alive.tx) throw new Error('forced_socket_reset');
    const native = (u.match(/code=(\w+)/) ?? [])[1] ?? (u.match(/param=(\w+)/) ?? [])[1];
    if (u.includes('minute/query')) {
      return json({ code: 0, data: { [native]: { data: { date: day.replace(/-/g, ''), data: ['0930 20.00 100 200000.00', '0931 20.10 120 240000.00'] }, qt: { [native]: qqFields('TXMIN', native.slice(2), 20) } } } });
    }
    const rows = Array.from({ length: 5 }, (_, i) => [`${day},20,20.2,20.3,19.9,1000`, `${day},20.2,20.4,20.5,20.1,1200`][i % 2]);
    // 周线走 week / qfqweek 键；flags.txNoWeek 模拟「这条接口对该标的根本不回周线」
    const span = (u.match(/param=\w+,(\w+),/) ?? [])[1] ?? 'day';
    if (span === 'week' && !flags.txNoWeek) {
      const weeks = [`${weekAgo},19,20,20.6,18.9,5200`, `${day},20,20.2,20.5,19.8,5400`];
      return json({ code: 0, data: { [native]: { [native.startsWith('us') ? 'week' : 'qfqweek']: weeks.map((line) => line.split(',')) } } });
    }
    return json({ code: 0, data: { [native]: { [native.startsWith('us') ? 'day' : 'qfqday']: rows.map((line) => line.split(',')) } } });
  }

  if (host === 'hq.sinajs.cn') {
    if (!alive.sina) throw new Error('sina_403');
    const list = decodeURIComponent(u.slice(u.indexOf('/list=') + 6)).split(',');
    return text(list.map((native) => `var hq_str_${native}="${sinaFields(`假新浪${native.slice(2)}`, 21).join(',')}";`).join('\n'));
  }
  if (host === 'vip.stock.finance.sina.com.cn') {
    if (!alive.sina) throw new Error('sina_403');
    const page = Number(new URL(u).searchParams.get('page') ?? 1);
    const num = Number(new URL(u).searchParams.get('num') ?? 80);
    const list = QQ_RANK.slice((page - 1) * num, (page - 1) * num + num)
      .map((symbol, i) => ({ symbol, code: symbol.slice(2), name: `SX${i}`, trade: String(21 + i) }));
    return json(list);
  }
  if (host === 'quotes.sina.cn') {
    if (!alive.sina) throw new Error('sina_403');
    return json([
      { day: `${day} 15:00:00`, open: '20', high: '20.3', low: '19.9', close: '20.2', volume: '1000' },
      { day: `${day} 15:00:00`, open: '20.2', high: '20.5', low: '20.1', close: '20.4', volume: '1200' },
    ]);
  }
  throw new Error(`未假定的上游：${u.slice(0, 60)}`);
};

async function call(action, payload = {}, token) {
  const response = await handle({
    request: new Request(`http://x/functions/v1/app?action=${action}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(token ? { ...payload, token } : payload),
    }),
    supabase,
  });
  return { status: response.status, json: await response.json() };
}
let passed = 0;
let failed = 0;
const ok = (name, condition, detail = '') => {
  if (condition) passed += 1; else failed += 1;
  console.log(`${condition ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};
const resetCalls = () => { calls = []; };
const hostsCalled = () => [...new Set(calls.map((u) => u.split('/')[2] ?? ''))];
// 假时钟必须往前走：快照缓存与设置缓存都按时间过期，冻住时钟就等于永远读同一份缓存，
// 「换了源」的断言会全部假失败（踩过一次，别再拿它当产品问题）
const tick = (ms = 3_100) => { clock += ms; };
// 配置只有一个写入者：走 admin_settings（真实路径），再 tick 让设置缓存过期。
// 之前混用 quotes.setQuoteSource 直改，会被下一次请求的 readSettingsCached 覆盖回库里的值，
// 于是「改了 TTL / 冷却」的断言测的是竞态而不是行为。
async function setSource(patch) {
  const r = await call('admin_settings', { patch: { quote_source: { ...quotes.quoteSource(), ...patch } }, confirm: true }, bt);
  tick(2_600);
  return r;
}

process.env.ADMIN_USERNAMES = 'qq_boss';
const boss = await call('register', { username: 'qq_boss', password: 'probe12345', display: '行情后台' });
const bt = boss.json.token;

// ---- 1. 三家都活着：东财优先 ----
resetCalls();
await setSource({ cnTtlMs: 1_000, usTtlMs: 1_000 });
let board = (await call('board')).json.market;
ok('三家都在时走东财', board?.status?.source === '东方财富' && !board?.status?.fellBack
  && (board?.stocks?.length ?? 0) >= 20 && (board?.indexes?.length ?? 0) >= 5,
  `源 ${board?.status?.source} · 个股 ${board?.stocks?.length} · 指数 ${board?.indexes?.length} · 域名 ${hostsCalled().join(',')}`);

// ---- 2. 东财挂了：自动降级到腾讯 ----
alive.em = false;
resetCalls();
tick();
board = (await call('board')).json.market;
const txSample = board?.stocks?.[0];
ok('东财全挂时沪深池由腾讯接管并标注降级',
  board?.status?.source === '腾讯财经' && board?.status?.fellBack === true && (board?.stocks?.length ?? 0) >= 20,
  `源 ${board?.status?.source} · 个股 ${board?.stocks?.length} · 指数 ${board?.indexes?.length} · ETF ${board?.etfs?.length}`);
ok('降级后字段口径正确（价格/昨收/涨停/时间戳）',
  txSample && txSample.prevClose > 0 && txSample.limitUp !== null
  && Math.abs(txSample.limitUp / txSample.prevClose - 1.1) < 0.01
  && txSample.ts >= Math.floor((clock - 3 * 86_000_000) / 1000),
  txSample && `${txSample.name} 价 ${txSample.last / 1e6} 昨收 ${txSample.prevClose / 1e6} 涨停 ${txSample.limitUp / 1e6} ts ${txSample.ts}`);

// ---- 3. 冷却：东财在冷却期内不再被打 ----
await call('board');
tick();
resetCalls();
await call('board');
ok('失败源进入冷却后，新一轮不再尝试它', !calls.some((u) => u.includes('push2')),
  `新一轮请求过：${hostsCalled().join(', ') || '无'}`);

// ---- 4. 腾讯也挂：新浪接管 ----
alive.tx = false;
resetCalls();
// cooldownMs 有下限 5000，写 0 会被范围校验拒绝（等于没改），所以用最小值并走够时间
await setSource({ cooldownMs: 5_000 });
tick(6_000);
board = (await call('board')).json.market;
ok('腾讯也挂时新浪接管', board?.status?.source === '新浪财经' && (board?.stocks?.length ?? 0) >= 20,
  `源 ${board?.status?.source} · 个股 ${board?.stocks?.length} · 域名 ${hostsCalled().join(',')}`);
ok('新浪没有涨跌停字段时按板块规则补算（300 开头是创业板 ±20%）', (() => {
  const row = board?.stocks?.[0];
  const ratio = Number(String(row?.secid ?? '').slice(-6)[0]) === 3 ? 1.2 : 1.1;
  return row && row.limitUp !== null && Math.abs(row.limitUp / row.prevClose - ratio) < 0.02;
})(), JSON.stringify((board?.stocks ?? []).slice(0, 1).map((row) => `${row.secid} 涨停 ${row.limitUp / 1e6} / 昨收 ${row.prevClose / 1e6}`)[0] ?? '空'));

// ---- 5. 三家全挂：保留上次快照，且不撮合 ----
alive.sina = false;
resetCalls();
tick(3_100);
const after = await call('board');
ok('全部上游不可用时仍给出上一次快照并报错',
  after.json.ok === true && after.json.market?.status?.ok === false && (after.json.market?.stocks?.length ?? 0) >= 20,
  `note ${after.json.market?.status?.note} · 个股 ${after.json.market?.stocks?.length}`);
const me = await call('order', { secid: '1.601000', side: 'buy', qty: 100, mode: 'market' }, bt);
ok('行情不可用时下单被拒而不用旧价成交', ['quote_unavailable', 'unknown_symbol', 'suspended', 'match_paused', 'market_closed'].includes(me.json.code),
  `${me.status} ${me.json.code}`);

// ---- 6. 恢复东财：链自动切回首选 ----
alive.em = true; alive.tx = true; alive.sina = true;
await setSource({ cooldownMs: 5_000 });
tick(3_100);
board = (await call('board')).json.market;
ok('上游恢复后自动切回首选源', board?.status?.source === '东方财富' && !board?.status?.fellBack, `源 ${board?.status?.source}`);

// ---- 7. 手动改源序：腾讯优先 ----
const reorder = await call('admin_settings', { patch: { quote_source: { ...quotes.quoteSource(), sourceOrder: ['tencent', 'sina', 'eastmoney'] } }, confirm: true }, bt);
tick();
resetCalls();
board = (await call('board')).json.market;
ok('源序可热改：腾讯优先后不再打东财',
  reorder.json.ok === true && board?.status?.source === '腾讯财经' && !calls.some((u) => u.includes('push2')),
  `源 ${board?.status?.source} · 域名 ${hostsCalled().join(',')}`);
const noFallback = await call('admin_settings', { patch: { quote_source: { ...quotes.quoteSource(), fallbackEnabled: false } }, confirm: true }, bt);
ok('关掉自动降级后源序只剩首选', noFallback.json.ok === true
  && JSON.stringify(noFallback.json.changed ?? {}).includes('quote_source.fallbackEnabled'),
  Object.keys(noFallback.json.changed ?? {}).join(','));
// 关掉降级 + 只留腾讯：东财挂时不该换新浪
// 先让东财成功一份快照，再关掉降级并杀东财：应该退到上一次的快照，而不是擅自换一家
await setSource({ fallbackEnabled: false, sourceOrder: ['eastmoney', 'tencent'] });
alive.em = true;
tick();
const warm = await call('board');
alive.em = false;
tick();
const solo = await call('board');
ok('关掉降级后东财挂了：退到上次快照而不是换源',
  warm.json.market?.status?.source === '东方财富' && solo.json.market?.status?.source !== '新浪财经'
  && (solo.json.market?.stocks?.length ?? 0) >= 20 && solo.json.market?.status?.ok === false,
  `预热 ${warm.json.market?.status?.source} → 挂后 ${solo.json.market?.status?.source} · 个股 ${solo.json.market?.stocks?.length} · note ${solo.json.market?.status?.note}`);
alive.em = true;

// ---- 8. 汇率降级口径要说清楚 ----
await call('admin_settings', { patch: { quote_source: quotes.QUOTE_SOURCE_DEFAULTS }, confirm: true }, bt);
quotes.setQuoteSource(quotes.QUOTE_SOURCE_DEFAULTS);
alive.em = false;
tick(70_000);
const fxTx = await quotes.getFx(new RealDate(clock));
const fxMeta = quotes.fxSource();
ok('汇率在东财挂时换腾讯在岸价并标注口径', fxTx > 6 * 1e6 && fxTx < 7 * 1e6 && fxMeta.label === '在岸 USDCNY（腾讯）',
  `${(fxTx / 1e6).toFixed(4)} · ${fxMeta.label}`);
alive.em = true; alive.tx = false;
await setSource(quotes.QUOTE_SOURCE_DEFAULTS);
tick(70_000);
const fxEast = await quotes.getFx(new RealDate(clock));
ok('东财在时汇率走离岸 USDCNH', fxEast > 6 * 1e6 && quotes.fxSource().label === '离岸 USDCNH', `${(fxEast / 1e6).toFixed(4)}`);
alive.tx = true;

// ---- 9. 美股降级池：没有腾讯榜也能按持仓与固定表定价 ----
alive.em = false;
await setSource({ usTtlMs: 1_000, cooldownMs: 5_000 });
tick(3_100);
const usBoard = (await call('board', { market: 'us' })).json.market;
ok('美股在降级源下仍有个股与指数',
  usBoard?.status?.source === '腾讯财经' && (usBoard?.stocks?.length ?? 0) >= 10 && (usBoard?.indexes?.length ?? 0) === 4,
  `源 ${usBoard?.status?.source} · 个股 ${usBoard?.stocks?.length} · 指数 ${usBoard?.indexes?.length} · 涨跌家数 ${String(usBoard?.breadth)}`);
const aapl = await call('lookup', { symbol: 'AAPL' });
ok('美股按代码直查在降级源下可用', aapl.json.ok === true && aapl.json.quote?.last > 0,
  `${aapl.json.quote?.secid} ${aapl.json.quote?.name} ${aapl.json.quote?.last / 1e6}`);
alive.em = true;
quotes.setQuoteSource(quotes.QUOTE_SOURCE_DEFAULTS);

// ---- 10. 检测：逐源逐能力，结论按能力覆盖而不是条数 ----
const check = await call('admin_quote_check', {}, bt);
ok('检测覆盖三家的全部能力并给出逐源结果',
  check.json.verdict === 'ok' && check.json.total >= 20 && check.json.coverage?.length >= 10
  && new Set((check.json.results ?? []).map((row) => row.provider)).size === 3,
  `结论 ${check.json.verdict} · ${check.json.okCount}/${check.json.total} · 能力 ${check.json.coverage?.length} 项`);
alive.em = false;
await setSource({ cnTtlMs: 1_000 });
tick(3_100);
const check2 = await call('admin_quote_check', {}, bt);
ok('东财挂时业务数据类能力仍齐全，只有检索缺（只此一家）',
  check2.json.dead?.includes('suggest') && !['cnStocks', 'cnIndexes', 'usStocks', 'one', 'fx', 'kline', 'trends'].some((cap) => check2.json.dead.includes(cap)),
  `结论 ${check2.json.verdict} · 缺 ${check2.json.dead?.join(',') || '无'} · ${check2.json.okCount}/${check2.json.total}`);
alive.em = false; alive.tx = false; alive.sina = false;
const checkSearch = await call('admin_quote_check', {}, bt);
ok('三家全挂（含检索）时判为不可用并给出一条以上建议',
  checkSearch.json.verdict === 'down' && (checkSearch.json.advice ?? []).length >= 3,
  `结论 ${checkSearch.json.verdict} · 还活着 ${(checkSearch.json.coverage ?? []).filter((c) => c.ok).map((c) => `${c.cap}←${c.providers.join('/')}`).join(' ') || '无'} · 建议 ${(checkSearch.json.advice ?? []).length} 条`);
alive.em = true; alive.tx = true; alive.sina = true;
await setSource(quotes.QUOTE_SOURCE_DEFAULTS);

// ---- 11. 分时与日 K 的降级 ----
const trendsTx = (async () => { alive.em = false; const v = await quotes.trendsOf('1.600519', new RealDate(clock)); alive.em = true; return v; })();
const txTrends = await trendsTx;
ok('分时在东财挂时由腾讯补上', (txTrends?.points?.length ?? 0) > 0 && txTrends.preClose > 0,
  `${txTrends?.points?.length} 点 · 昨收 ${txTrends?.preClose / 1e6}`);
alive.em = false; alive.tx = false;
const klineSina = await quotes.klineOf('1.600519', 5, 'day', new RealDate(clock)).catch(() => null);
alive.em = true; alive.tx = true;
ok('日 K 逐级下探到新浪并按其字段序还原 OHLC',
  (klineSina?.length ?? 0) === 2 && klineSina[0].high >= klineSina[0].low && klineSina[0].close > 0,
  JSON.stringify(klineSina?.[0] ?? null));

// ---- 11b. 周 K：三家各有各的取法，缓存按 period 分档 ----
// 上一节东财与腾讯都被判过失败，冷却没过源链就会直接跳到新浪，这段便测不到原生周线
tick(65_000);
resetCalls();
const weekEm = await quotes.klineOf('1.600519', 5, 'week', new RealDate(clock)).catch(() => null);
const dayCached = await quotes.klineOf('1.600519', 5, 'day', new RealDate(clock)).catch(() => null);
ok('周 K 首选东财原生 klt=102，且与同参数的日 K 各存各的缓存',
  (weekEm?.length ?? 0) === 3 && weekEm[0].day === weekAgo
  && calls.length === 1 && calls[0].includes('klt=102')
  && (dayCached?.length ?? 0) === 2 && dayCached[0].day === day,
  `周 ${weekEm?.length} 根（首根 ${weekEm?.[0]?.day}）· 日 ${dayCached?.length} 根 · 出网 ${calls.length} 次`);

alive.em = false;
resetCalls();
const weekTx = await quotes.klineOf('1.600519', 6, 'week', new RealDate(clock)).catch(() => null);
alive.em = true;
ok('东财挂时周 K 由腾讯的 week 键接管',
  (weekTx?.length ?? 0) === 2 && weekTx[0].day === weekAgo && calls.some((u) => u.includes(',week,')),
  `${weekTx?.length} 根 · 域名 ${hostsCalled().join(',')} · 周线请求 ${calls.filter((u) => u.includes(',week,')).length} 次`);

flags.txNoWeek = true; alive.em = false;
resetCalls();
const weekTxDaily = await quotes.klineOf('1.600519', 8, 'week', new RealDate(clock)).catch(() => null);
alive.em = true; flags.txNoWeek = false;
ok('腾讯不回周线时退回「多取日线、本地按周合并」，周 K 不会整个空掉',
  (weekTxDaily?.length ?? 0) === 1 && weekTxDaily[0].volume === 5_400
  && calls.some((u) => u.includes(',week,')) && calls.some((u) => u.includes(',day,')),
  `${weekTxDaily?.length} 根 · 量 ${weekTxDaily?.[0]?.volume} · 出网 ${calls.length} 次`);

alive.em = false; alive.tx = false;
resetCalls();
const weekSina = await quotes.klineOf('1.600519', 7, 'week', new RealDate(clock)).catch(() => null);
alive.em = true; alive.tx = true;
ok('新浪只有日线：周 K 靠本地合并，datalen 有 60 行的下限保证够合并',
  (weekSina?.length ?? 0) === 1 && weekSina[0].volume === 2_200
  && calls.some((u) => u.includes('scale=240') && u.includes('datalen=60')),
  JSON.stringify(weekSina?.[0] ?? null));

// chart 接口这一段要重新走源链：上一节把东财与腾讯都打进冷却了，不推时钟就只会命中新浪
// count 有 30 的下限（与接口口径一致），所以这里用 40，不复用上面 count=5 的那份缓存
tick(65_000);
const chartWeek = await call('chart', { secid: '1.600519', kind: 'kline', period: 'week', count: 40 });
const chartDay = await call('chart', { secid: '1.600519', kind: 'kline', count: 40 });
const chartTrends = await call('chart', { secid: '1.600519', kind: 'trends', period: 'week' });
ok('chart 接口按 period 分档返回，日/周互不覆盖',
  chartWeek.json.ok === true && chartWeek.json.period === 'week' && chartWeek.json.series?.length === 3
  && chartWeek.json.series?.[0]?.day === weekAgo
  && chartDay.json.period === 'day' && chartDay.json.series?.length === 2
  && chartTrends.json.period === 'day' && Array.isArray(chartTrends.json.series?.points),
  `周 ${chartWeek.json.series?.length} 根（首根 ${chartWeek.json.series?.[0]?.day}）· 日 ${chartDay.json.series?.length} 根 · 分时 ${chartTrends.json.series?.points?.length} 点`);

// ---- 11c. 上游用量计数：同一根 K 线点两次，只算一次出网 ----
// 这段用假上游自己收到的请求数当对照——计数说几次，实际就得是几次，否则卡片在说谎
tick(65_000);
resetCalls();
const worker = await call('register', { username: 'qq_worker', password: 'probe12345', display: '看盘的人' });
const afterReset = await call('admin_quote_usage_reset', {}, bt);
ok('重置用量计数后归零', afterReset.status === 200 && afterReset.json.total?.calls === 0
  && (afterReset.json.byCap?.length ?? 1) === 0 && (afterReset.json.cache?.length ?? 1) === 0,
  `调用 ${afterReset.json.total?.calls} · 能力 ${(afterReset.json.byCap ?? []).length} 项`);
const capOf = (usage, key) => usage.byCap.find((row) => row.key === key) ?? { calls: 0, ok: 0, fail: 0 };
const layerOf = (usage, key) => usage.cache.find((row) => row.layer === key) ?? { hit: 0, miss: 0, merged: 0, rate: 0 };
await call('chart', { secid: '1.600036', kind: 'kline', count: 50 });
await call('chart', { secid: '1.600036', kind: 'kline', count: 50 });
await call('chart', { secid: '1.600036', kind: 'kline', period: 'week', count: 50 });
const usageK = (await call('admin_quote_usage', {}, bt)).json;
ok('同键日 K 点两次只出网一次，换周 K 是新键再出网一次',
  capOf(usageK, 'kline').calls === 2 && layerOf(usageK, 'kline').miss === 2
  && layerOf(usageK, 'kline').hit === 1 && layerOf(usageK, 'kline').rate === 33,
  `出网 ${capOf(usageK, 'kline').calls} 次 · 挡下 ${layerOf(usageK, 'kline').hit} 次 · 命中率 ${layerOf(usageK, 'kline').rate}%`);
ok('计数次数与假上游收到的请求数一致', calls.length === usageK.total.calls,
  `上游收到 ${calls.length} 条 · 计数 ${usageK.total.calls} 次`);
ok('总量与按能力、按源的分布自洽',
  usageK.total.calls === usageK.byCap.reduce((sum, row) => sum + row.calls, 0)
  && usageK.total.calls === usageK.byProvider.reduce((sum, row) => sum + row.calls, 0)
  && usageK.total.ok + usageK.total.fail === usageK.total.calls,
  `总 ${usageK.total?.calls} · 能力合计 ${usageK.byCap?.reduce((s, r) => s + r.calls, 0)} · 源合计 ${usageK.byProvider?.reduce((s, r) => s + r.calls, 0)}`);

resetCalls();
await call('board', {}, bt);
const poolFirst = (await call('admin_quote_usage', {}, bt)).json;
const boardCalls = poolFirst.total.calls;
resetCalls();
await call('board', {}, bt);
const poolTwice = (await call('admin_quote_usage', {}, bt)).json;
ok('TTL 内的第二次同步不再出网，只算一次快照命中',
  poolTwice.total.calls === boardCalls && layerOf(poolTwice, 'pool_cn').hit >= 1
  && layerOf(poolTwice, 'pool_cn').miss >= 1 && calls.length === 0,
  `挡下 ${layerOf(poolTwice, 'pool_cn').hit} 次 · 刷新 ${layerOf(poolTwice, 'pool_cn').miss} 次 · 本窗口出网 ${calls.length} 次`);
ok('用量按分钟给桶，窗口固定 30 格', usageK.perMinute?.length === 30 && usageK.windowMinutes === 30
  && usageK.perMinute.at(-1).calls >= 1, `桶 ${usageK.perMinute?.length} · 当前分钟 ${usageK.perMinute?.at(-1)?.calls} 次`);
const noToken = await call('admin_quote_usage', {});
const notAdmin = await call('admin_quote_usage', {}, worker.json.token);
ok('读用量要管理员凭证', noToken.json.code === 'login_required' && notAdmin.json.code === 'not_admin',
  `无凭证 ${noToken.json.code} · 普通用户 ${notAdmin.json.code}`);
const getReset = await handle({
  request: new Request('http://x/functions/v1/app?action=admin_quote_usage_reset', {
    method: 'GET', headers: { authorization: `Bearer ${bt}` },
  }),
  supabase,
});
ok('重置计数只认 POST', getReset.status === 405, `GET 回 ${getReset.status}`);

// ---- 12. 配置校验：源序、冷却、新域名 ----
const badOrder = await call('admin_settings', { patch: { quote_source: { sourceOrder: ['eastmoney', 'baidu'] } }, confirm: true }, bt);
ok('未知源名被逐项拒绝', badOrder.status === 400 && /sourceOrder/.test((badOrder.json.rejected ?? []).join('；')), (badOrder.json.rejected ?? []).join('；'));
const badCooldown = await call('admin_settings', { patch: { quote_source: { cooldownMs: 9_999_999 } }, confirm: true }, bt);
ok('冷却时长越界被拒绝', badCooldown.status === 400 && /cooldownMs/.test((badCooldown.json.rejected ?? []).join('；')),
  (badCooldown.json.rejected ?? []).join('；'));
const goodHost = await call('admin_settings', { patch: { quote_source: { txQuoteHost: 'qt.gtimg.cn', sinaQuoteHost: 'hq.sinajs.cn' } }, confirm: true }, bt);
ok('备用源域名在清单内可保存', goodHost.status === 200 && goodHost.json.source?.txQuoteHost === 'qt.gtimg.cn');
const status = await call('admin_quote_status', {}, bt);
ok('行情源状态返回三家与能力矩阵',
  status.json.providers?.length === 3 && status.json.probes?.length >= 20 && status.json.hosts?.length >= 11
  && status.json.defaults.sourceOrder.join(',') === 'eastmoney,tencent,sina',
  `源 ${status.json.providers?.map((p) => p.label).join('/')} · 域名 ${status.json.hosts?.length} 个 · 探测项 ${status.json.probes?.length}`);
const reset = await call('admin_settings', { patch: { quote_source: quotes.QUOTE_SOURCE_DEFAULTS }, confirm: true }, bt);
ok('恢复默认配置生效', reset.json.ok === true && reset.json.source.fallbackEnabled === true
  && reset.json.source.sourceOrder?.[0] === 'eastmoney');

console.log(`\nSUMMARY pass=${passed} fail=${failed}`);
process.exit(failed ? 1 : 0);
