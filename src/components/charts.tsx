// 图形全部手写 SVG：不依赖图表库默认样式，颜色严格遵循红涨绿跌。
// 约定一：按容器实测像素渲染，不用 viewBox 比例推高度，否则面板变矮时图形底部会被裁掉。
// 约定二：右侧固定留出价格轴栏，十字线读数永远画在画布内。
import { useEffect, useRef, useState } from 'react';
import { Y, priceText, type Quote } from '../format';
import { macd, type MacdPoint } from '../indicators';

const UP = 'var(--up)';
const DOWN = 'var(--down)';
const FLAT = 'var(--flat)';
const HAIR = 'var(--hairline)';
const DIM = 'var(--ink-dim)';
const AXIS_W = 58;

function useSize(fallback: { width: number; height: number }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState(fallback);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const apply = () => {
      const rect = node.getBoundingClientRect();
      if (rect.width > 40 && rect.height > 40) setSize({ width: Math.round(rect.width), height: Math.round(rect.height) });
    };
    apply();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', apply);
      return () => window.removeEventListener('resize', apply);
    }
    const observer = new ResizeObserver(apply);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return [ref, size] as const;
}

// viewBox 与像素等值，鼠标横坐标可直接当绘图坐标使用
function offsetX(event: React.PointerEvent<SVGSVGElement>) {
  return event.clientX - event.currentTarget.getBoundingClientRect().left;
}

function bounds(values: number[], pad = 0.08) {
  const finite = values.filter((value) => Number.isFinite(value));
  if (finite.length === 0) return { low: 0, high: 1 };
  const min = Math.min(...finite);
  const max = Math.max(...finite);
  const span = (max - min) || Math.abs(max) * 0.01 || 1;
  return { low: min - span * pad, high: max + span * pad };
}

function PriceAxis({ width, height, low, high, tick }: {
  width: number; height: number; low: number; high: number; tick: number;
}) {
  const plotW = width - AXIS_W;
  const y = (value: number) => height - ((value - low) / (high - low || 1)) * height;
  return (
    <g>
      {[0.08, 0.36, 0.64, 0.92].map((f) => {
        const value = low + (high - low) * f;
        return (
          <g key={f}>
            <line x1={0} x2={plotW} y1={y(value)} y2={y(value)} stroke={HAIR} strokeDasharray="2 6" opacity={0.5} />
            <text x={plotW + 8} y={y(value) + 3.5} fill={DIM} fontSize={11}>{priceText(value, tick)}</text>
          </g>
        );
      })}
    </g>
  );
}

function PriceTag({ width, limit, y, text, color }: {
  width: number; limit: number; y: number; text: string; color: string;
}) {
  const top = Math.max(1, Math.min(limit - 17, y - 8));
  return (
    <g pointerEvents="none">
      <rect x={width - AXIS_W + 4} y={top} width={AXIS_W - 8} height={16} rx={3} fill={color} />
      <text x={width - AXIS_W / 2} y={top + 11.5} fill="#06121c" fontSize={11} textAnchor="middle" fontWeight="700">{text}</text>
    </g>
  );
}

function Readout({ x, right, y, lines, accent, boxW = 132 }: {
  x: number; right: number; y: number; lines: string[]; accent: string; boxW?: number;
}) {
  const boxH = lines.length * 14 + 10;
  const left = x + boxW + 16 > right ? Math.max(2, x - boxW - 10) : x + 10;
  const top = Math.max(2, Math.min(y - boxH / 2, 180));
  return (
    <g pointerEvents="none">
      <rect x={left} y={top} width={boxW} height={boxH} rx={5} fill="var(--surface-2)" stroke={accent} opacity={0.97} />
      {lines.map((line, i) => (
        <text key={i} x={left + 9} y={top + 15 + i * 14} fill={i === 0 ? accent : 'var(--foreground)'} fontSize={11.5}>{line}</text>
      ))}
    </g>
  );
}

export type Marker = { price: number; label: string; tone?: 'cost' | 'liq' };

