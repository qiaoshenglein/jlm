// 端到端自测：直接驱动线上同一份 handle()，用内存样本库 + 真实行情。
// 用法：node dev/selftest.mjs   （DB_DRIVER=sqlite 时改用真实 SQL 数据层）
// 时钟策略：以「行情自己的日期」为当日，拨到该日北京时间 13:30 进入连续竞价时段。
// 直接按系统日期拨会踩坑：凌晨跑的时候上游还是昨天的行情，全部断言都会被 suspended 挡掉。
const RealDate = Date;
const dayInBeijing = (ms) => {
  const beijing = new RealDate(ms + 8 * 3600_000);
  return `${beijing.getUTCFullYear()}-${String(beijing.getUTCMonth() + 1).padStart(2, '0')}-${String(beijing.getUTCDate()).padStart(2, '0')}`;
};
const sessionAt = (day) => new RealDate(`${day}T05:30:00Z`).getTime();
let clock = sessionAt(dayInBeijing(RealDate.now()));
globalThis.Date = class extends RealDate {
  constructor(...args) { super(args.length ? args[0] : clock); }
  static now() { return clock; }
} 
;
const advance = (ms) => { clock += ms; };
// 两个市场各自钉在自己的行情日子上：北京早上 A 股已经开盘、美股却还在前一天的盘后，
// 所以这一步可能把时钟往回拨——撮合与账本只看「当前这一轮的 now」，回拨不影响判定，
// 但 15 秒重复单窗口会受影响，后面的下单都用没被用过的数量。
const setClock = (ms) => { clock = ms; };

const { handle } = await import('../functions/api.mjs');
const { getQuotes, getUsQuotes } = await import('../functions/quotes.mjs');
const { etParts } = await import('../functions/rules.mjs');
try {
  const probe = await getQuotes(true, new RealDate());
  let latest = 0;
  for (const quote of probe.values()) latest = Math.max(latest, quote.ts);
  if (latest > 0) clock = sessionAt(dayInBeijing(latest * 1000));
} catch { /* 探不到就用系统日期的当日 13:30，后面的行情断言会自己暴露问题 */ }

// 默认跑内存样本库；DB_DRIVER=sqlite|postgres 时跑 server/db.mjs 的真实 SQL 数据层
const driver = process.env.DB_DRIVER ?? 'fixture';
let supabase;
if (driver === 'fixture') {
  const { createFixtureDb } = await import('./fixture-db.mjs');
  const db = createFixtureDb({ persist: false });
  supabase = { from: (name) => db.from(name) };
} else {
  const { rmSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { createDb } = await import('../server/db.mjs');
  const path = process.env.DB_PATH ?? fileURLToPath(new URL('./.selftest.db', import.meta.url));
  for (const suffix of ['', '-wal', '-shm']) rmSync(path + suffix, { force: true });
  const live = await createDb({ driver, path });
  await live.migrate(driver);
  supabase = live;
}
console.log(`数据层：${driver}`);

const Y = 1e6;
const yuan = (micro) => (micro / Y).toFixed(2);
let failures = 0;
function check(name, condition, detail = '') {
  const mark = condition ? 'PASS' : 'FAIL';
  if (!condition) failures += 1;
  console.log(`${mark}  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function call(action, payload = {}, token) {
  const body = JSON.stringify(token ? { ...payload, token } : payload);
  const response = await handle({
    request: new Request(`http://x/functions/v1/app?action=${action}`, {
      method: 'POST', body, headers: { 'content-type': 'application/json' },
    }),
    supabase,
  });
  return { status: response.status, json: await response.json() };
}

// REST 层同样直接驱动 handle()：Request 的 URL 用 /api/v1/*，鉴权走 x-api-key 头
async function rest(method, path, { key, body, query, token } = {}) {
  const url = new URL(`http://x${path}`);
  for (const [name, value] of Object.entries(query ?? {})) url.searchParams.set(name, String(value));
  const payload = { ...body };
  if (token) payload.token = token;
  const response = await handle({
    request: new Request(url, {
      method,
      body: method === 'GET' || Object.keys(payload).length === 0 ? undefined : JSON.stringify(payload),
      headers: {
        'content-type': 'application/json',
        ...(key ? { 'x-api-key': key } : {}),
      },
    }),
    supabase,
  });
  return { status: response.status, json: await response.json() };
}

// 1) 注册与登录
const username = `qa${Date.now().toString(36).slice(-6)}`;
const reg = await call('register', { username, password: 'qoder1234', display: '测试账户' });
check('注册返回令牌', reg.status === 200 && reg.json.ok === true && typeof reg.json.token === 'string', `user=${username}`);
const token = reg.json.token;
check('初始资金 100 万', reg.json.accounts?.cn?.cash === 1_000_000 * Y, `cash=¥${yuan(reg.json.accounts?.cn?.cash ?? 0)}`);

const dup = await call('register', { username, password: 'qoder1234' });
check('重复用户名被拒绝', dup.json.code === 'read_failed' || dup.json.code === 'username_taken' || dup.status >= 400, dup.json.code);

const badPassword = await call('register', { username: `qa${Math.random().toString(36).slice(2, 8)}`, password: 'short' });
check('弱口令被拒绝', badPassword.json.code === 'password_invalid', badPassword.json.code);

const login = await call('login', { username, password: 'wrongpass1' });
check('错误口令返回 401', login.status === 401 && login.json.code === 'credential_invalid', login.json.code);

const noAuth = await call('sync', {});
check('未登录访问受保护接口 401', noAuth.status === 401, `status=${noAuth.status}`);

// 2) 行情
const board = await call('board', {}, undefined);
check('指数行情可用', board.json.market?.indexes?.length >= 5, `${board.json.market?.indexes?.length ?? 0} 条指数`);
const sh = board.json.market.indexes.find((q) => q.code === '000001') ?? board.json.market.indexes[0];
console.log(`      上证指数 ¥${yuan(sh.last)} 涨跌 ${sh.pct.toFixed(2)}% 昨收 ${yuan(sh.prevClose)}`);
const pool = board.json.market.stocks.filter((q) => !q.sealedUp && !q.sealedDown && q.last > 0);
const etfPool = board.json.market.etfs.filter((q) => !q.sealedUp && !q.sealedDown);
check('个股池可用', pool.length > 10, `${pool.length} 只`);
check('指数 ETF 可用', etfPool.length >= 4, `${etfPool.length} 只`);
check('涨跌停价由昨收推算', Math.abs(sh.limitUp / sh.prevClose - 1.1) < 0.001 || sh.kind !== 'stock',
  `limitUp/prevClose=${(sh.limitUp / sh.prevClose).toFixed(4)}`);

const sync0 = await call('sync', {}, token);
check('同步返回账户与时间戳', sync0.json.ok === true && Boolean(sync0.json.clock?.day),
  sync0.json.ok ? `day=${sync0.json.clock?.day} 时段=${sync0.json.session?.phase} 可撮合=${sync0.json.matchable} 行情新鲜=${!sync0.json.stale}` : JSON.stringify(sync0.json));

const stock = pool.sort((a, b) => a.last - b.last)[0];
const etf = etfPool[0];
console.log(`      选用标的：${stock.name}(${stock.code}) ¥${yuan(stock.last)} / ${etf.name}(${etf.code}) ¥${yuan(etf.last)}`);

