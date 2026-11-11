// 行情源适配器实测：逐家打真实接口，核对归一化后的字段是否合理，并横向对照同一标的的价格。
// 字段索引错位会被「同一家标的三家价格一致」这条抓出来，所以这一步不能省。
// 用法：node dev/source-probe.mjs   （需要能出网；上游拒连时退出码 2）
import { QUOTE_PROVIDERS, PROVIDER_ORDER_DEFAULT } from '../functions/quote-sources.mjs';
import { MICRO, bjParts, etParts } from '../functions/rules.mjs';

const results = [];
let failed = 0;
const ok = (name, pass, detail = '') => {
  if (!pass) failed += 1;
  results.push(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const cfg = {
  timeoutMs: 6_000,
  listHost: 'push2.eastmoney.com', singleHost: 'push2.eastmoney.com',
  histHost: 'push2his.eastmoney.com', searchHost: 'searchapi.eastmoney.com',
  txQuoteHost: 'qt.gtimg.cn', txListHost: 'proxy.finance.qq.com', txHistHost: 'ifzq.gtimg.cn', txKlineHost: 'web.ifzq.gtimg.cn',
  sinaQuoteHost: 'hq.sinajs.cn', sinaListHost: 'vip.stock.finance.sina.com.cn', sinaHistHost: 'quotes.sina.cn',
  cnPoolSize: 60, usPoolSize: 60, indexPoolSize: 12,
  cnIndexes: [['1.000001', '上证指数'], ['0.399001', '深证成指'], ['0.399006', '创业板指'], ['1.000300', '沪深300']],
  usIndexes: [['100.DJIA', '道琼斯'], ['100.SPX', '标普500'], ['100.NDX', '纳斯达克'], ['100.NDX100', '纳斯达克100']],
  etfs: ['1.510300', '0.159915'],
};

const now = new Date();
const cnDay = bjParts(now).day;
const usDay = etParts(now).day;
const demand = ['105.AAPL', '106.MSFT', '105.TSLA'];

const alive = await QUOTE_PROVIDERS.eastmoney.cnStocks(cfg, 5).catch(() => null);
const txAlive = await QUOTE_PROVIDERS.tencent.cnStocks(cfg, 5).catch(() => null);
if (!alive && !txAlive) {
  console.log('FAIL 上游不可用 — 东财与腾讯的 A 股榜都取不到，逐项断言无法进行');
  console.log('稍后重试，或用后台「行情源」页逐项探测定位（本探针需要真实出网）。');
  process.exit(2);
}

const perProvider = {};
async function tryProvider(key, label, fn) {
  try {
    const value = await fn();
    return { value };
  } catch (error) {
    ok(`${label} ${key}`, false, String(error?.message ?? error).slice(0, 70));
    return { value: null };
  }
}

for (const key of PROVIDER_ORDER_DEFAULT) {
  const p = QUOTE_PROVIDERS[key];
  const box = {};
  perProvider[key] = box;
  if (!p.caps.cnStocks) continue;

  const stocks = await tryProvider(key, 'A股榜', () => p.cnStocks(cfg, 60));
  box.stocks = stocks.value ?? [];
  ok(`${p.label}：A 股个股池建得起来`, box.stocks.length >= 10, `${box.stocks.length} 条`);

  const sample = box.stocks.find((row) => row.secid === '1.600519') ?? box.stocks[0];
  if (sample) {
    const priceYuan = sample.last / MICRO;
    ok(`${p.label}：样本价格量级合理（0.1–5000 元）`, priceYuan > 0.1 && priceYuan < 5000,
      `${sample.name} ${sample.secid} ${priceYuan.toFixed(2)} · 昨收 ${(sample.prevClose / MICRO).toFixed(2)}`);
    ok(`${p.label}：成交额按元（1e6–1e12）`, sample.amount > 1e6 && sample.amount < 1e13, String(sample.amount));
    ok(`${p.label}：时间戳落在北京当日或最近一日`, Boolean(sample.ts), `${sample.ts} · 北京日 ${cnDay}`);
    const tsDay = bjParts(new Date(sample.ts * 1000)).day;
    ok(`${p.label}：时间戳换算成北京日不穿越`, tsDay <= cnDay, `${tsDay} vs ${cnDay}`);
    if (sample.marketCap) ok(`${p.label}：市值按元（1e8–1e14）`, sample.marketCap > 1e8 && sample.marketCap < 1e14, String(sample.marketCap));
    if (sample.limitUp !== null) {
      const ratio = (sample.limitUp - sample.prevClose) / sample.prevClose;
      ok(`${p.label}：涨停比例在 5%–30% 之间`, ratio > 0.04 && ratio < 0.32, `${(ratio * 100).toFixed(1)}%`);
    }
  }

  const indexes = await tryProvider(key, '指数', () => p.cnIndexes(cfg));
  box.indexes = indexes.value ?? [];
  ok(`${p.label}：主要指数拿到 ≥3 条`, box.indexes.length >= 3, box.indexes.map((r) => `${r.name}${(r.last / MICRO).toFixed(0)}`).join(' '));
  const sh = box.indexes.find((row) => row.secid === '1.000001');
  if (sh) ok(`${p.label}：上证指数点位 1000–10000`, sh.last / MICRO > 1000 && sh.last / MICRO < 10000, String(sh.last / MICRO));

  const etfs = await tryProvider(key, 'ETF', () => p.cnEtfs(cfg, cfg.etfs));
  box.etfs = etfs.value ?? [];
  ok(`${p.label}：指数 ETF 补价可用`, box.etfs.length >= 1, box.etfs.map((r) => `${r.secid} ${(r.last / MICRO).toFixed(3)}`).join(' '));

  const one = await tryProvider(key, '单标', () => p.one(cfg, '1.600519'));
  box.one = one.value;
  ok(`${p.label}：单标的贵州茅台与榜单一致`, Boolean(box.one) && box.one.last > 100 * MICRO && box.one.last < 5000 * MICRO,
    box.one ? `${box.one.name} ${(box.one.last / MICRO).toFixed(2)} · kind=${box.one.kind}` : '无');

  const kline = await tryProvider(key, '日K', () => p.kline(cfg, '1.600519', 5));
  box.kline = kline.value ?? [];
  ok(`${p.label}：日 K 5 条且开高低收次序正确`, box.kline.length >= 4
    && box.kline.every((row) => row.high >= row.low && row.close > 0 && row.high >= row.close - 1 && row.low <= row.close + 1),
    box.kline.length ? `${box.kline.length} 条 · 末条 ${JSON.stringify(box.kline.at(-1))}` : '空');

  const trends = p.caps.trends ? await tryProvider(key, '分时', () => p.trends(cfg, '1.600519')) : { value: null };
  box.trends = trends.value;
  if (p.caps.trends) {
    ok(`${p.label}：分时点数 > 0 且价格在合理区间`, (box.trends?.points?.length ?? 0) > 0
      && box.trends.points.every((point) => point.price > 100 * MICRO && point.price < 5000 * MICRO),
      `${box.trends?.points?.length ?? 0} 点 · 首点 ${(box.trends?.points?.[0]?.price ?? 0) / MICRO}`);
  }

  const fx = p.caps.fx ? await tryProvider(key, '汇率', () => p.fx(cfg)) : { value: null };
  box.fx = fx.value;
  if (p.caps.fx) ok(`${p.label}：汇率在 6.0–7.6`, box.fx?.rate > 6 * MICRO && box.fx?.rate < 7.6 * MICRO,
    box.fx ? `${(box.fx.rate / MICRO).toFixed(4)} · ${box.fx.label}` : '无');

  if (p.caps.usStocks) {
    const us = await tryProvider(key, '美股', () => p.usStocks(cfg, 40, demand));
    box.us = us.value ?? [];
    const aapl = box.us.find((row) => row.secid === '105.AAPL');
    ok(`${p.label}：美股池建得起来`, box.us.length >= 5, `${box.us.length} 条`);
    // 纽交所代码必须还原成 106.*，否则持仓按 secid 取价会取不到
    const brk = box.us.find((row) => String(row.code).startsWith('BRK'));
    if (brk) ok(`${p.label}：BRK.B 保留纽交所 106 前缀`, brk.secid === '106.BRK.B', `${brk.secid} ${brk.name}`);
    if (aapl) {
      ok(`${p.label}：AAPL 价格 50–1000 美元`, aapl.last / MICRO > 50 && aapl.last / MICRO < 1000, String(aapl.last / MICRO));
      const usTsDay = etParts(new Date(aapl.ts * 1000)).day;
      ok(`${p.label}：AAPL 时间戳换算成美东日不穿越`, usTsDay <= usDay, `${usTsDay} vs ${usDay}`);
      ok(`${p.label}：AAPL 没有每日涨跌停`, aapl.limitUp === null && aapl.sealedUp === false, `up=${aapl.limitUp}`);
    }
    const usIdx = await tryProvider(key, '美股指数', () => p.usIndexes(cfg));
    box.usIndexes = usIdx.value ?? [];
    ok(`${p.label}：美股指数 ≥2 条`, box.usIndexes.length >= 2, box.usIndexes.map((r) => `${r.name}:${(r.last / MICRO).toFixed(0)}`).join(' '));
  }
  if (p.caps.suggest) {
    const s = await tryProvider(key, '检索', () => p.suggest(cfg, '600519', 'cn'));
    ok(`${p.label}：代码检索命中茅台`, (s.value ?? []).some((row) => row.secid === '1.600519'), `${s.value?.length ?? 0} 条`);
  }
}

// 横向对照：同一标的三家价格必须几乎一致，字段错位在这里现形
const em = perProvider.eastmoney;
for (const key of ['tencent', 'sina']) {
  const box = perProvider[key];
  if (!box?.one || !em?.one) continue;
  const diff = Math.abs(box.one.last - em.one.last) / em.one.last;
  ok(`${key} 与东财的茅台价格一致（<0.5%）`, diff < 0.005, `${(box.one.last / MICRO).toFixed(2)} vs ${(em.one.last / MICRO).toFixed(2)} · 差 ${(diff * 100).toFixed(3)}%`);
  const emIdx = (em.indexes ?? []).find((row) => row.secid === '1.000001');
  const txIdx = (box.indexes ?? []).find((row) => row.secid === '1.000001');
  if (emIdx && txIdx) {
    const d2 = Math.abs(txIdx.last - emIdx.last) / emIdx.last;
    ok(`${key} 与东财的上证指数一致（<0.5%）`, d2 < 0.005, `${(txIdx.last / MICRO).toFixed(2)} vs ${(emIdx.last / MICRO).toFixed(2)}`);
  }
  if (box.us?.length && em.us?.length) {
    const a = box.us.find((row) => row.secid === '105.AAPL');
    const b = em.us.find((row) => row.secid === '105.AAPL');
    if (a && b) ok(`${key} 与东财的 AAPL 一致（<1%）`, Math.abs(a.last - b.last) / b.last < 0.01,
      `${(a.last / MICRO).toFixed(2)} vs ${(b.last / MICRO).toFixed(2)}`);
  }
}

console.log(results.join('\n'));
console.log(`\nSUMMARY pass=${results.length - failed} fail=${failed}`);
process.exit(failed ? 1 : 0);