// 参考线（持仓成本、预估强平价）画在左侧，避免与右侧价格轴打架
function RefLine({ price, label, plotW, y, low, high, tick, tone }: {
  price: number; label: string; plotW: number; y: (v: number) => number; low: number; high: number;
  tick: number; tone: 'cost' | 'liq';
}) {
  // price 与坐标轴同为「微元」，超出可视区间就不画
  if (!Number.isFinite(price) || price <= low || price >= high) return null;
  const color = tone === 'cost' ? 'var(--info)' : 'var(--danger)';
  return (
    <g pointerEvents="none">
      <line x1={0} x2={plotW} y1={y(price)} y2={y(price)} stroke={color} strokeDasharray="1 4" strokeWidth={1.2} opacity={0.9} />
      <text x={6} y={y(price) - 4} fill={color} fontSize={11} fontWeight={600}>{label} {priceText(price, tick)}</text>
    </g>
  );
}

type Point = { t: string; price: number; volume: number; avg: number };

export function TrendChart({ points, prevClose, quote, markers }: {
  points: Point[]; prevClose: number; quote?: Quote | null; markers?: Marker[] | null;
}) {
  const [ref, size] = useSize({ width: 720, height: 210 });
  const [hover, setHover] = useState<number | null>(null);
  const { width, height } = size;
  const plotW = Math.max(40, width - AXIS_W);
  const priceH = Math.round(height * 0.68);
  const volTop = priceH + 10;
  const volH = Math.max(12, height - volTop - 16);

  if (points.length < 2) {
    return <div ref={ref}><Placeholder text="暂无分时数据（开盘后自动填充）" /></div>;
  }

  const { low, high } = bounds(points.flatMap((p) => [p.price, p.avg]).concat([prevClose]));
  const x = (i: number) => (points.length <= 1 ? plotW / 2 : (i / (points.length - 1)) * plotW);
  const y = (value: number) => priceH - ((value - low) / (high - low || 1)) * priceH;
  const line = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p.price).toFixed(1)}`).join('');
  const avgLine = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p.avg).toFixed(1)}`).join('');
  const area = `${line}L${plotW},${priceH}L0,${priceH}Z`;
  const last = points[points.length - 1];
  const color = last.price > prevClose ? UP : last.price < prevClose ? DOWN : FLAT;
  const maxVolume = Math.max(...points.map((p) => p.volume), 1);
  const pct = ((last.price - prevClose) / (prevClose || 1)) * 100;
  const active = hover === null ? null : points[hover];
  const cost = markers?.find((marker) => marker.tone !== 'liq');
  const readoutLines = (price: number) => [
    `${active?.t ?? ''}   ${priceText(price, quote?.tick)}`,
    `均价 ${priceText(active?.avg ?? price, quote?.tick)}`,
    `涨跌 ${(((price - prevClose) / (prevClose || 1)) * 100).toFixed(2)}%`,
    ...(cost ? [`持仓成本 ${priceText(cost.price / Y, quote?.tick)} · 浮盈 ${(((price - cost.price / Y) / (cost.price / Y || 1)) * 100).toFixed(2)}%`] : []),
  ];

  return (
    <div ref={ref} className="h-full w-full">
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img"
        aria-label={`分时走势，最新 ${priceText(last.price, quote?.tick)}，涨跌 ${pct.toFixed(2)}%`}
        onPointerMove={(event) => setHover(Math.max(0, Math.min(points.length - 1,
          Math.round((offsetX(event) / plotW) * (points.length - 1)))))}
        onPointerLeave={() => setHover(null)}>
        <defs>
          <linearGradient id="trend-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.3" />
            <stop offset="100%" stopColor={color} stopOpacity="0.02" />
          </linearGradient>
        </defs>
        <line x1={0} x2={plotW} y1={y(prevClose)} y2={y(prevClose)} stroke={FLAT} strokeDasharray="5 4" />
        <path d={area} fill="url(#trend-fill)" />
        {points.map((p, i) => (
          <rect key={i} x={x(i) - Math.max(0.5, plotW / points.length / 2.6)}
            y={volTop + volH - (p.volume / maxVolume) * volH}
            width={Math.max(1, plotW / points.length / 2.6)} height={Math.max(1, (p.volume / maxVolume) * volH)}
            fill={p.price >= prevClose ? UP : DOWN} opacity={0.32} />
        ))}
        <path d={line} fill="none" stroke={color} strokeWidth={1.7} />
        <path d={avgLine} fill="none" stroke="var(--primary)" strokeWidth={1.1} strokeOpacity={0.75} />
        <line x1={0} x2={plotW} y1={volTop + volH} y2={volTop + volH} stroke={HAIR} />
        <line x1={0} x2={plotW} y1={y(last.price)} y2={y(last.price)} stroke={color} strokeDasharray="4 3" opacity={0.75} />
        <circle cx={x(points.length - 1)} cy={y(last.price)} r={3} fill={color} />
        {(markers ?? []).map((marker) => (
          <RefLine key={marker.label} price={marker.price} label={marker.label} plotW={plotW} y={y}
            low={low} high={high} tick={quote?.tick ?? 10_000} tone={marker.tone ?? 'cost'} />
        ))}
        <PriceAxis width={width} height={priceH} low={low} high={high} tick={quote?.tick ?? 10_000} />
        <PriceTag width={width} limit={priceH} y={y(last.price)} text={priceText(last.price, quote?.tick)} color={color} />
        {active && (
          <g>
            <line x1={x(hover ?? 0)} x2={x(hover ?? 0)} y1={0} y2={volTop + volH} stroke="var(--foreground)" opacity={0.4} />
            <circle cx={x(hover ?? 0)} cy={y(active.price)} r={3} fill="var(--foreground)" />
            <Readout x={x(hover ?? 0)} right={plotW} y={y(active.price)} accent={color}
              lines={readoutLines(active.price)} />
          </g>
        )}
        <text x={0} y={height - 3} fill={DIM} fontSize={11}>{points[0].t}</text>
        {[0.3, 0.6].map((f) => (
          <text key={f} x={x(Math.floor((points.length - 1) * f)) - 14} y={height - 3} fill={DIM} fontSize={11}>
            {points[Math.floor((points.length - 1) * f)].t}
          </text>
        ))}
        <text x={plotW} y={height - 3} fill={DIM} fontSize={11} textAnchor="end">{last.t}</text>
      </svg>
    </div>
  );
}