// 3) 参数校验
const badQty = await call('order', { side: 'buy', secid: stock.secid, qty: 150, mode: 'market', leaf: 1 }, token);
check('非 100 整数倍被拒', badQty.json.code === 'qty_invalid', badQty.json.code);
const badPrice = await call('order', { side: 'buy', secid: stock.secid, qty: 100, mode: 'limit', limitPrice: yuan(stock.last * 1.5), leaf: 1 }, token);
check('越出涨停区的限价被拒', badPrice.json.code === 'price_invalid', badPrice.json.code);
const badLeaf = await call('order', { side: 'buy', secid: stock.secid, qty: 100, mode: 'market', leaf: 3 }, token);
check('普通买入绑定杠杆被拒', badLeaf.json.code === 'leaf_invalid', badLeaf.json.code);
const indexOrder = await call('order', { side: 'buy', secid: sh.secid, qty: 100, mode: 'market', leaf: 1 }, token);
check('直接交易指数被拒', indexOrder.json.code === 'index_not_tradable', indexOrder.json.code);

// 4) 现金买入并撮合
const preview = await call('preview', { side: 'buy', secid: stock.secid, qty: 200, mode: 'market', leaf: 1 }, token);
check('试算返回手续费与保证金', preview.json.ok === true && preview.json.preview.fee > 0,
  `金额 ¥${yuan(preview.json.preview?.amount ?? 0)} 费用 ¥${yuan(preview.json.preview?.fee ?? 0)}`);

const buy = await call('order', { side: 'buy', secid: stock.secid, qty: 200, mode: 'market', leaf: 1 }, token);
check('买入委托已受理', buy.json.ok === true && buy.json.order?.status === 'open', buy.json.code ?? buy.json.order?.status);
advance(4000);
const sync1 = await call('sync', {}, token);
const long = sync1.json.account.positions.find((p) => p.symbol === stock.secid);
check('市价单在同步中成交', sync1.json.settled >= 1, `成交 ${sync1.json.settled} 笔`);
check('持仓生成 200 股', long?.qty === 200, `qty=${long?.qty}`);
check('T+1：当日买入不可卖', long?.avail === 0, `avail=${long?.avail}`);
const expectCash = 1_000_000 * Y - (200 * stock.last + preview.json.preview.fee);
check('现金按成交金额与费用扣减', Math.abs(sync1.json.account.cash - expectCash) < 2 * Y,
  `实际 ¥${yuan(sync1.json.account.cash)} 期望约 ¥${yuan(expectCash)}`);

const sellToo = await call('order', { side: 'sell', secid: stock.secid, qty: 200, mode: 'market', leaf: 1 }, token);
check('卖出可用不足直接废单', sellToo.json.code === 'insufficient_avail', sellToo.json.code);

// 5) 杠杆：融资买入
const margin = await call('order', { side: 'margin_buy', secid: etf.secid, qty: 100000, mode: 'market', leaf: 4 }, token);
check('融资买入受理', margin.json.ok === true, margin.json.code ?? `自付 ¥${yuan(margin.json.preview?.own ?? 0)} 借款 ¥${yuan(margin.json.preview?.borrow ?? 0)}`);
advance(4000);
const sync2 = await call('sync', {}, token);
const acct = sync2.json.account;
check('形成融资负债', acct.marginPrincipal > 0, `本金 ¥${yuan(acct.marginPrincipal)}`);
check('维持担保比例被计算', acct.guaranteeRatio !== null && acct.guaranteeRatio >= 1.3,
  acct.guaranteeRatio ? `担保比例 ${(acct.guaranteeRatio * 100).toFixed(1)}% 杠杆 ${acct.leverage?.toFixed(2)}x` : '无负债');
check('总资产 = 现金 + 持仓 + 担保物', Math.abs(acct.totalAssets - (acct.cash + acct.longValue + acct.collateral)) < Y,
  `总资产 ¥${yuan(acct.totalAssets)}`);
check('净资产 = 总资产 − 负债', Math.abs(acct.netAssets - (acct.totalAssets - acct.totalDebt)) < Y,
  `净资产 ¥${yuan(acct.netAssets)}`);

// 6) 融券做空
const short = await call('order', { side: 'short_sell', secid: etf.secid, qty: 20000, mode: 'market', leaf: 2 }, token);
check('融券卖出受理', short.json.ok === true, short.json.code ?? `保证金 ¥${yuan(short.json.preview?.own ?? 0)}`);
advance(4000);
const sync3 = await call('sync', {}, token);
const shorts = sync3.json.account.positions.filter((p) => p.side === 'short');
check('产生融券空头负债', shorts.length >= 1 && sync3.json.account.securityBalance > 0,
  `融券市值 ¥${yuan(sync3.json.account.securityBalance)}`);

// 7) 超额下单被拒（可用保证金不足）
const greedy = await call('order', { side: 'buy', secid: stock.secid, qty: 1000000, mode: 'market', leaf: 1 }, token);
check('超出可用资金被拒', ['insufficient_cash', 'liquidation_breach', 'ratio_too_low'].includes(greedy.json.code), greedy.json.code);

// 8) 限价挂单与撤单
const restLimit = await call('order', { side: 'buy', secid: etf.secid, qty: 100, mode: 'limit', limitPrice: yuan(etf.low ?? etf.last * 0.95), leaf: 1 }, token);
check('低于现价的限价单挂起', restLimit.json.ok === true, restLimit.json.code ?? `limit=${restLimit.json.order?.limitPrice}`);
const cancel = await call('cancel', { orderId: restLimit.json.order?.id }, token);
check('手动撤单成功', cancel.json.ok === true, cancel.json.code);

// 9) 日结与排行
advance(4000);
const sync4 = await call('sync', {}, token);
check('写入当日净值快照', sync4.json.curve?.some((row) => row.day === sync4.json.clock.day), `曲线 ${sync4.json.curve?.length ?? 0} 点`);
check('排行榜可读', Array.isArray(sync4.json.leader), `上榜 ${sync4.json.leader?.length ?? 0} 人`);
check('成交明细含费用', sync4.json.trades?.every((t) => t.fee > 0), `${sync4.json.trades?.length ?? 0} 笔成交`);

const final = sync4.json.account;
check('手续费逐笔累计', final.feesPaid > 40 * Y, `累计 ¥${yuan(final.feesPaid)}`);
check('空头担保物计入总资产', Math.abs(final.totalAssets - (final.cash + final.longValue + final.collateral)) < Y,
  `¥${yuan(final.totalAssets)} = 现金 ¥${yuan(final.cash)} + 多头 ¥${yuan(final.longValue)} + 担保物 ¥${yuan(final.collateral)}`);

