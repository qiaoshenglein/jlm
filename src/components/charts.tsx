// 图形全部手写 SVG：不依赖图表库默认样式，颜色严格遵循红涨绿跌。
// 关键：按容器实测像素渲染，不用 viewBox 比例推高度，否则面板变矮时图形底部会被裁掉。
import { useEffect, useRef, useState } from 'react';
import { Y, priceText, type Quote } from '../format';

const UP = 'var(--up)';
const DOWN = 'var(--down)';
const FLAT = 'var(--flat)';
const HAIR = 'var(--hairline)';

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

function bounds(values: number[], pad = 0.08) {
  const finite = values.filter((value) => Number.isFinite(value));
  if (finite.length === 0) return { low: 0, high: 1 };
  const min = Math.min(...finite);
  const max = Math.max(...finite);
  const span = (max - min) || Math.abs(max) * 0.01 || 1;
  return { low: min - span * pad, high: max + span * pad };
}

type Point = { t: string; price: number; volume: number; avg: number };

export function TrendChart({ points, prevClose, quote }: {
  points: Point[]; prevClose: number; quote?: Quote | null;
}) {
  const [ref, size] = useSize({ width: 720, height: 210 });
  const { width, height } = size;
  const priceH = Math.round(height * 0.72);
  const volTop = priceH + 10;
  const volH = Math.max(12, height - volTop - 14);

  if (points.length < 2) {
    return <div ref={ref}><Placeholder text="暂无分时数据（开盘后自动填充）" /></div>;
  }

  const { low, high } = bounds(points.flatMap((p) => [p.price, p.avg]).concat([prevClose]));
  const x = (index: number) => (points.length <= 1 ? width / 2 : (index / (points.length - 1)) * width);
  const y = (value: number) => priceH - ((value - low) / (high - low || 1)) * priceH;
  const line = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p.price).toFixed(1)}`).join('');
  const avgLine = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p.avg).toFixed(1)}`).join('');
  const area = `${line}L${width},${priceH}L0,${priceH}Z`;
  const last = points[points.length - 1].price;
  const color = last > prevClose ? UP : last < prevClose ? DOWN : FLAT;
  const zeroY = y(prevClose);
  const maxVolume = Math.max(...points.map((p) => p.volume), 1);
  const labelPct = ((last - prevClose) / (prevClose || 1)) * 100;

  return (
    <div ref={ref} className="h-full w-full">
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img"
        aria-label={`分时走势，最新 ${priceText(last, quote?.tick)}，涨跌 ${labelPct.toFixed(2)}%`}>
        <defs>
          <linearGradient id="trend-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.26" />
            <stop offset="100%" stopColor={color} stopOpacity="0.02" />
          </linearGradient>
        </defs>
        {[0.25, 0.5, 0.75].map((f) => (
          <line key={f} x1={0} x2={width} y1={priceH * f} y2={priceH * f} stroke={HAIR} strokeDasharray="3 5" />
        ))}
        <line x1={0} x2={width} y1={zeroY} y2={zeroY} stroke={FLAT} strokeDasharray="5 4" />
        <path d={area} fill="url(#trend-fill)" />
        <path d={line} fill="none" stroke={color} strokeWidth={1.6} />
        <path d={avgLine} fill="none" stroke="var(--primary)" strokeWidth={1} strokeOpacity={0.7} />
        <circle cx={x(points.length - 1)} cy={y(last)} r={2.6} fill={color} />
        {points.map((p, i) => (
          <rect key={i} x={x(i) - Math.max(0.5, width / points.length / 2.5)} y={volTop + volH - (p.volume / maxVolume) * volH}
            width={Math.max(1, width / points.length / 2.5)} height={Math.max(1, (p.volume / maxVolume) * volH)}
            fill={p.price >= prevClose ? UP : DOWN} opacity={0.3} />
        ))}
        <text x={0} y={height - 2} fill="var(--ink-dim)" fontSize={10}>{points[0].t}</text>
        {points.length > 20 && [0.25, 0.5, 0.75].map((f) => (
          <text key={f} x={x(Math.floor((points.length - 1) * f)) - 12} y={height - 2} fill="var(--ink-dim)" fontSize={10}>
            {points[Math.floor((points.length - 1) * f)].t}
          </text>
        ))}
        <text x={width} y={height - 2} fill="var(--ink-dim)" fontSize={10} textAnchor="end">{points[points.length - 1].t}</text>
        <text x={6} y={Math.max(11, zeroY - 4)} fill="var(--ink-dim)" fontSize={10}>昨收 {priceText(prevClose, quote?.tick)}</text>
      </svg>
    </div>
  );
}

type Bar = { day: string; open: number; close: number; high: number; low: number; volume: number };