type Bar = { day: string; open: number; close: number; high: number; low: number; volume: number };

export function CandleChart({ bars, markers, period = 'day' }: {
  bars: Bar[]; markers?: Marker[] | null; period?: 'day' | 'week';
}) {
  const [ref, size] = useSize({ width: 720, height: 210 });
  const [hover, setHover] = useState<number | null>(null);
  const { width, height } = size;

  if (bars.length < 2) {
    return <div ref={ref}><Placeholder text="暂无 K 线数据" /></div>;
  }
  const plotW = Math.max(40, width - AXIS_W);
  const shown = bars.slice(-Math.max(20, Math.floor(plotW / 9)));
  // 三段高度：价格 / 成交量 / MACD
  const priceH = Math.round(height * 0.54);
  const volTop = priceH + 8;
  const volH = Math.max(10, Math.round(height * 0.13));
  const macdTop = volTop + volH + 14;
  const macdH = Math.max(16, height - macdTop - 16);
  const { low, high } = bounds(shown.flatMap((b) => [b.high, b.low]), 0.05);
  const slot = plotW / shown.length;
  const y = (value: number) => priceH - ((value - low) / (high - low || 1)) * priceH;
  const maxVolume = Math.max(...shown.map((b) => b.volume), 1);
  const last = shown[shown.length - 1];
  const prev = shown[shown.length - 2];
  const color = last.close >= prev.close ? UP : DOWN;
  // 股价两位小数、场内基金三位：用最近一根的精度差异推断报价刻度
  const tick = Math.abs(last.close % 1000) === 0 && last.close > 10 * Y ? 10_000 : last.close < 10 * Y ? 1_000 : 10_000;
  const active = hover === null ? null : shown[hover];
  const cost = markers?.find((marker) => marker.tone !== 'liq');
  // MACD 按全部 bars 递推、只截尾显示：EMA 需要预热，先截后算的头几根会和看盘软件对不上
  const ind = macd(bars.map((bar) => bar.close / Y)).slice(-shown.length);
  const macdMax = Math.max(...ind.flatMap((point) => [point.dif, point.dea, point.hist])
    .filter(Number.isFinite).map(Math.abs), 1e-6);
  const zeroY = macdTop + macdH / 2;
  const my = (value: number) => zeroY - ((Number.isFinite(value) ? value : 0) / macdMax) * (macdH / 2 - 2);
  const macdPath = (pick: (point: MacdPoint) => number) => ind
    .map((point, i) => `${i === 0 ? 'M' : 'L'}${(i * slot + slot / 2).toFixed(1)},${my(pick(point)).toFixed(1)}`)
    .join('');
  const spanLabel = period === 'week' ? '周' : '个交易日';
  const activeInd = hover === null ? null : ind[hover];
  // MACD 的量级差得远（茅台几十、ETF 零点几），小数位跟着走，否则读出来全是 0.00
  const mv = (value: number) => (Number.isFinite(value) ? (Math.abs(value) < 0.1 ? value.toFixed(3) : value.toFixed(2)) : '—');

  return (
    <div ref={ref} className="h-full w-full">
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img"
        aria-label={`${period === 'week' ? '周' : '日'} K 线，共 ${shown.length} ${spanLabel}，最新 ${priceText(last.close, tick)}，MACD DIF ${mv(ind[ind.length - 1]?.dif ?? 0)}`}
        onPointerMove={(event) => setHover(Math.max(0, Math.min(shown.length - 1, Math.floor(offsetX(event) / slot))))}
        onPointerLeave={() => setHover(null)}>
        {[0.16, 0.42, 0.68, 0.9].map((f) => (
          <line key={f} x1={0} x2={plotW} y1={priceH * f} y2={priceH * f} stroke={HAIR} strokeDasharray="3 5" />
        ))}
        <line x1={0} x2={plotW} y1={priceH} y2={priceH} stroke={HAIR} />
        {shown.map((bar, index) => {
          const up = bar.close >= bar.open;
          const tone = up ? UP : DOWN;
          const cx = index * slot + slot / 2;
          const bodyTop = y(Math.max(bar.open, bar.close));
          const bodyHeight = Math.max(1, y(Math.min(bar.open, bar.close)) - bodyTop);
          const wide = slot > 4;
          const volumeH = Math.max(1, (bar.volume / maxVolume) * volH);
          const point = ind[index];
          const histTop = Math.min(my(point.hist), zeroY);
          const histH = Math.max(1, Math.abs(my(point.hist) - zeroY));
          return (
            <g key={bar.day} opacity={hover !== null && hover !== index ? 0.55 : 1}>
              <line x1={cx} x2={cx} y1={y(bar.high)} y2={y(bar.low)} stroke={tone} strokeWidth={wide ? 1 : 0.8} />
              {wide ? (
                <rect x={index * slot + slot * 0.16} y={bodyTop} width={Math.max(1.5, slot * 0.68)} height={bodyHeight}
                  fill={up ? 'transparent' : tone} stroke={tone} strokeWidth={1} />
              ) : (
                <line x1={cx} x2={cx} y1={bodyTop} y2={bodyTop + bodyHeight} stroke={tone} strokeWidth={1.6} />
              )}
              <rect x={index * slot + slot * 0.2} y={volTop + volH - volumeH} width={Math.max(1, slot * 0.6)}
                height={volumeH} fill={tone} opacity={0.34} />
              <rect x={index * slot + slot * 0.2} y={histTop} width={Math.max(1, slot * 0.6)} height={histH}
                fill={point.hist >= 0 ? UP : DOWN} opacity={0.8} />
            </g>
          );
        })}
        <line x1={0} x2={plotW} y1={volTop + volH} y2={volTop + volH} stroke={HAIR} />
        <line x1={0} x2={plotW} y1={zeroY} y2={zeroY} stroke={HAIR} strokeDasharray="3 5" />
        <path d={macdPath((point) => point.dif)} fill="none" stroke="var(--info)" strokeWidth={1.25} />
        <path d={macdPath((point) => point.dea)} fill="none" stroke="var(--primary)" strokeWidth={1.25} />
        <text x={2} y={macdTop - 3} fill={DIM} fontSize={10.5}>
          MACD 12/26/9　<tspan fill="var(--info)">DIF {mv(ind[ind.length - 1]?.dif ?? Number.NaN)}</tspan>
          <tspan fill="var(--primary)">　DEA {mv(ind[ind.length - 1]?.dea ?? Number.NaN)}</tspan>
          <tspan fill={((ind[ind.length - 1]?.hist ?? 0) >= 0 ? UP : DOWN)}>　柱 {mv(ind[ind.length - 1]?.hist ?? Number.NaN)}</tspan>
        </text>
        <text x={plotW + 8} y={macdTop + 9} fill={DIM} fontSize={10}>{macdMax.toFixed(2)}</text>
        <text x={plotW + 8} y={macdTop + macdH - 1} fill={DIM} fontSize={10}>{(-macdMax).toFixed(2)}</text>
        <line x1={0} x2={plotW} y1={y(last.close)} y2={y(last.close)} stroke={color} strokeDasharray="4 3" opacity={0.75} />
        {(markers ?? []).map((marker) => (
          <RefLine key={marker.label} price={marker.price} label={marker.label} plotW={plotW} y={y}
            low={low} high={high} tick={tick} tone={marker.tone ?? 'cost'} />
        ))}
        <PriceAxis width={width} height={priceH} low={low} high={high} tick={tick} />
        <PriceTag width={width} limit={priceH} y={y(last.close)} text={priceText(last.close, tick)} color={color} />
        {active && (
          <g>
            <line x1={(hover ?? 0) * slot + slot / 2} x2={(hover ?? 0) * slot + slot / 2} y1={0} y2={macdTop + macdH}
              stroke="var(--foreground)" opacity={0.4} />
            <circle cx={(hover ?? 0) * slot + slot / 2} cy={my(activeInd?.dif ?? Number.NaN)} r={2.4} fill="var(--info)" />
            <Readout x={(hover ?? 0) * slot + slot / 2} right={plotW} y={y(active.close)} accent={color} boxW={172}
              lines={[
                `${active.day.slice(5)}  收 ${priceText(active.close, tick)}`,
                `开 ${priceText(active.open, tick)}  高 ${priceText(active.high, tick)}`,
                `低 ${priceText(active.low, tick)}  量 ${(active.volume / 1e4).toFixed(1)}万`,
                `DIF ${mv(activeInd?.dif ?? Number.NaN)}  DEA ${mv(activeInd?.dea ?? Number.NaN)}  柱 ${mv(activeInd?.hist ?? Number.NaN)}`,
                ...(cost ? [`成本 ${priceText(cost.price / Y, tick)} 处 ${(((active.close - cost.price / Y) / (cost.price / Y || 1)) * 100).toFixed(1)}%`] : []),
              ]} />
          </g>
        )}
        <text x={0} y={height - 3} fill={DIM} fontSize={11}>{shown[0].day}</text>
        <text x={plotW} y={height - 3} fill={DIM} fontSize={11} textAnchor="end">{last.day}</text>
      </svg>
    </div>
  );
}