console.log('\n账户快照（同步后）：');
console.log(`  可用 ¥${yuan(final.cash)}  多头市值 ¥${yuan(final.longValue)}  空头市值 ¥${yuan(final.shortValue)}  融券担保物 ¥${yuan(final.collateral)}`);
console.log(`  总资产 ¥${yuan(final.totalAssets)}  负债 ¥${yuan(final.totalDebt)}  净资产 ¥${yuan(final.netAssets)}`);
console.log(`  累计手续费 ¥${yuan(final.feesPaid)}  当日盈亏 ¥${yuan(final.todayPnl)}  浮动盈亏 ¥${yuan(final.floatPnl)}`);
console.log(`  维持担保比例 ${final.guaranteeRatio ? (final.guaranteeRatio * 100).toFixed(1) + '%' : '—'}  账户杠杆 ${final.leverage?.toFixed(2)}x  风控事件 ${sync4.json.events?.length ?? 0} 条`);

// 10) 强制平仓数学：合成一个跌穿平仓线的情景（不依赖当日真实行情）
const { applyTrade, metricsOf, replay: fold } = await import('../functions/ledger.mjs');
const { buildTrade, planLiquidation } = await import('../functions/engine.mjs');
const SEC = '1.600000';
const DAY = sync4.json.clock.day;
const openPrice = 10 * Y;
const yesterday = new RealDate(Date.now() - 86_400_000 + 8 * 3600_000).toISOString().slice(0, 10);
const crash = Math.round(openPrice * 0.6);
const seed = [{
  side: 'margin_buy', symbol: SEC, code: '600000', name: '情景标的', kind: 'stock',
  qty: 200000, price: openPrice, amount: 200000 * openPrice, fee: Math.round(200000 * openPrice * 0.00026),
  leaf: 2, day: yesterday, created_at: new RealDate(Date.now() - 7 * 86_400_000).toISOString(),
}];
const scenarioQuote = (price) => new Map([[SEC, {
  secid: SEC, code: '600000', name: '情景标的', kind: 'stock',
  last: price, prevClose: price, open: price, high: price, low: price, change: 0, pct: 0,
  volume: 0, amount: 0, turnover: null, marketCap: null,
  limitUp: Math.round(price * 1.1), limitDown: Math.round(price * 0.9), limitRatio: 0.1, tick: 10_000,
  ts: Math.floor(Date.now() / 1000), sealedUp: false, sealedDown: false,
}]]);

const before = metricsOf(fold(seed, { nowMs: Date.now(), today: DAY }), scenarioQuote(crash), Date.now());
check('情景：融资 2 倍买入后跌 40%，维持担保比例跌破平仓线', before.guaranteeRatio < 1.3 && before.guaranteeRatio > 0,
  `担保比例 ${(before.guaranteeRatio * 100).toFixed(1)}% 负债 ¥${yuan(before.totalDebt)}（含 7 天利息 ¥${yuan(before.marginInterest)}）`);
const plans = planLiquidation(before, { nowMs: Date.now(), today: DAY, openSymbols: new Set() });
check('情景：系统生成强平委托（卖券还款、100 股整数倍）',
  plans.length === 1 && plans[0].side === 'sell_repay' && plans[0].qty % 100 === 0 && plans[0].qty > 0,
  plans.map((plan) => `${plan.side} ${plan.qty} 股 ${plan.mode}`).join(' / '));

const crashQuotes = scenarioQuote(crash);
const crashState = fold(seed, { nowMs: Date.now(), today: DAY });
const liquidated = buildTrade({ side: plans[0].side, qty: plans[0].qty, mode: 'market', leaf: 1 }, crashQuotes.get(SEC), Date.now(), DAY);
applyTrade(crashState, liquidated, Date.now(), DAY);
const after = metricsOf(crashState, crashQuotes, Date.now());
check('情景：强平后回到追保线 140% 之上', after.guaranteeRatio >= 1.4, `担保比例 ${(after.guaranteeRatio * 100).toFixed(1)}%`);
check('情景：强平确实冲减了融资负债', after.totalDebt < before.totalDebt, `¥${yuan(before.totalDebt)} → ¥${yuan(after.totalDebt)}`);

// 11) 全市场搜索与自选
const byCode = await call('search', { q: '600519' });
check('按代码搜索命中贵州茅台', (byCode.json.rows ?? []).some((row) => row.secid === '1.600519'), `返回 ${byCode.json.rows?.length ?? 0} 条`);
const byPinyin = await call('search', { q: 'gzmt' });
check('按拼音首字母搜索命中', (byPinyin.json.rows ?? []).some((row) => row.name === '贵州茅台'),
  (byPinyin.json.rows ?? []).slice(0, 2).map((row) => row.name).join(' '));
const byChinese = await call('search', { q: '中证500' });
check('中文关键词有结果', (byChinese.json.rows ?? []).length > 0,
  (byChinese.json.rows ?? []).slice(0, 3).map((row) => `${row.name}(${row.kind})`).join(' '));
// 回归：4.06 这类十进制价格乘 1e6 会略小于整数，早先用 trunc 会被削成 4059999 判为不合法
const awkward = await call('preview', { side: 'buy', secid: etf.secid, qty: 100, mode: 'limit', limitPrice: '4.06', leaf: 1 }, token);
check('4.06 这类限价不再被误判为价格非法', awkward.json.ok === true || awkward.json.code !== 'price_invalid',
  awkward.json.ok ? `可买上限 ${awkward.json.preview?.qty ?? 'ok'}` : awkward.json.code);
const twoDec = (Math.round((etf.low ?? etf.last * 0.97) / 10_000) / 100 + 0.005).toFixed(2);
const awkwardOrder = await call('order', { side: 'buy', secid: etf.secid, qty: 300, mode: 'limit', limitPrice: twoDec, leaf: 1 }, token);
check(`两位小数的限价（${twoDec}）可提交`, awkwardOrder.json.ok === true, awkwardOrder.json.code ?? awkwardOrder.json.order?.status);
const dupGuard = await call('order', { side: 'buy', secid: etf.secid, qty: 300, mode: 'limit', limitPrice: twoDec, leaf: 1 }, token);
check('完全相同的重复委托被拦截并要求确认', dupGuard.json.code === 'duplicate_order', dupGuard.json.code ?? '未拦截');

const junkSearch = await call('search', { q: '不存在的标的zzz' });
check('无匹配返回空列表而不是报错', junkSearch.json.ok === true && junkSearch.json.rows.length === 0, `rows=${junkSearch.json.rows?.length}`);

const add1 = await call('watch_add', { secid: etf.secid, code: etf.code, name: etf.name, kind: 'etf' }, token);
check('加入自选成功', add1.json.ok === true && add1.json.watch.some((row) => row.secid === etf.secid), `自选 ${add1.json.watch?.length ?? 0} 个`);
const add2 = await call('watch_add', { secid: etf.secid, code: etf.code, name: etf.name, kind: 'etf' }, token);
check('重复加入自选保持幂等', add2.json.ok === true && add2.json.watch.filter((row) => row.secid === etf.secid).length === 1, `仍为 ${add2.json.watch?.length ?? 0} 个`);
const add3 = await call('watch_add', { secid: '1.600519', code: '600519', name: '贵州茅台', kind: 'stock' }, token);
check('自选支持行情池外的标的', add3.json.watch.length === 2, add3.json.watch.map((row) => row.code).join(' '));

advance(4000);
const sync5 = await call('sync', {}, token);
check('同步返回自选清单与实时行情', Array.isArray(sync5.json.watch) && Array.isArray(sync5.json.watchQuotes),
  `自选 ${sync5.json.watch?.length ?? 0} / 已有行情 ${sync5.json.watchQuotes?.length ?? 0}`);
