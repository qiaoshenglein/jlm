// 上游用量计数：只回答一个问题——「刚才那一下到底出没出网」。
// 故意不落库：这张卡要的是当前进程的实时口径，跨重启的累计值会把「现在很省」和「上周很费」混成一个数。
const WINDOW_MINUTES = 30;

let startedAt = Date.now();
const caps = new Map();
const providers = new Map();
const layers = new Map();
const minutes = new Map();
let totals = { calls: 0, ok: 0, fail: 0, probe: 0 };

function touch(map, key, ok, ms) {
  const row = map.get(key) ?? { calls: 0, ok: 0, fail: 0, ms: 0 };
  row.calls += 1;
  if (ok) row.ok += 1; else row.fail += 1;
  row.ms += Math.max(0, Math.round(ms));
  map.set(key, row);
}

/** 一次真实的上游请求（含「一键检测」的探测，用 probe 标出来，免得把主动检测当成日常流量） */
export function noteCall({ cap, provider, ok, ms = 0, probe = false }, at = Date.now()) {
  totals.calls += 1;
  if (ok) totals.ok += 1; else totals.fail += 1;
  if (probe) totals.probe += 1;
  touch(caps, cap, ok, ms);
  if (provider) touch(providers, provider, ok, ms);
  const minute = Math.floor(at / 60_000) * 60_000;
  const bucket = minutes.get(minute) ?? { calls: 0, ok: 0, fail: 0 };
  bucket.calls += 1;
  if (ok) bucket.ok += 1; else bucket.fail += 1;
  minutes.set(minute, bucket);
}

/** 缓存层的一次判定：hit 挡下了出网，miss 会真的打上游，merged 是同键并发合并到的那一次 */
export function noteCache(layer, kind) {
  const row = layers.get(layer) ?? { hit: 0, miss: 0, merged: 0 };
  row[kind] += 1;
  layers.set(layer, row);
}

export function usageSnapshot(at = Date.now()) {
  const nowMinute = Math.floor(at / 60_000) * 60_000;
  const cutoff = nowMinute - (WINDOW_MINUTES - 1) * 60_000;
  for (const minute of minutes.keys()) if (minute < cutoff) minutes.delete(minute);
  const perMinute = [];
  for (let minute = cutoff; minute <= nowMinute; minute += 60_000) {
    const bucket = minutes.get(minute);
    perMinute.push({ at: new Date(minute).toISOString(), calls: bucket?.calls ?? 0, fail: bucket?.fail ?? 0 });
  }
  const rows = (map) => [...map.entries()].map(([key, row]) => ({
    key,
    calls: row.calls,
    ok: row.ok,
    fail: row.fail,
    avgMs: row.calls ? Math.round(row.ms / row.calls) : 0,
  })).sort((a, b) => b.calls - a.calls);
  const cache = [...layers.entries()].map(([layer, row]) => ({
    layer,
    hit: row.hit,
    miss: row.miss,
    merged: row.merged,
    rate: row.hit + row.miss > 0 ? Math.round((row.hit / (row.hit + row.miss)) * 100) : 0,
  })).sort((a, b) => (b.hit + b.miss) - (a.hit + a.miss));
  return {
    since: new Date(startedAt).toISOString(),
    uptimeMs: Math.max(0, at - startedAt),
    total: { ...totals },
    byCap: rows(caps),
    byProvider: rows(providers),
    cache,
    perMinute,
    windowMinutes: WINDOW_MINUTES,
  };
}

export function resetUsage(at = Date.now()) {
  startedAt = at;
  caps.clear();
  providers.clear();
  layers.clear();
  minutes.clear();
  totals = { calls: 0, ok: 0, fail: 0, probe: 0 };
  return usageSnapshot(at);
}
