import { api } from './api';

// 图表数据的共享缓存：详情面板读它，列表悬停/相邻标的预取也写它。
// 目的是让「点一下就看到图」几乎零等待——这是交易台手感的核心一环。
const TTL = 20_000;

type Entry = { at: number; data: unknown };

const entries = new Map<string, Entry>();
const flights = new Map<string, Promise<unknown>>();

// kweek 与 kline 走同一个接口，只是 period 不同；分开缓存，切换时互不覆盖
export type ChartKind = 'trends' | 'kline' | 'kweek';

export function cachedSeries<T>(secid: string, kind: ChartKind): T | undefined {
  const hit = entries.get(`${secid}:${kind}`);
  return hit && Date.now() - hit.at < TTL ? (hit.data as T) : undefined;
}

export function loadSeries<T>(secid: string, kind: ChartKind): Promise<T> {
  const key = `${secid}:${kind}`;
  const fresh = cachedSeries<T>(secid, kind);
  if (fresh !== undefined) return Promise.resolve(fresh);
  const flying = flights.get(key);
  if (flying) return flying as Promise<T>;
  const payload = kind === 'trends'
    ? { secid, kind }
    : { secid, kind: 'kline', period: kind === 'kweek' ? 'week' : 'day', count: kind === 'kweek' ? 120 : 160 };
  const task = api<{ series: T }>('chart', payload, true)
    .then((result) => {
      entries.set(key, { at: Date.now(), data: result.series });
      if (entries.size > 120) {
        for (const [stale] of [...entries.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, 60)) entries.delete(stale);
      }
      return result.series;
    })
    .finally(() => flights.delete(key));
  flights.set(key, task);
  return task;
}

// 预取失败不打扰用户，真正点开时再按正常路径提示
export function prefetchChart(secid: string, kinds: ChartKind[] = ['trends']) {
  for (const kind of kinds) void loadSeries(secid, kind).catch(() => undefined);
}