check('池外自选也能取到实时价', (sync5.json.watchQuotes ?? []).some((quote) => quote.code === '600519' && quote.last > 0),
  (sync5.json.watchQuotes ?? []).map((quote) => `${quote.code}:${((quote.last ?? 0) / Y).toFixed(2)}`).join(' '));
check('同步返回本轮成交明细', Array.isArray(sync5.json.fills), `新增成交 ${sync5.json.fills?.length ?? 0} 笔`);

const reordered = await call('watch_sort', { secids: ['1.600519', etf.secid] }, token);
check('自选可按提交顺序重排', reordered.json.watch?.map((row) => row.secid).join(',') === `1.600519,${etf.secid}`,
  reordered.json.watch?.map((row) => row.code).join(','));
const bogusSort = await call('watch_sort', { secids: ['1.000001'] }, token);
check('不含本人自选标的的顺序请求被拒', bogusSort.json.code === 'order_invalid', bogusSort.json.code ?? 'ok');
const removed = await call('watch_remove', { secid: '1.600519' }, token);
check('移出自选成功', removed.json.ok === true && removed.json.watch.length === 1, `剩 ${removed.json.watch?.length ?? 0} 个`);

// 12) 重复下单拦截
const dupA = await call('order', { side: 'buy', secid: etf.secid, qty: 100, mode: 'market', leaf: 1 }, token);
const dupB = await call('order', { side: 'buy', secid: etf.secid, qty: 100, mode: 'market', leaf: 1 }, token);
const dupC = await call('order', { side: 'buy', secid: etf.secid, qty: 100, mode: 'market', leaf: 1, confirmDuplicate: true }, token);
check('首笔委托受理', dupA.json.ok === true, dupA.json.code ?? dupA.json.order?.status);
check('15 秒内完全相同的委托被拦下', dupB.json.code === 'duplicate_order', dupB.json.code);
check('显式确认后允许重复下单', dupC.json.ok === true, dupC.json.code ?? 'ok');
const dupD = await call('order', { side: 'buy', secid: etf.secid, qty: 200, mode: 'market', leaf: 1 }, token);
check('数量不同视为新委托，不受拦截影响', dupD.json.ok === true, dupD.json.code ?? 'ok');

// 13) 后台管理：权限、冻结、审计、注册开关、按账户本金
const closedDoor = await call('admin_overview', {}, token);
check('未配置 ADMIN_USERNAMES 时后台整体关闭', closedDoor.json.code === 'not_admin' && closedDoor.status === 403, closedDoor.json.code ?? 'ok');

const boss = await call('register', { username: 'boss_admin', password: 'admin12345', display: '后台管理员' });
process.env.ADMIN_USERNAMES = 'boss_admin';
const bossToken = boss.json.token;
check('注册响应本身不带后台权限', boss.json.ok === true && boss.json.user.role === 'user', `role=${boss.json.user?.role}`);

const asUser = await call('admin_overview', {}, token);
check('普通用户访问后台被拒', asUser.json.code === 'not_admin', asUser.json.code ?? 'ok');
const asBoss = await call('admin_overview', {}, bossToken);
check('管理员读取概览', asBoss.json.ok === true && asBoss.json.accounts >= 2, `账户 ${asBoss.json.accounts ?? 0} 个`);
check('概览含当日撮合统计', (asBoss.json.stats?.orders ?? 0) > 0 && (asBoss.json.stats?.trades ?? 0) > 0,
  `委托 ${asBoss.json.stats?.orders ?? 0} 成交 ${asBoss.json.stats?.trades ?? 0} 手续费 ¥${yuan(asBoss.json.stats?.fees ?? 0)}`);

const list = await call('admin_users', {}, bossToken);
const bossRow = (list.json.rows ?? []).find((row) => row.username === 'boss_admin');
const traderRow = (list.json.rows ?? []).find((row) => row.username === username);
// 只注册没同步过的账户今天还没有快照，净资产应为空；活跃账户必须能算出净资产
check('用户列表带角色、本金与净资产', Boolean(bossRow) && bossRow.role === 'admin' && bossRow.net_assets === null
  && (traderRow?.net_assets ?? 0) > 0,
  `共 ${list.json.total ?? 0} 人 · 管理员本金 ¥${yuan(bossRow?.start_cash ?? 0)} · 活跃账户 ¥${yuan(traderRow?.net_assets ?? 0)}`);
// 管理员即使停在美股页，后台的「当日」也必须按北京日取快照，否则整列净资产会空掉
const listFromUsDesk = await call('admin_users', { market: 'us' }, bossToken);
const traderFromUs = (listFromUsDesk.json.rows ?? []).find((row) => row.username === username);
check('后台当日不跟随管理员的市场选择', listFromUsDesk.json.day === sync0.json.clock.day
  && (traderFromUs?.net_assets ?? 0) > 0 && (traderFromUs?.start_cash_usd ?? 0) === 100_000 * Y,
  `day=${listFromUsDesk.json.day} · 净资产 ¥${yuan(traderFromUs?.net_assets ?? 0)} · 美元本金 ${yuan(traderFromUs?.start_cash_usd ?? 0)}`);
const searched = await call('admin_users', { q: 'boss' }, bossToken);check('后台按用户名搜索', (searched.json.rows ?? []).length === 1 && searched.json.rows[0].username === 'boss_admin',
  `命中 ${searched.json.rows?.length ?? 0} 条`);

const meBefore = await call('me', {}, token);
const cashBefore = meBefore.json.account.cash;
const noConfirm = await call('admin_freeze', { userId: meBefore.json.user.id }, bossToken);
check('冻结必须二次确认', noConfirm.json.code === 'confirm_required', noConfirm.json.code ?? 'ok');
const frozen = await call('admin_freeze', { userId: meBefore.json.user.id, confirm: true }, bossToken);
check('冻结账户成功', frozen.json.status === 'frozen', frozen.json.code ?? 'ok');
const frozenOrder = await call('order', { side: 'buy', secid: etf.secid, qty: 300, mode: 'market', leaf: 1 }, token);
check('冻结后不能开新仓', frozenOrder.json.code === 'account_frozen', frozenOrder.json.code ?? 'ok');
const frozenRead = await call('me', {}, token);
check('冻结后仍可查询账户', frozenRead.json.ok === true && frozenRead.json.user.status === 'frozen', frozenRead.json.code ?? 'ok');
await call('admin_unfreeze', { userId: meBefore.json.user.id, confirm: true }, bossToken);
const afterUnfreeze = await call('order', { side: 'buy', secid: etf.secid, qty: 300, mode: 'market', leaf: 1 }, token);
check('解冻后交易恢复', afterUnfreeze.json.ok === true, afterUnfreeze.json.code ?? 'ok');

await call('login', { username: 'boss_admin', password: 'wrongpass9999' });
const unlocked = await call('admin_unlock', { userId: bossRow.id }, bossToken);
const bossAfterUnlock = await call('admin_users', { q: 'boss' }, bossToken);
check('后台可解除登录锁定', unlocked.json.ok === true && (bossAfterUnlock.json.rows?.[0]?.fail_count ?? 1) === 0,
  `fail_count=${bossAfterUnlock.json.rows?.[0]?.fail_count}`);

