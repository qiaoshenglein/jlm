// 指标计算：纯函数，不带任何 React 与 DOM 依赖，回归脚本可以直接 import 核对数值。
export type MacdPoint = { dif: number; dea: number; hist: number };

// EMA 的递推起点取第一个值（国内行情软件的通行口径），不另做 SMA 预热，
// 这样前后端、以及用户手上的看盘软件算出来的 DIF/DEA 才能对得上。
export function ema(values: number[], period: number): number[] {
  const k = 2 / (Math.max(1, period) + 1);
  const out: number[] = [];
  let prev = Number.NaN;
  for (const value of values) {
    if (!Number.isFinite(value)) { out.push(prev); continue; }
    prev = Number.isFinite(prev) ? value * k + prev * (1 - k) : value;
    out.push(prev);
  }
  return out;
}

// 柱（MACD bar）= 2 ×(DIF − DEA)，同样按国内口径，不是国际上的 DIF − DEA
export function macd(closes: number[], fast = 12, slow = 26, signal = 9): MacdPoint[] {
  const values = closes.map((v) => (Number.isFinite(v) ? v : Number.NaN));
  const fastLine = ema(values, fast);
  const slowLine = ema(values, slow);
  const dif = values.map((_, i) => (Number.isFinite(fastLine[i]) && Number.isFinite(slowLine[i]) ? fastLine[i] - slowLine[i] : Number.NaN));
  const dea = ema(dif, signal);
  return dif.map((value, i) => ({
    dif: value,
    dea: dea[i],
    hist: Number.isFinite(value) && Number.isFinite(dea[i]) ? 2 * (value - dea[i]) : Number.NaN,
  }));
}
