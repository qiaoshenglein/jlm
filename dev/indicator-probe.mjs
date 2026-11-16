// 指标与周线合并的离线回归：不打网络，只核对数学口径。
// MACD 的期望值是手算出来的（10/11/12/13，2-3-2 参数），不是把实现再跑一遍——
// 那种「自己对自己」的断言改错了也照样绿。
// 用法：node dev/indicator-probe.mjs
import { ema, macd } from '../src/indicators.ts';
import { weeklyFromDaily } from '../functions/quote-sources.mjs';

let passed = 0;
let failed = 0;
const ok = (name, condition, detail = '') => {
  if (condition) passed += 1; else failed += 1;
  console.log(`${condition ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};
const near = (a, b, eps = 1e-4) => Number.isFinite(a) && Math.abs(a - b) <= eps;

// ---- 1. EMA 递推 ----
ok('EMA 常数序列仍是常数', ema([5, 5, 5, 5], 3).every((v) => near(v, 5)), JSON.stringify(ema([5, 5, 5, 5], 3)));
const hand = ema([1, 2, 3], 2); // k=2/3：1, 1.6667, 2.5556
ok('EMA 起点取第一个值并按 2/(n+1) 递推',
  near(hand[0], 1) && near(hand[1], 5 / 3) && near(hand[2], 23 / 9), JSON.stringify(hand));
ok('EMA 长度与输入一致', ema([1, 2, 3, 4, 5], 9).length === 5);
ok('EMA 遇到缺口沿用上一个值而不是断成 NaN',
  ema([1, 2, Number.NaN, 4], 2).every(Number.isFinite), JSON.stringify(ema([1, 2, Number.NaN, 4], 2)));

// ---- 2. MACD 手算对照（10/11/12/13，fast=2 slow=3 signal=2）----
const golden = macd([10, 11, 12, 13], 2, 3, 2);
ok('DIF 手算值对得上', golden.map((p) => p.dif).every((v, i) => near(v, [0, 0.1666667, 0.3055556, 0.3935185][i], 1e-6)),
  JSON.stringify(golden.map((p) => Number(p.dif.toFixed(6)))));
ok('DEA 手算值对得上', golden.map((p) => p.dea).every((v, i) => near(v, [0, 0.1111111, 0.2407407, 0.3425926][i], 1e-6)),
  JSON.stringify(golden.map((p) => Number(p.dea.toFixed(6)))));
ok('柱按国内口径 = 2×(DIF−DEA)', golden.every((p) => near(p.hist, 2 * (p.dif - p.dea), 1e-9))
  && near(golden[3].hist, 0.1018518, 1e-6), JSON.stringify(golden.map((p) => Number(p.hist.toFixed(6)))));
ok('首根 DIF/DEA/柱 全为 0（EMA 同点起步）',
  golden[0].dif === 0 && golden[0].dea === 0 && golden[0].hist === 0, JSON.stringify(golden[0]));

// ---- 3. 默认参数与形状 ----
const flat = macd(Array.from({ length: 80 }, () => 100));
ok('默认参数 12/26/9 且横盘时三线全为 0',
  flat.length === 80 && flat.every((p) => Math.abs(p.dif) < 1e-9 && Math.abs(p.dea) < 1e-9 && Math.abs(p.hist) < 1e-9));
const rising = macd(Array.from({ length: 120 }, (_, i) => 10 + i * 0.1));
ok('单边上涨时 DIF 恒在 0 轴上方', rising.every((p) => p.dif >= -1e-9), `末值 ${rising.at(-1).dif.toFixed(3)}`);
ok('空数组不炸', macd([]).length === 0);

// 先涨后跌：柱必须翻绿，且金叉/死叉由 DIF−DEA 的符号决定
const turn = [...Array.from({ length: 60 }, (_, i) => 10 + i * 0.2), ...Array.from({ length: 60 }, (_, i) => 22 - i * 0.25)];
const turned = macd(turn);
const lastHist = turned.at(-1).hist;
const crossed = turned.some((p, i) => i > 60 && p.hist < 0);
ok('趋势反转后柱翻绿（死叉）', crossed && lastHist < 0, `末柱 ${lastHist.toFixed(3)} · DIF ${turned.at(-1).dif.toFixed(3)}`);
ok('上涨段里柱先为正（金叉区间）', turned.slice(30, 55).every((p) => p.hist > 0));

// ---- 4. 日线合并成周线 ----
const bar = (day, open, close, high, low, volume) => ({ day, open, close, high, low, volume });
// 2026-11-09 是周一，11-13 周五，11-15 周日（仍属那一周），11-16 下周一
const daily = [
  bar('2026-11-09', 100, 102, 103, 99, 10),
  bar('2026-11-10', 102, 101, 104, 100, 20),
  bar('2026-11-12', 101, 105, 106, 101, 30),   // 周三休市一天，仍并到同一周
  bar('2026-11-13', 105, 104, 107, 103, 40),
  bar('2026-11-15', 104, 106, 108, 104, 5),    // 周日归上一周
  bar('2026-11-16', 106, 107, 109, 105, 50),
];
const weekly = weeklyFromDaily(daily);
ok('同周交易日并成一根，跨周才新开', weekly.length === 2, `${weekly.length} 根：${weekly.map((w) => w.day).join(',')}`);
ok('周 K 取周一开盘、周末收盘、区间高低与量求和',
  weekly[0].open === 100 && weekly[0].close === 106 && weekly[0].high === 108 && weekly[0].low === 99
  && weekly[0].volume === 105, JSON.stringify(weekly[0]));
ok('周 K 的日期是该周最后一个交易日', weekly[0].day === '2026-11-15' && weekly[1].day === '2026-11-16',
  `${weekly[0].day} / ${weekly[1].day}`);
ok('只有一根日线的周也能成一根周 K', weekly[1].open === 106 && weekly[1].close === 107 && weekly[1].volume === 50);
ok('空输入不炸', weeklyFromDaily([]).length === 0 && weeklyFromDaily(null).length === 0);

// 250 个交易日（跳过周末）≈ 50 根周 K：周线喂进 MACD 的点数必须与周 K 根数一致
const tradeDays = [];
for (let i = 0; tradeDays.length < 250; i++) {
  const date = new Date(Date.UTC(2025, 0, 1 + i));
  if (date.getUTCDay() % 6 === 0) continue;
  tradeDays.push(bar(date.toISOString().slice(0, 10), 10, 10.1, 10.2, 9.9, 100));
}
const longWeekly = weeklyFromDaily(tradeDays);
ok('250 个交易日并成约 50 根周 K，且 MACD 点数与周 K 一致',
  longWeekly.length >= 49 && longWeekly.length <= 51 && macd(longWeekly.map((w) => w.close)).length === longWeekly.length,
  `${longWeekly.length} 根周 K`);

console.log(`\nSUMMARY pass=${passed} fail=${failed}`);
process.exit(failed ? 1 : 0);