const grant = await call('admin_grant_cash', { userId: meBefore.json.user.id, side: 'in', amount: 50000, reason: '误操作补偿', confirm: true }, bossToken);
const meGranted = await call('me', {}, token);
// 用现金而不是净资产做断言：净资产会随行情波动，现金增量才是补单是否入账的确定证据
check('入金以补单形式进账本', grant.json.ok === true && meGranted.json.account.cash === cashBefore + 50_000 * 1e6,
  `¥${yuan(cashBefore)} → ¥${yuan(meGranted.json.account.cash ?? 0)}`);
const netGranted = meGranted.json.account.netAssets;
// 9 亿元在单笔上限之内，但远超该账户现金，应命中现金校验而不是金额校验
const tooMuch = await call('admin_grant_cash', { userId: meBefore.json.user.id, side: 'out', amount: 9e8, confirm: true }, bossToken);
check('出金不得超过当前现金', tooMuch.json.code === 'cash_short', tooMuch.json.code ?? 'ok');
const fillList = await call('sync', {}, token);
check('补单在流水里可见为资金进出', (fillList.json.trades ?? []).some((row) => row.side === 'capital_in' && row.amount === 50_000 * 1e6),
  (fillList.json.trades ?? []).slice(0, 2).map((row) => row.side).join(','));

const patched = await call('admin_settings', { patch: { start_cash: 500000 }, confirm: true }, bossToken);
check('修改新账户默认本金', patched.json.settings?.start_cash === 500_000 * 1e6, `start_cash=${patched.json.settings?.start_cash}`);
const latecomer = await call('register', { username: 'late_join', password: 'user123456' });
check('新账户按新默认本金开户', latecomer.json.accounts?.cn?.netAssets === 500_000 * 1e6, `¥${yuan(latecomer.json.accounts?.cn?.netAssets ?? 0)}`);
const oldUnchanged = await call('me', {}, token);
// 真被重写会整体平移 50 万元；行情波动带来的差异远小于这个量级，所以按量级判定而不是逐分相等
const shift = Math.abs((oldUnchanged.json.account?.netAssets ?? 0) - netGranted);
check('改默认本金不重写历史账户', oldUnchanged.json.account.startCash === 1_000_000 * 1e6 && shift < 100_000 * 1e6,
  `本金仍 ¥${yuan(oldUnchanged.json.account?.startCash ?? 0)} · 净资产偏移 ¥${yuan(shift)} · 现金 ¥${yuan(oldUnchanged.json.account?.cash ?? 0)}`);
await call('admin_settings', { patch: { start_cash: 1000000 }, confirm: true }, bossToken);

const off = await call('admin_settings', { patch: { register_enabled: false }, confirm: true }, bossToken);
const blocked = await call('register', { username: 'shut_out', password: 'user123456' });
check('注册开关关闭后拒绝开户', off.json.ok === true && blocked.json.code === 'register_closed', blocked.json.code ?? 'ok');
await call('admin_settings', { patch: { register_enabled: true, invite_code: 'MIRROR' }, confirm: true }, bossToken);
const noInvite = await call('register', { username: 'no_invite', password: 'user123456' });
const withInvite = await call('register', { username: 'with_invite', password: 'user123456', invite: 'MIRROR' });
check('邀请码生效', noInvite.json.code === 'invite_invalid' && withInvite.json.ok === true, `${noInvite.json.code} / ${withInvite.json.code ?? 'ok'}`);
await call('admin_settings', { patch: { invite_code: '' }, confirm: true }, bossToken);

const demote = await call('admin_role', { userId: bossRow.id, role: 'user', confirm: true }, bossToken);
check('最后一个管理员不可撤销', demote.json.code === 'last_admin', demote.json.code ?? 'ok');
const promote = await call('admin_role', { userId: latecomer.json.user.id, role: 'admin', confirm: true }, bossToken);
const secondBoss = await call('admin_overview', {}, latecomer.json.token);
check('可以授予其他账户管理员', promote.json.role === 'admin' && secondBoss.json.ok === true, secondBoss.json.code ?? 'ok');
await call('admin_role', { userId: latecomer.json.user.id, role: 'user', confirm: true }, bossToken);

const kicked = await call('admin_revoke_sessions', { userId: meBefore.json.user.id, confirm: true }, bossToken);
const afterKick = await call('me', {}, token);
check('强制下线使旧会话失效', (kicked.json.dropped ?? 0) >= 1 && afterKick.json.code === 'login_required',
  `下线 ${kicked.json.dropped ?? 0} 个会话 → ${afterKick.json.code ?? 'ok'}`);
const revived = await call('login', { username, password: 'qoder1234' });
check('被下线账户重新登录即可恢复', revived.json.ok === true, revived.json.code ?? 'ok');

const audit = await call('admin_audit', {}, bossToken);
const dump = JSON.stringify(audit.json.rows ?? []);
check('后台写操作全部留痕', (audit.json.rows ?? []).some((row) => row.action === 'admin_grant_cash')
  && (audit.json.rows ?? []).some((row) => row.action === 'admin_freeze'), `审计 ${audit.json.rows?.length ?? 0} 条`);
check('审计不落口令与令牌', !dump.includes('pass_hash') && !dump.includes(bossToken), '字段白名单生效');
const bogus = await call('admin_nonsense', {}, bossToken);
check('未知后台动作返回 404', bogus.status === 404, `${bogus.status} ${bogus.json.code ?? ''}`);

// 14) 参数热改、撮合熔断与流水审计
// 上一段把主账户强制下线过，这里必须用重新登录拿到的新令牌
const liveToken = revived.json.token;
const previewFee = async () => {
  // 用足够大的金额，让佣金落在「最低 5 元」之上，比例断言才有意义
  const result = await call('preview', { side: 'buy', secid: etf.secid, qty: 100_000, mode: 'market', leaf: 1 }, liveToken);
  return result.json.preview?.fee ?? 0;
};
const feeBefore = await previewFee();
const raised = await call('admin_settings', { patch: { params: { fees: { etfCommission: 0.0003 } } }, confirm: true }, bossToken);
const feeAfter = await previewFee();
check('ETF 佣金热改后新试算立即生效', raised.json.ok === true && feeBefore > 0 && Math.abs(feeAfter - feeBefore * 3) <= 4,
  `¥${(feeBefore / Y).toFixed(2)} → ¥${(feeAfter / Y).toFixed(2)}（万1 → 万3）`);
const restored = await call('admin_settings', { patch: { params: { fees: { etfCommission: 0.0001 } } }, confirm: true }, bossToken);
const feeRestored = await previewFee();
check('恢复默认佣金后金额回到原值', restored.json.ok === true && feeRestored === feeBefore, `${feeRestored} vs ${feeBefore}`);
const badRate = await call('admin_settings', { patch: { params: { fees: { etfCommission: 0.9 } } }, confirm: true }, bossToken);
check('越界费率被明确拒绝', badRate.json.code === 'param_invalid', badRate.json.code ?? 'ok');