export function EquityCurve({ points, baseline, height = 190 }: {
  points: { day: string; netAssets: number }[]; baseline: number; height?: number;
}) {
  const [ref, size] = useSize({ width: 720, height });
  const [hover, setHover] = useState<number | null>(null);
  const width = size.width;
  if (points.length < 2) {
    return <div ref={ref} style={{ height }}><Placeholder text="净值曲线需积累两个交易日的日结快照后显示" /></div>;
  }
  const plotW = Math.max(40, width - AXIS_W);
  const values = points.map((p) => p.netAssets);
  const { low, high } = bounds([...values, baseline], 0.1);
  const x = (i: number) => (points.length <= 1 ? plotW / 2 : (i / (points.length - 1)) * plotW);
  const y = (value: number) => height - 18 - ((value - low) / (high - low || 1)) * (height - 30);
  const line = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p.netAssets).toFixed(1)}`).join('');
  const last = values[values.length - 1];
  const color = last >= baseline ? UP : DOWN;
  const active = hover === null ? null : points[hover];

  return (
    <div ref={ref} className="w-full" style={{ height }}>
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img"
        aria-label={`净值曲线，当前 ${Math.round(last / Y)} 元，初始 ${Math.round(baseline / Y)} 元`}
        onPointerMove={(event) => setHover(Math.max(0, Math.min(points.length - 1,
          Math.round((offsetX(event) / plotW) * (points.length - 1)))))}
        onPointerLeave={() => setHover(null)}>
        <defs>
          <linearGradient id="equity-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.26" />
            <stop offset="100%" stopColor={color} stopOpacity="0.02" />
          </linearGradient>
        </defs>
        <line x1={0} x2={plotW} y1={y(baseline)} y2={y(baseline)} stroke={FLAT} strokeDasharray="5 4" />
        <path d={`${line}L${plotW},${height}L0,${height}Z`} fill="url(#equity-fill)" />
        <path d={line} fill="none" stroke={color} strokeWidth={1.9} />
        {points.map((p, i) => <circle key={p.day} cx={x(i)} cy={y(p.netAssets)} r={2} fill={color} />)}
        {[0.12, 0.5, 0.88].map((f) => (
          <text key={f} x={plotW + 8} y={y(low + (high - low) * f) + 4} fill={DIM} fontSize={11}>
            {((low + (high - low) * f) / Y / 1e4).toFixed(0)}万
          </text>
        ))}
        <text x={4} y={Math.max(12, y(baseline) - 5)} fill={DIM} fontSize={11}>本金基线</text>
        {active && (
          <Readout x={x(hover ?? 0)} right={plotW} y={y(active.netAssets)} accent={color}
            lines={[active.day, `${(active.netAssets / Y / 1e4).toFixed(2)}万`,
              `${((active.netAssets / baseline - 1) * 100).toFixed(2)}%`]} />
        )}
        <text x={0} y={height - 3} fill={DIM} fontSize={11}>{points[0].day}</text>
        <text x={plotW} y={height - 3} fill={DIM} fontSize={11} textAnchor="end">{points[points.length - 1].day}</text>
      </svg>
    </div>
  );
}

// 价格单元格：只在背景上闪一下，绝不改变尺寸或列宽
export function PriceCell({ value, tick = 10_000, className = '' }: {
  value: number | null | undefined; tick?: number; className?: string;
}) {
  const prev = useRef(value);
  const [dir, setDir] = useState('');
  useEffect(() => {
    const before = prev.current;
    if (value === null || value === undefined || before === null || before === undefined || value === before) return;
    prev.current = value;
    setDir(value > before ? 'flash-up' : 'flash-down');
    const timer = window.setTimeout(() => setDir(''), 820);
    return () => window.clearTimeout(timer);
  }, [value]);
  return (
    <span className={`num inline-block min-w-[4.25em] rounded px-1 text-right ${dir} ${className}`}>
      {value === null || value === undefined ? '—' : priceText(value, tick)}
    </span>
  );
}

// 涨跌迷你条：0 轴两侧对称，首屏一眼看出市场温度
export function MiniBar({ pct, width = 78 }: { pct: number; width?: number }) {
  const clamped = Math.max(-6, Math.min(6, pct));
  const half = width / 2;
  const bar = (Math.abs(clamped) / 6) * half;
  return (
    <svg width={width} height={10} role="img" aria-label={`${clamped.toFixed(2)}%`}>
      <rect x={0} y={3} width={width} height={4} fill="var(--hairline)" rx={2} />
      <rect x={clamped >= 0 ? half : half - bar} y={3} width={Math.max(bar, 1)} height={4}
        rx={2} fill={clamped > 0 ? UP : clamped < 0 ? DOWN : FLAT} />
    </svg>
  );
}

function Placeholder({ text }: { text: string }) {
  return (
    <div className="grid-lines flex h-full min-h-[120px] w-full items-center justify-center rounded-md border border-hairline/70 text-[0.75rem] text-muted-foreground">
      {text}
    </div>
  );
}
