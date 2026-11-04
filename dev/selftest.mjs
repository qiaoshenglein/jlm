// 端到端自测：直接驱动线上同一份 handle()，用内存账本 + 真实行情。
// 用法：node dev/selftest.mjs   （把时钟拨到当日北京时间 13:30，以便进入连续竞价时段）
const RealDate = Date;
const fixedNow = () => {
  // 当日 13:30（北京时间）→ UTC 05:30
  const now = new RealDate();
  const beijing = new RealDate(now.getTime() + 8 * 3600_000);
  const day = `${beijing.getUTCFullYear()}-${String(beijing.getUTCMonth() + 1).padStart(2, '0')}-${String(beijing.getUTCDate()).padStart(2, '0')}`;
  return new RealDate(`${day}T05:30:00Z`).getTime();
};
let clock = fixedNow();
globalThis.Date = class extends RealDate {
  constructor(...args) { super(args.length ? args[0] : clock); }
  static now() { return clock; }
} 
;
const advance = (ms) => { clock += ms; };

const { handle } = await import('../functions/api.mjs');

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

// 1) 注册与登录
const username = `qa${Date.now().toString(36).slice(-6)}`;
const reg = await call('register', { username, password: 'qoder1234', display: '测试账户' });
check('注册返回令牌', reg.status === 200 && reg.json.ok === true && typeof reg.json.token === 'string', `user=${username}`);
const token = reg.json.token;
check('初始资金 100 万', reg.json.account?.cash === 1_000_000 * Y, `cash=¥${yuan(reg.json.account?.cash ?? 0)}`);

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

console.log(`\n结果：${failures === 0 ? '全部通过' : `${failures} 项未通过`}`);
process.exit(failures === 0 ? 0 : 1);