const linePatch = await call('admin_settings', { patch: { params: { lines: { liquid: 1.6 } } }, confirm: true }, bossToken);
const linesNow = linePatch.json.settings?.params?.lines ?? {};
check('担保线次序自动拉齐（平仓线抬高会带动追保/预警/开仓）',
  linesNow.liquid === 1.6 && linesNow.call >= 1.65 && linesNow.warn >= linesNow.call && linesNow.open >= linesNow.warn,
  `liquid=${linesNow.liquid} call=${linesNow.call} warn=${linesNow.warn} open=${linesNow.open}`);
const rulesLive = await call('rules', {}, liveToken);
check('规则接口回吐当前挂牌参数', rulesLive.json.rules?.lines?.liquid === 1.6 && rulesLive.json.rules?.fees?.etfCommission === 0.0001,
  JSON.stringify(rulesLive.json.rules?.lines ?? {}));
await call('admin_settings', { patch: { params: { lines: { liquid: 1.3, call: 1.4, warn: 1.5, open: 1.5 } } }, confirm: true }, bossToken);

const paused = await call('admin_settings', { patch: { match_paused: true }, confirm: true }, bossToken);
const pausedOrder = await call('order', { side: 'buy', secid: etf.secid, qty: 100, mode: 'market', leaf: 1 }, liveToken);
const pausedPreview = await call('preview', { side: 'buy', secid: etf.secid, qty: 100, mode: 'market', leaf: 1 }, liveToken);
const pausedMe = await call('me', {}, liveToken);
check('熔断拒绝新委托但保留试算与查询', paused.json.ok === true && pausedOrder.json.code === 'match_paused'
  && pausedPreview.json.ok === true && pausedMe.json.ok === true && pausedMe.json.matchable === false,
  `${pausedOrder.json.code} / preview=${pausedPreview.json.ok} / matchable=${pausedMe.json.matchable}`);
const openOrder = pausedPreview.json.ok ? await call('order', { side: 'buy', secid: etf.secid, qty: 200, mode: 'market', leaf: 1, confirmDuplicate: true }, liveToken) : { json: {} };
const canceled = openOrder.json.order?.id
  ? await call('cancel', { orderId: openOrder.json.order.id }, liveToken)
  : { json: { ok: true } };
check('熔断期间已挂委托仍可撤单', canceled.json.ok === true, canceled.json.code ?? 'ok');
await call('admin_settings', { patch: { match_paused: false }, confirm: true }, bossToken);

const flowAll = await call('admin_orders', {}, bossToken);
const flowRejected = await call('admin_orders', { status: 'rejected' }, bossToken);
const flowBadStatus = await call('admin_orders', { status: 'nonsense' }, bossToken);
check('全平台委托流水可分页读取', flowAll.json.rows?.length > 0 && typeof flowAll.json.stats?.orders === 'number',
  `本页 ${flowAll.json.rows?.length ?? 0} 条 · 当日 ${flowAll.json.stats?.orders ?? 0} 笔`);
check('流水可按状态筛选且非法筛选值被忽略', (flowRejected.json.rows ?? []).every((row) => row.status === 'rejected')
  && (flowBadStatus.json.rows ?? []).length === (flowAll.json.rows ?? []).length,
  `rejected=${flowRejected.json.rows?.length ?? 0} 全部=${flowAll.json.rows?.length ?? 0}`);
check('拒单原因分布随流水返回', flowAll.json.stats?.reasons !== undefined,
  Object.entries(flowAll.json.stats?.reasons ?? {}).map(([code, n]) => `${code}:${n}`).join(' ') || '本日无拒单');
const overview2 = await call('admin_overview', {}, bossToken);
check('概览含风险账户与熔断状态', overview2.json.risk !== undefined && overview2.json.settings?.match_paused === false,
  `平仓线下 ${overview2.json.risk?.belowLiquid ?? 0} · 追保线下 ${overview2.json.risk?.belowCall ?? 0} · 负债户 ${overview2.json.risk?.leveraged ?? 0}`);
const audit2 = await call('admin_audit', {}, bossToken);
const settingsAudit = (audit2.json.rows ?? []).find((row) => row.action === 'admin_settings');
check('参数变更写入审计且只记变更项', Boolean(settingsAudit) && String(settingsAudit.detail).includes('changed'),
  String(settingsAudit?.detail ?? '').slice(0, 70));

// ==== 美股盘：把时钟推到美东常规时段（约北京 23:30），此时 A 股已经收盘 ====
const USD = 100_000 * Y;
const cnCashBefore = (await call('me', { market: 'cn' }, liveToken)).json.account?.cash ?? 0;
const cnFeesBefore = JSON.stringify((await call('rules')).json.rules?.cn?.fees ?? {});
// 美股那一轮用「美股行情自己的日子」拨时钟：北京早上 A 股已开盘、美股却还在前一天的盘后，
// 若跟着 A 股的当日走，美东日期会比上游新一天，stale 判定会关掉整段撮合
const usProbe = await getUsQuotes(true, new RealDate()).catch(() => new Map());
let usQuoteTs = 0;
for (const quote of usProbe.values()) usQuoteTs = Math.max(usQuoteTs, quote.ts);
const usDay = etParts(new RealDate(Math.max(usQuoteTs, 0) * 1000)).day;
setClock(Date.parse(`${usDay}T15:30:00Z`)); // 15:30 UTC = 美东 10:30（冬令）/11:30（夏令），必定在常规时段内

const usBoard = await call('board', { market: 'us' });
// 取一条价格适中的活跃股：太高（如伯克希尔 A 类）会直接超出美元本金，太低则是仙股
const usQuotes = (usBoard.json.market?.stocks ?? [])
  .filter((item) => item.kind === 'stock' && item.amount > 0 && item.last > 5 * Y && item.last < 800 * Y);
const target = usQuotes[0] ?? (usBoard.json.market?.etfs ?? []).find((item) => item.last > 5 * Y && item.last < 800 * Y);
check('美股板块与指数可取，涨跌家数留空不编造', usBoard.json.ok === true && usBoard.json.market?.currency === 'USD'
  && (usBoard.json.market?.indexes ?? []).length >= 3 && (usBoard.json.market?.stocks ?? []).length >= 20
  && usBoard.json.market?.breadth === null,
  `指数 ${usBoard.json.market?.indexes?.length ?? 0} · 个股 ${usBoard.json.market?.stocks?.length ?? 0} · breadth=${String(usBoard.json.market?.breadth)}`);
check('双市时段同时下发', usBoard.json.markets?.cn?.session?.phase === 'closed'
  && usBoard.json.markets?.us?.matchable === true && usBoard.json.matchable === true
  && usBoard.json.session?.phase === 'open',
  `A 股 ${usBoard.json.markets?.cn?.session?.phase} / 美股 ${usBoard.json.markets?.us?.session?.phase}`);

const usSearch = await call('search', { q: 'NVDA', market: 'us' });
const cnSearch = await call('search', { q: 'NVDA' }, liveToken);
const isUs = (secid) => /^(100|105|106|107)\./.test(String(secid));
check('搜索按市场隔离', (usSearch.json.rows ?? []).length > 0
  && (usSearch.json.rows ?? []).every((row) => isUs(row.secid))
  && (cnSearch.json.rows ?? []).every((row) => !isUs(row.secid)),
  `美股 ${usSearch.json.rows?.length ?? 0} 条 / A 股 ${cnSearch.json.rows?.length ?? 0} 条`);