export function CandleChart({ bars }: { bars: Bar[] }) {
  const [ref, size] = useSize({ width: 720, height: 210 });
  const { width, height } = size;

  if (bars.length < 2) {
    return <div ref={ref}><Placeholder text="暂无 K 线数据" /></div>;
  }
  const shown = bars.slice(-Math.max(20, Math.floor(width / 9)));
  const priceH = Math.round(height * 0.72);
  const volTop = priceH + 10;
  const volH = Math.max(12, height - volTop - 14);
  const { low, high } = bounds(shown.flatMap((b) => [b.high, b.low]), 0.05);
  const slot = width / shown.length;
  const y = (value: number) => priceH - ((value - low) / (high - low || 1)) * priceH;
  const maxVolume = Math.max(...shown.map((b) => b.volume), 1);

  return (
    <div ref={ref} className="h-full w-full">
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img"
        aria-label={`日 K 线，共 ${shown.length} 个交易日`}>
        {[0.25, 0.5, 0.75].map((f) => (
          <line key={f} x1={0} x2={width} y1={priceH * f} y2={priceH * f} stroke={HAIR} strokeDasharray="3 5" />
        ))}
        <line x1={0} x2={width} y1={priceH} y2={priceH} stroke={HAIR} />
        {shown.map((bar, index) => {
          const up = bar.close >= bar.open;
          const color = up ? UP : DOWN;
          const cx = index * slot + slot / 2;
          const bodyTop = y(Math.max(bar.open, bar.close));
          const bodyBottom = y(Math.min(bar.open, bar.close));
          const bodyHeight = Math.max(1, bodyBottom - bodyTop);
          const wide = slot > 4;
          const volumeH = Math.max(1, (bar.volume / maxVolume) * volH);
          return (
            <g key={bar.day}>
              <line x1={cx} x2={cx} y1={y(bar.high)} y2={y(bar.low)} stroke={color} strokeWidth={wide ? 1 : 0.7} />
              {wide ? (
                <rect x={index * slot + slot * 0.16} y={bodyTop} width={slot * 0.68} height={bodyHeight}
                  fill={up ? 'transparent' : color} stroke={color} strokeWidth={1} />
              ) : (
                <line x1={cx} x2={cx} y1={bodyTop} y2={bodyTop + bodyHeight} stroke={color} strokeWidth={1.6} />
              )}
              <rect x={index * slot + slot * 0.2} y={volTop + volH - volumeH} width={Math.max(1, slot * 0.6)}
                height={volumeH} fill={color} opacity={0.32} />
            </g>
          );
        })}
        <text x={0} y={height - 2} fill="var(--ink-dim)" fontSize={10}>{shown[0].day}</text>
        <text x={width} y={height - 2} fill="var(--ink-dim)" fontSize={10} textAnchor="end">{shown[shown.length - 1].day}</text>
        <text x={6} y={12} fill="var(--ink-dim)" fontSize={10}>
          最高 {priceText(Math.max(...shown.map((b) => b.high)))} / 最低 {priceText(Math.min(...shown.map((b) => b.low)))}
        </text>
      </svg>
    </div>
  );
}

export function EquityCurve({ points, baseline, height = 190 }: {
  points: { day: string; netAssets: number }[]; baseline: number; height?: number;
}) {
  const [ref, size] = useSize({ width: 720, height });
  const width = size.width;
  if (points.length < 2) {
    return <div ref={ref} style={{ height }}><Placeholder text="净值曲线需积累两个交易日的日结快照后显示" /></div>;
  }
  const values = points.map((p) => p.netAssets);
  const { low, high } = bounds([...values, baseline], 0.1);
  const x = (index: number) => (points.length <= 1 ? width / 2 : (index / (points.length - 1)) * width);
  const y = (value: number) => height - ((value - low) / (high - low || 1)) * height;
  const line = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p.netAssets).toFixed(1)}`).join('');
  const last = values[values.length - 1];
  const color = last >= baseline ? UP : DOWN;
  const baseY = y(baseline);

  return (
    <div ref={ref} className="w-full" style={{ height }}>
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img"
        aria-label={`净值曲线，当前 ${Math.round(last / Y)} 元，初始 ${Math.round(baseline / Y)} 元`}>
        <defs>
          <linearGradient id="equity-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.22" />
            <stop offset="100%" stopColor={color} stopOpacity="0.02" />
          </linearGradient>
        </defs>
        <line x1={0} x2={width} y1={baseY} y2={baseY} stroke={FLAT} strokeDasharray="5 4" />
        <path d={`${line}L${width},${height}L0,${height}Z`} fill="url(#equity-fill)" />
        <path d={line} fill="none" stroke={color} strokeWidth={1.8} />
        {points.map((p, i) => <circle key={p.day} cx={x(i)} cy={y(p.netAssets)} r={1.8} fill={color} />)}
        <text x={6} y={Math.max(12, baseY - 5)} fill="var(--ink-dim)" fontSize={10}>本金基线</text>
        <text x={0} y={height - 2} fill="var(--ink-dim)" fontSize={10}>{points[0].day}</text>
        <text x={width} y={height - 2} fill="var(--ink-dim)" fontSize={10} textAnchor="end">{points[points.length - 1].day}</text>
      </svg>
    </div>
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
    <div className="grid-lines flex h-full min-h-[120px] w-full items-center justify-center rounded-md border border-hairline/70 text-xs text-muted-foreground">
      {text}
    </div>
  );
}