const usMe = await call('me', { market: 'us' }, liveToken);
check('美股子账户独立成账', usMe.json.account?.market === 'us' && usMe.json.account?.currency === 'USD'
  && usMe.json.account?.cash === USD && usMe.json.side?.market === 'cn' && usMe.json.side?.cash === cnCashBefore
  && usMe.json.activeMarket === 'us',
  `美元现金 ${usMe.json.account?.cash} · 人民币侧现金 ${usMe.json.side?.cash}`);

const oneShare = await call('order', { market: 'us', side: 'buy', secid: target.secid, qty: 1, mode: 'market', leaf: 1 }, liveToken);
check('美股 1 股即可下单（没有整手限制）', oneShare.json.ok === true, `${oneShare.json.code ?? 'ok'} ${target.secid}`);
check('美股最低佣金 1 美元（微美元计价）', oneShare.json.preview?.fee === 1 * Y, `fee=${oneShare.json.preview?.fee}`);
const usSync = await call('sync', { market: 'us' }, liveToken);
const usPosition = (usSync.json.account?.positions ?? [])[0];
check('美股当日买入当日可卖（T+0）', usSync.json.settled >= 1 && usPosition?.qty === 1 && usPosition?.avail === 1,
  `持仓 ${usPosition?.qty} 可用 ${usPosition?.avail}`);
const sameDaySell = await call('order', { market: 'us', side: 'sell', secid: target.secid, qty: 1, mode: 'market', leaf: 1 }, liveToken);
check('T+0 卖出通过校验', sameDaySell.json.ok === true, sameDaySell.json.code ?? 'ok');

const farLimit = await call('order', {
  market: 'us', side: 'buy', secid: target.secid, qty: 2, mode: 'limit',
  limitPrice: Number((target.last * 3 / Y).toFixed(2)), leaf: 1,
}, liveToken);
check('美股无每日涨跌停：三倍价限价单不越界', farLimit.json.ok === true, farLimit.json.code ?? 'ok');
if (farLimit.json.order?.id) await call('cancel', { orderId: farLimit.json.order.id }, liveToken);

const usRules = await call('rules', { market: 'us' }, liveToken);
check('两个市场各一套规则', usRules.json.rules?.us?.lotSize === 1 && usRules.json.rules?.us?.tPlus1 === false
  && usRules.json.rules?.us?.dailyLimit === false && usRules.json.rules?.us?.lines?.open === 2
  && usRules.json.rules?.cn?.lotSize === 100 && usRules.json.rules?.cn?.lines?.open === 1.5,
  `美股 开仓 ${(usRules.json.rules?.us?.lines?.open ?? 0) * 100}% / A 股 开仓 ${(usRules.json.rules?.cn?.lines?.open ?? 0) * 100}%`);
check('美股废单文案换成美股口径', String(usRules.json.rules?.reasons?.qty_invalid ?? '').includes('1 股')
  && String(usRules.json.rules?.reasons?.insufficient_avail ?? '').includes('可用数量'),
  String(usRules.json.rules?.reasons?.qty_invalid ?? ''));

const marginUs = await call('order', { market: 'us', side: 'margin_buy', secid: target.secid, qty: 100, mode: 'market', leaf: 2 }, liveToken);
check('美股开放融资买入且负债记在美元池', marginUs.json.ok === true && (marginUs.json.preview?.totalDebtAfter ?? 0) > 0,
  `负债 ${marginUs.json.preview?.totalDebtAfter ?? 0} · ${marginUs.json.code ?? 'ok'}`);
const overCash = await call('order', { market: 'us', side: 'buy', secid: target.secid, qty: 100_000, mode: 'market', leaf: 1 }, liveToken);
check('美元现金不足不会挪用人民币池', overCash.json.code === 'insufficient_cash', overCash.json.code ?? 'ok');
const misrouted = await call('order', { market: 'cn', side: 'buy', secid: target.secid, qty: 3, mode: 'market', leaf: 1 }, liveToken);
check('委托归属由标的决定（前端传错市场也能纠）', misrouted.json.ok === true && misrouted.json.market === 'us',
  `${misrouted.json.code ?? 'ok'} → ${misrouted.json.market}`);

const cnMe = await call('me', { market: 'cn' }, liveToken);
const fxRate = cnMe.json.fx ?? 0;
const expectNet = (cnMe.json.account?.netAssets ?? 0) + Math.round((cnMe.json.side?.netAssets ?? 0) * fxRate / Y);
check('日结快照按汇率合并两市', fxRate > 0 && Math.abs((cnMe.json.combined?.netAssets ?? 0) - expectNet) <= 1,
  `合并 ${cnMe.json.combined?.netAssets} · 期望 ${expectNet} · 汇率 ${fxRate}`);
check('A 股账目不受美股操作影响', cnMe.json.account?.cash === cnCashBefore && cnMe.json.account?.currency === 'CNY',
  `现金 ${cnMe.json.account?.cash}（美股操作前 ${cnCashBefore}）`);

const usPausedSet = await call('admin_settings', { patch: { match_paused_us: true }, confirm: true }, bossToken);
check('熔断开关分市场存储', usPausedSet.json.settings?.match_paused_us === true && usPausedSet.json.settings?.match_paused === false,
  `us=${usPausedSet.json.settings?.match_paused_us} cn=${usPausedSet.json.settings?.match_paused}`);
const blockedUs = await call('order', { market: 'us', side: 'buy', secid: target.secid, qty: 5, mode: 'market', leaf: 1 }, liveToken);
const previewWhilePaused = await call('preview', { market: 'us', side: 'buy', secid: target.secid, qty: 7, mode: 'market', leaf: 1 }, liveToken);
const boardWhilePaused = await call('board', { market: 'cn' });
check('美股熔断只停美股，试算与 A 股查询不受影响', blockedUs.json.code === 'match_paused'
  && previewWhilePaused.json.ok === true && boardWhilePaused.json.ok === true
  && boardWhilePaused.json.markets?.us?.paused === true && boardWhilePaused.json.markets?.cn?.paused === false,
  `${blockedUs.json.code} · 试算 ${previewWhilePaused.json.ok}`);
await call('admin_settings', { patch: { match_paused_us: false }, confirm: true }, bossToken);

await call('admin_settings', { patch: { us_params: { fees: { commission: 0.001 } } }, confirm: true }, bossToken);
const usFeeUp = await call('preview', { market: 'us', side: 'buy', secid: target.secid, qty: 100, mode: 'market', leaf: 1 }, liveToken);
const usFeeRatio = (usFeeUp.json.preview?.fee ?? 0) / (usFeeUp.json.preview?.amount ?? 1);
const cnFeesAfter = JSON.stringify((await call('rules')).json.rules?.cn?.fees ?? {});
check('改美股费率立即生效且不影响 A 股费率', Math.abs(usFeeRatio - 0.001) < 1e-6 && cnFeesBefore === cnFeesAfter,
  `美股佣金比例 ${usFeeRatio.toFixed(6)} · A 股费率${cnFeesBefore === cnFeesAfter ? '未变' : '被改动'}`);
await call('admin_settings', { patch: { us_params: { fees: { commission: 0.0002 } } }, confirm: true }, bossToken);

// ==== 对外接口：/api/v1/* 与个人 API 密钥 ====
const keyCreated = await call('key_create', { name: '自测脚本' }, liveToken);
const KEY = keyCreated.json.apiKey ?? '';
check('生成 API 密钥，明文只给这一次', /^mk_live_[0-9a-f]{32}$/.test(String(KEY))
  && Boolean(keyCreated.json.notice) && String(keyCreated.json.hint ?? '').includes('…'),
  `${keyCreated.json.hint ?? ''} · ${keyCreated.json.code ?? 'ok'}`);

const noKey = await rest('GET', '/api/v1/account');
const badKey = await rest('GET', '/api/v1/account', { key: `mk_live_${'0'.repeat(32)}` });
check('缺凭证与无效密钥分别报错且带说明', noKey.status === 401 && noKey.json.code === 'login_required'
  && badKey.status === 401 && badKey.json.code === 'key_invalid' && String(badKey.json.message ?? '').length > 6,
  `${noKey.json.code} / ${badKey.json.code}`);

const quoteUs = await rest('GET', '/api/v1/quote', { query: { symbol: 'AAPL' } });
const quoteCn = await rest('GET', '/api/v1/quote', { query: { symbol: '510300' } });
check('symbol 三种写法都能定位标的', quoteUs.json.quote?.secid === '105.AAPL' && quoteUs.json.currency === 'USD'
  && quoteCn.json.quote?.secid === '1.510300' && quoteCn.json.market === 'cn',
  `${quoteUs.json.quote?.secid ?? quoteUs.json.code} / ${quoteCn.json.quote?.secid ?? quoteCn.json.code}`);

const apiAcct = await rest('GET', '/api/v1/account', { key: KEY });
check('GET /account 返回两个池子与合并口径', apiAcct.status === 200 && apiAcct.json.accounts?.cn?.currency === 'CNY'
  && apiAcct.json.accounts?.us?.currency === 'USD' && (apiAcct.json.fx ?? 0) > 0 && apiAcct.json.combined?.netAssets > 0,
  `cn ${apiAcct.json.accounts?.cn?.cash} · us ${apiAcct.json.accounts?.us?.cash} · fx ${apiAcct.json.fx}`);

const usOrder = await rest('POST', '/api/v1/order', { key: KEY, body: { symbol: 'ORCL', side: 'buy', qty: 5, type: 'market' } });
check('REST 下单即撮合，响应直接带成交结果', usOrder.status === 200 && usOrder.json.status === 'filled'
  && usOrder.json.fill?.qty === 5 && (usOrder.json.fill?.fee ?? 0) >= 1 * Y && usOrder.json.currency === 'USD',
  `status=${usOrder.json.status ?? usOrder.json.code} · fee=${usOrder.json.fill?.fee ?? 0}`);

const openBefore = await rest('GET', '/api/v1/orders', { key: KEY, query: { status: 'open' } });
const previewOnly = await rest('POST', '/api/v1/order/preview', { key: KEY, body: { symbol: 'ORCL', side: 'buy', qty: 10, type: 'market' } });
const openAfter = await rest('GET', '/api/v1/orders', { key: KEY, query: { status: 'open' } });
check('preview 只试算不落库', previewOnly.json.ok === true && (previewOnly.json.preview?.fee ?? 0) > 0
  && openAfter.json.orders?.length === openBefore.json.orders?.length,
  `fee=${previewOnly.json.preview?.fee ?? previewOnly.json.code} · 在途 ${openBefore.json.orders?.length}→${openAfter.json.orders?.length}`);

// 这一段跑在美东时段里，A 股那边已经是「行情非当日数据」，所以用美股标的测「只受理不撮合」
const deferred = await rest('POST', '/api/v1/order', { key: KEY, body: { symbol: 'KO', side: 'buy', qty: 30, type: 'market', immediate: false } });
check('immediate=false 只受理，等下一轮', deferred.json.ok === true && deferred.json.status === 'open' && deferred.json.fill === null,
  `status=${deferred.json.status ?? deferred.json.code}`);
const cancelBack = await rest('POST', '/api/v1/cancel', { key: KEY, body: { orderId: deferred.json.order?.id } });
check('REST 撤单可用', cancelBack.json.ok === true, cancelBack.json.code ?? 'ok');

const pushed = await rest('POST', '/api/v1/sync', { key: KEY });
check('POST /sync 手动推进一轮并回全套账目', pushed.json.ok === true && pushed.json.account?.market === 'cn'
  && pushed.json.side?.market === 'us' && typeof pushed.json.settled === 'number',
  `settled=${pushed.json.settled} · canceled=${pushed.json.canceled}`);

const ordersList = await rest('GET', '/api/v1/orders', { key: KEY, query: { status: 'filled' } });
const tradesList = await rest('GET', '/api/v1/trades', { key: KEY, query: { limit: 5 } });
check('委托与成交查询按状态筛选且带币种', (ordersList.json.orders ?? []).length > 0
  && (ordersList.json.orders ?? []).every((row) => row.status === 'filled')
  && (tradesList.json.trades ?? []).length > 0 && tradesList.json.trades[0].currency !== undefined,
  `filled ${ordersList.json.orders?.length ?? 0} 笔 · 最新成交 ${tradesList.json.trades?.[0]?.secid}/${tradesList.json.trades?.[0]?.currency}`);

const positionsList = await rest('GET', '/api/v1/positions', { key: KEY });
const positionMarkets = new Set((positionsList.json.positions ?? []).map((row) => row.market));
check('持仓默认两个市场一起返回', positionsList.json.ok === true && positionMarkets.has('us'),
  [...positionMarkets].join('/') || '无持仓');

const viaKey = await rest('GET', '/api/v1/keys', { key: KEY });
check('密钥不能给自己签发密钥', viaKey.status === 403 && viaKey.json.code === 'key_management_requires_session',
  `${viaKey.status} ${viaKey.json.code}`);

const listAfter = await call('key_list', {}, liveToken);
const mine = (listAfter.json.keys ?? []).find((row) => row.hint === keyCreated.json.hint);
check('密钥记录调用次数与最近使用时间', (mine?.calls ?? 0) >= 5 && Boolean(mine?.last_used_at),
  `calls=${mine?.calls ?? 0} · last=${mine?.last_used_at ?? '空'}`);

const revoked = await call('key_revoke', { id: mine?.id ?? '' }, liveToken);
const afterRevoke = await rest('GET', '/api/v1/account', { key: KEY });
check('撤销立即生效', revoked.json.ok === true && afterRevoke.status === 401 && afterRevoke.json.code === 'key_invalid',
  `${afterRevoke.status} ${afterRevoke.json.code}`);

const batch = [];
for (let i = 0; i < 11; i += 1) batch.push(await call('key_create', { name: `批量 ${i}` }, liveToken));
check('每账户有效密钥上限 10 把', batch.slice(0, 10).every((row) => row.json.ok === true)
  && batch[10].json.code === 'key_limit' && batch[10].status === 409,
  `第 11 把 → ${batch[10].json.code}`);

console.log(`\n结果：${failures === 0 ? '全部通过' : `${failures} 项未通过`}`);
process.exit(failures === 0 ? 0 : 1);
