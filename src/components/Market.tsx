import { useEffect, useMemo, useRef, useState, type WheelEvent } from 'react';
import { api } from '../api';
import { cachedSeries, loadSeries, prefetchChart } from '../chart-cache';
import { CandleChart, MiniBar, PriceCell, TrendChart, type Marker } from './charts';
import {
  currencyOfSecid, marketOfSecid, percent, priceText, tickOfSecid, tone,
  type Board, type Quote, type SearchRow, type WatchRow,
} from '../format';

export type Tab = 'index' | 'etf' | 'stock' | 'gainer' | 'loser' | 'watch' | 'held';

const TABS: { key: Tab; label: string }[] = [
  { key: 'index', label: '指数' },
  { key: 'etf', label: 'ETF' },
  { key: 'stock', label: '个股' },
  { key: 'gainer', label: '涨幅' },
  { key: 'loser', label: '跌幅' },
  { key: 'watch', label: '自选' },
  { key: 'held', label: '持仓' },
];

const PAGE_MAX = 10;

// 行情池外的自选标的先占位显示，等下一轮行情补上真实价格
function offlineQuote(row: WatchRow): Quote {
  return {
    secid: row.secid, code: row.code, name: row.name, kind: row.kind as Quote['kind'],
    last: 0, prevClose: 0, open: null, high: null, low: null, change: 0, pct: 0,
    volume: 0, amount: 0, turnover: null, marketCap: null,
    // 占位行没有涨跌停概念，一律给 null，由面板显示「—」而不是 0.00
    limitUp: null, limitDown: null, limitRatio: 0,
    tick: tickOfSecid(row.secid, row.kind),
    ts: 0, sealedUp: false, sealedDown: false,
  };
}

export function Tape({ indexes }: { indexes: Quote[] }) {
  if (indexes.length === 0) return null;
  const doubled = [...indexes, ...indexes];
  return (
    <div className="relative overflow-hidden border-y border-hairline bg-panel/70" aria-hidden="true">
      <div className="tape flex w-max gap-8 px-4 py-1.5 text-xs">
        {doubled.map((quote, position) => (
          <span key={`${quote.secid}-${position}`} className="flex shrink-0 items-center gap-2">
            <span className="text-muted-foreground">{quote.name}</span>
            <span className={`num ${tone(quote.pct)}`}>{priceText(quote.last, quote.tick)}</span>
            <span className={`num ${tone(quote.pct)}`}>{percent(quote.pct)}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

export function MarketPanel({ board, selected, held, watch, watchQuotes, filter, onFilter, onSelect, onPick, onToggleWatch, searchText, onSearch, compact = false, onRowsChange, onMove }: {
  board: Board | null;
  selected: string;
  held: Quote[];
  watch: WatchRow[];
  watchQuotes: Quote[];
  filter: Tab;
  onFilter: (tab: Tab) => void;
  onSelect: (secid: string) => void;
  onPick: (item: SearchRow) => void;
  onToggleWatch: (item: { secid: string; code: string; name: string; kind: string }) => void;
  searchText: string;
  onSearch: (value: string) => void;
  compact?: boolean;
  onRowsChange: (rows: { secid: string }[]) => void;
  onMove?: (secid: string, delta: number) => void;
}) {
  const query = searchText.trim();
  const [results, setResults] = useState<SearchRow[] | null>(null);
  const [searching, setSearching] = useState(false);
  const seq = useRef(0);
  const watchSet = useMemo(() => new Set(watch.map((item) => item.secid)), [watch]);

  const rows = useMemo(() => {
    if (!board) return [];
    const base: Record<Tab, Quote[]> = {
      index: board.indexes, etf: board.etfs, stock: board.stocks,
      gainer: board.gainers, loser: board.losers, held,
      // 自选里可能有行情池外的标的：没有实时价也占一行（显示 —），否则加了却看不见
      watch: watch.map((row) => watchQuotes.find((quote) => quote.secid === row.secid) ?? offlineQuote(row)),
    };
    return base[filter] ?? [];
  }, [board, filter, held, watchQuotes]);

  useEffect(() => { onRowsChange(rows); }, [rows.length, filter, board]);

  // 分页窗口：一页最多 PAGE_MAX 条，条数按列表区实际高度换算，高度永远固定、不随分类切换跳动
  const listRef = useRef<HTMLDivElement | null>(null);
  const [perPage, setPerPage] = useState(PAGE_MAX);
  const [page, setPage] = useState(0);
  useEffect(() => {
    const el = listRef.current;
    if (!el) return undefined;
    const fit = () => {
      const row = Number.parseFloat(getComputedStyle(el).getPropertyValue('--list-row')) || 44;
      setPerPage(Math.max(1, Math.min(PAGE_MAX, Math.floor(el.clientHeight / row))));
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const active: SearchRow[] = query ? (results ?? []) : rows;
  const pageCount = Math.max(1, Math.ceil(active.length / perPage));
  const current = Math.min(page, pageCount - 1);
  const paged = active.slice(current * perPage, current * perPage + perPage);
  const notice = query
    ? (active.length > 0 ? null
      : searching || results === null ? '搜索中…'
        : <>没有匹配「{query}」的标的。<br />可试 6 位代码、拼音首字母（gzmt）或名称关键词。</>)
    : active.length === 0
      ? (filter === 'watch' ? '还没有自选标的：搜索后点右侧的 ☆ 即可加入'
        : filter === 'held' ? '暂无持仓，先下一笔委托' : '行情加载中…')
      : null;

  useEffect(() => { setPage(0); }, [filter, query]);

  // 翻页手感：滚轮直接翻页（列表本身不滚动），PageUp/PageDown/Home/End 走页码
  const wheelAt = useRef(0);
  const turn = (delta: number) => setPage((value) => Math.min(pageCount - 1, Math.max(0, value + delta)));
  const onWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    const el = event.currentTarget;
    if (el.scrollHeight - el.clientHeight > 2) return; // 窗口装不下时让位给滚动
    if (Math.abs(event.deltaY) < 18) return;
    const now = Date.now();
    if (now - wheelAt.current < 420) return;
    const next = event.deltaY > 0 ? 1 : -1;
    if (current + next < 0 || current + next > pageCount - 1) return;
    wheelAt.current = now;
    turn(next);
  };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target && (/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) || target.isContentEditable)) return;
      const jump = event.key === 'Home' ? -pageCount : event.key === 'End' ? pageCount : 0;
      const step = jump || (event.key === 'PageDown' ? 1 : event.key === 'PageUp' ? -1 : 0);
      if (!step) return;
      event.preventDefault();
      setPage((value) => Math.min(pageCount - 1, Math.max(0, value + step)));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pageCount]);

  // 选中项的日 K 与左右邻居的分时提前取好，点过去就是零等待
  useEffect(() => {
    if (query || !selected) return;
    const at = rows.findIndex((row) => row.secid === selected);
    if (at < 0) return;
    prefetchChart(selected, ['kline']);
    for (const delta of [-1, 1]) {
      const near = rows[at + delta];
      if (near) prefetchChart(near.secid);
    }
  }, [selected, rows, query]);

  // 键盘流选中跨页时跟着翻页，手动翻页后不再被拉回
  const followed = useRef('');
  useEffect(() => {
    if (query || followed.current === selected) return;
    followed.current = selected;
    const at = rows.findIndex((row) => row.secid === selected);
    if (at >= 0) setPage(Math.floor(at / perPage));
  }, [selected, rows, query, perPage]);

  // 搜索走服务端：全市场代码/拼音建议接口 + 本地标的索引，不只是筛当前列表。
  // 保留上一次结果不清屏，只把列表压暗，避免每敲一个字就闪一下空白。
  useEffect(() => {
    if (!query) { setResults(null); setSearching(false); return; }
    const request = ++seq.current;
    setSearching(true);
    const timer = window.setTimeout(async () => {
      try {
        const found = await api<{ rows: SearchRow[] }>('search', { q: query }, true);
        if (request === seq.current) setResults(found.rows);
      } catch {
        if (request === seq.current) setResults([]);
      } finally {
        if (request === seq.current) setSearching(false);
      }
    }, 150);
    return () => window.clearTimeout(timer);
  }, [query]);

  const breadth = board?.breadth;
  const sourceBad = Boolean(board?.status && !board.status.ok);
  // 上游只挂掉一部分时（比如单标的接口抖动）池子仍然可用，用更轻的一条话说明降级了什么
  const sourcePartial = board?.status?.partial ?? '';

  return (
    <div className="panel flex h-full flex-col overflow-hidden">
      <header className="flex min-w-0 shrink-0 items-center border-b border-hairline px-2 py-1.5">
        <div role="tablist" aria-label="行情分类" className="scrollbar-thin flex min-w-0 flex-nowrap gap-0.5 overflow-x-auto">
          {TABS.map((tab) => (
            <button key={tab.key} role="tab" type="button" aria-selected={filter === tab.key}
              onClick={() => { onFilter(tab.key); if (tab.key === 'watch') onSearch(''); }}
              className={`shrink-0 whitespace-nowrap rounded px-1.5 py-1 text-[0.75rem] transition-colors duration-75 active:translate-y-px ${filter === tab.key
                ? 'bg-surface-2 text-primary shadow-[inset_0_0_0_1px_var(--hairline)]'
                : 'text-muted-foreground hover:bg-surface-2/60 hover:text-foreground'}`}>
              {tab.label}
              {tab.key === 'watch' && watch.length > 0 && <span className="num ml-0.5 text-[0.6875rem] opacity-70">{watch.length}</span>}
            </button>
          ))}
        </div>
      </header>

      <div className="relative shrink-0 border-b border-hairline px-3 py-2">
        <input value={searchText} onChange={(event) => onSearch(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && results?.length) {
              onPick(results[0]);
              (event.target as HTMLInputElement).blur();
            }
          }}
          aria-label="搜索标的代码、名称或拼音"
          placeholder={board?.market === 'us' ? '搜索美股代码或名称，如 AAPL、英伟达' : '搜索代码 / 名称 / 拼音，如 600519、gzmt、平安'}
          className="h-7 w-full rounded border border-hairline bg-raised pl-2 pr-7 text-xs outline-none placeholder:text-ink-dim focus:border-input" />
        {searchText && (
          <button type="button" aria-label="清空搜索" title="清空搜索（Esc）" onClick={() => onSearch('')}
            className="absolute right-3.5 top-1/2 -translate-y-1/2 rounded px-1 text-[0.8125rem] leading-none text-ink-dim hover:text-foreground">✕</button>
        )}
        {searching && <span className="skel absolute inset-x-2 bottom-0 h-0.5 rounded-full" />}
      </div>

      {/* 美股没有涨跌家数，但降级提示照样要占这一行，否则「行情源异常」在美股页根本没地方显示 */}
      {(breadth || sourceBad || sourcePartial) && (
        <div className="num flex shrink-0 items-center gap-x-3 overflow-hidden whitespace-nowrap border-b border-hairline/70 px-3 py-1 text-[0.6875rem] text-ink-dim">
          {breadth && !compact && (
            <>
              <span>涨 <b className="text-up">{breadth.up}</b></span>
              <span>跌 <b className="text-down">{breadth.down}</b></span>
              <span>涨停 <b className="text-up">{breadth.limitUp}</b></span>
              <span>跌停 <b className="text-down">{breadth.limitDown}</b></span>
            </>
          )}
          {sourceBad && <span className="shrink-0 rounded bg-up/15 px-1.5 text-up">行情源异常，显示上次快照</span>}
          {!sourceBad && sourcePartial && <span className="shrink-0 rounded bg-warn/15 px-1.5 text-warn">行情部分降级 · {sourcePartial}</span>}
        </div>
      )}

      <div className="grid shrink-0 grid-cols-[minmax(0,1fr)_4.5rem_3.5rem_auto] items-center gap-x-1.5 border-b border-hairline/70 px-2.5 py-1 text-[0.6875rem] text-ink-dim">
        <span>{query ? '搜索结果' : '名称 / 代码'}</span><span className="text-right">最新</span>
        <span className="text-right">涨跌</span><span className="w-6 text-right" title="自选">★</span>
      </div>

      <div ref={listRef} onWheel={onWheel} className="scrollbar-thin relative min-h-0 flex-1 overflow-y-auto">
        <div key={`${filter}-${current}`} className={`page-in ${query && searching ? 'opacity-60 transition-opacity' : ''}`}>
          {paged.map((item) => query ? (
            <Row key={item.secid} item={item} selected={selected} inWatch={watchSet.has(item.secid)}
              onPick={onPick} onToggleWatch={onToggleWatch} />
          ) : (
            <Row key={item.secid} item={{ ...item, fromList: true }} selected={selected} inWatch={watchSet.has(item.secid)}
              movable={filter === 'watch' && Boolean(onMove)}
              onMove={(secid, delta) => onMove?.(secid, delta)}
              onPick={(row) => onSelect(row.secid)} onToggleWatch={onToggleWatch} />
          ))}
          {/* 不足一页时用等高的空行补齐，切换分类或搜索时列表高度保持不变 */}
          {Array.from({ length: perPage - paged.length }, (_, index) => <Slot key={`slot-${index}`} />)}
        </div>
        {notice && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center px-4">
            <p className="rounded bg-panel/88 px-3 py-2 text-center text-xs leading-6 text-ink-dim">{notice}</p>
          </div>
        )}
      </div>

      <footer className="num flex shrink-0 items-center gap-1.5 border-t border-hairline px-2 py-1 text-[0.6875rem] text-ink-dim">
        <button type="button" aria-label="上一页" title="上一页（PageUp）" disabled={current === 0} onClick={() => turn(-1)}
          className="min-h-7 shrink-0 rounded border border-hairline px-2 transition-colors duration-75 hover:bg-surface-2 hover:text-foreground active:bg-surface-3 disabled:opacity-35 disabled:hover:bg-transparent disabled:hover:text-ink-dim">
          ‹ 上页
        </button>
        <span className="ml-auto shrink-0">
          {active.length === 0 ? '—' : `${current + 1} / ${pageCount}`}
          <span className="ml-1 opacity-70">{active.length} 条 · {perPage}/页</span>
        </span>
        <button type="button" aria-label="下一页" title="下一页（PageDown）" disabled={current >= pageCount - 1} onClick={() => turn(1)}
          className="min-h-7 shrink-0 rounded border border-hairline px-2 transition-colors duration-75 hover:bg-surface-2 hover:text-foreground active:bg-surface-3 disabled:opacity-35 disabled:hover:bg-transparent disabled:hover:text-ink-dim">
          下页 ›
        </button>
      </footer>
    </div>
  );
}

function Row({ item, selected, inWatch, movable, onMove, onPick, onToggleWatch }: {
  item: SearchRow | (Quote & { fromList?: boolean });
  selected: string;
  inWatch: boolean;
  movable?: boolean;
  onMove?: (secid: string, delta: number) => void;
  onPick: (item: SearchRow) => void;
  onToggleWatch: (item: { secid: string; code: string; name: string; kind: string }) => void;
}) {
  const quote = item as Partial<Quote>;
  const live = typeof quote.last === 'number' && quote.last > 0;
  const pct = quote.pct ?? 0;
  const tick = quote.tick ?? tickOfSecid(item.secid, item.kind);
  const cols = 'grid-cols-[minmax(0,1fr)_4.5rem_3.5rem_auto] gap-x-1.5 px-2.5';
  const pick = () => onPick(item);
  return (
    <div role="button" tabIndex={-1} aria-pressed={selected === item.secid}
      // 鼠标按下即选中（比 click 早约一拍），触屏仍走 click 以免误触；整行都是热区，不必瞄名称那一小块
      onPointerDown={(event) => { if (event.pointerType === 'mouse' && event.button === 0) pick(); }}
      onClick={pick}
      onMouseEnter={() => prefetchChart(item.secid)}
      className={`dense-row list-row grid cursor-pointer items-center border-b border-hairline/40 text-[0.8125rem] transition-colors duration-75 hover:bg-surface-3 active:bg-surface-3 ${cols} ${selected === item.secid ? 'bg-surface-2 shadow-[inset_2px_0_0_var(--primary)]' : ''}`}>
      <span className="min-w-0">
        <span className="block truncate">{item.name}
          {quote.sealedUp && <em className="ml-1 not-italic text-[0.6875rem] text-up">涨停</em>}
          {quote.sealedDown && <em className="ml-1 not-italic text-[0.6875rem] text-down">跌停</em>}
          {item.kind === 'index' && <em className="ml-1 not-italic text-[0.6875rem] text-ink-dim">指数</em>}
        </span>
        <span className="num block truncate text-[0.6875rem] text-ink-dim">{item.code}</span>
      </span>
      <PriceCell value={live ? (quote.last as number) : null} tick={tick} className={live ? tone(pct) : 'text-ink-dim'} />
      <span className={`num text-right ${live ? tone(pct) : 'text-ink-dim'}`}>{live ? percent(pct) : '—'}</span>
      <span className="flex items-center justify-end gap-1">
        <button type="button" title={inWatch ? '移出自选' : '加入自选'}
          aria-label={inWatch ? `将 ${item.name} 移出自选` : `将 ${item.name} 加入自选`}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => { event.stopPropagation(); onToggleWatch({ secid: item.secid, code: item.code, name: item.name, kind: item.kind }); }}
          className={`-mr-1 size-7 shrink-0 rounded text-center text-[0.9375rem] leading-none transition-colors duration-75 active:bg-surface-3 ${inWatch ? 'text-primary' : 'text-ink-dim hover:bg-surface-3 hover:text-foreground'}`}>
          {inWatch ? '★' : '☆'}
        </button>
        {movable && (
          <span className="flex flex-col leading-[0.7] text-[0.5625rem] text-ink-dim">
            <button type="button" aria-label={`将 ${item.name} 上移`}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => { event.stopPropagation(); onMove?.(item.secid, -1); }}
              className="rounded px-1 py-0.5 hover:bg-surface-3 hover:text-foreground">▲</button>
            <button type="button" aria-label={`将 ${item.name} 下移`}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => { event.stopPropagation(); onMove?.(item.secid, 1); }}
              className="rounded px-1 py-0.5 hover:bg-surface-3 hover:text-foreground">▼</button>
          </span>
        )}
      </span>
    </div>
  );
}

// 空行占位：与 Row 同一套列与行高，因此列表窗口高度只取决于每页条数
function Slot() {
  return (
    <div aria-hidden="true" className="dense-row list-row grid select-none items-center border-b border-hairline/40 text-[0.8125rem] grid-cols-[minmax(0,1fr)_4.5rem_3.5rem_auto] gap-x-1.5 px-2.5">
      <span className="min-w-0"><span className="block truncate">&nbsp;</span><span className="num block truncate text-[0.6875rem]">&nbsp;</span></span>
      <span /><span /><span className="w-6" />
    </div>
  );
}

type Trends = { name: string; preClose: number; points: { t: string; price: number; volume: number; avg: number }[] };
type Bars = { day: string; open: number; close: number; high: number; low: number; volume: number }[];

export function DetailPanel({ quote, markers = null, compact = false, onToast }: {
  quote: Quote | null; markers?: Marker[] | null; compact?: boolean; onToast: (message: string) => void;
}) {
  const [kind, setKind] = useState<'trends' | 'kline'>('trends');
  const [trends, setTrends] = useState<Trends | null>(null);
  const [bars, setBars] = useState<Bars | null>(null);
  const [loading, setLoading] = useState(false);

  // 图表走共享缓存：悬停与相邻标的已预取过，点开的多数情况是零等待
  useEffect(() => {
    if (!quote) return undefined;
    let cancelled = false;
    const show = (series: Trends | Bars) => {
      if (kind === 'trends') setTrends(series as Trends); else setBars(series as Bars);
    };
    const fresh = cachedSeries<Trends | Bars>(quote.secid, kind);
    if (fresh !== undefined) {
      show(fresh);
      setLoading(false);
      return undefined;
    }
    // 没缓存就先把这一档清空，避免把上一只的曲线当成这一只的
    if (kind === 'trends') setTrends(null); else setBars(null);
    setLoading(true);
    loadSeries<Trends | Bars>(quote.secid, kind)
      .then((series) => { if (!cancelled) show(series); })
      .catch(() => { if (!cancelled) onToast('该标的图表暂时取不到'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [quote?.secid, kind]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!quote) {
    return (
      <div className="grid-lines flex h-full items-center justify-center rounded-lg border border-hairline bg-panel text-xs text-ink-dim">
        选择标的后查看分时与日 K
      </div>
    );
  }

  const us = marketOfSecid(quote.secid) === 'us';
  const cur = currencyOfSecid(quote.secid);
  const symbol = cur === 'USD' ? '$' : '¥';
  // 成交量与成交额跟着币种走：美股没有「手」，成交额也是美元
  // 注意 amount / marketCap 上游给的是「元（美元）」原值而不是微单位，别再过一遍 compact()
  const volumeText = quote.kind === 'index' ? '—' : `${(quote.volume / 1e4).toFixed(1)}${us ? '万股' : '万手'}`;
  const amountText = quote.amount > 0 ? `${symbol}${(quote.amount / 1e8).toFixed(2)}亿` : '—';
  const capText = quote.marketCap === null ? '—' : `${symbol}${(quote.marketCap / 1e8).toFixed(0)}亿`;
  const full = [
    ['今开', priceText(quote.open ?? 0, quote.tick), tone((quote.open ?? 0) - quote.prevClose)],
    ['最高', priceText(quote.high ?? 0, quote.tick), tone((quote.high ?? 0) - quote.prevClose)],
    ['最低', priceText(quote.low ?? 0, quote.tick), tone((quote.low ?? 0) - quote.prevClose)],
    ['昨收', priceText(quote.prevClose, quote.tick), 'text-muted-foreground'],
    // 美股没有每日涨跌停，给「无」而不是编一个 0.00 的价格
    ['涨停', quote.limitUp === null ? '无' : priceText(quote.limitUp, quote.tick), 'text-up'],
    ['跌停', quote.limitDown === null ? '无' : priceText(quote.limitDown, quote.tick), 'text-down'],
    ['成交量', volumeText, 'text-muted-foreground'],
    ['成交额', amountText, 'text-muted-foreground'],
    ['换手率', quote.turnover === null ? '—' : `${quote.turnover.toFixed(2)}%`, 'text-muted-foreground'],
    ['总市值', capText, 'text-muted-foreground'],
  ] as const;
  // 手机上只留一行四项，其余高度全部让给图形
  const cells = compact
    ? ([
      ['昨收', priceText(quote.prevClose, quote.tick), 'text-muted-foreground'],
      ['最高', priceText(quote.high ?? 0, quote.tick), tone((quote.high ?? 0) - quote.prevClose)],
      ['最低', priceText(quote.low ?? 0, quote.tick), tone((quote.low ?? 0) - quote.prevClose)],
      ['成交额', amountText, 'text-muted-foreground'],
    ] as const)
    : full;

  return (
    <div className="panel flex h-full flex-col overflow-hidden">
      <header className="flex shrink-0 flex-wrap items-end gap-x-6 gap-y-2 border-b border-hairline px-4 py-2.5">
        <div>
          <h2 className="text-base">{quote.name}<span className="num ml-2 text-xs text-ink-dim">{quote.code}</span></h2>
          <p className="text-[0.75rem] text-ink-dim">
            {us ? '美股实时行情 · 无每日涨跌停 · T+0 交收 · 1 股起'
              : `沪深实时行情 · 涨跌停 ${percent(quote.limitRatio * 100, 0)} · 股票 T+1 交收`}
          </p>
        </div>
        <div className={`num flex items-baseline gap-3 ${tone(quote.pct)}`}>
          <span className={`leading-none ${compact ? 'text-2xl' : 'text-3xl'}`}>{priceText(quote.last, quote.tick)}</span>
          <span className="text-sm">{percent(quote.pct)}</span>
        </div>
        <div className="ml-auto flex gap-1 rounded bg-muted/60 p-1 text-xs">
          {(['trends', 'kline'] as const).map((value) => (
            <button key={value} type="button" onClick={() => setKind(value)} aria-pressed={kind === value}
              className={`rounded px-3 py-1 transition-colors duration-75 active:bg-surface-3 ${kind === value ? 'bg-raised text-primary' : 'text-muted-foreground hover:text-foreground'}`}>
              {value === 'trends' ? '分时' : '日 K'}
            </button>
          ))}
        </div>
      </header>

      <div className={`grid gap-x-4 gap-y-1 border-b border-hairline/70 px-4 text-[0.75rem] ${compact ? 'grid-cols-4 py-1' : 'grid-cols-5 py-2 gap-y-1'}`} style={compact ? { columnGap: '0.5rem' } : undefined}>
        {cells.map(([label, value, className]) => (
          <div key={label} className="flex flex-col">
            <span className="text-ink-dim">{label}</span>
            <span className={`num ${className}`}>{value}</span>
          </div>
        ))}
      </div>

      <div className="relative min-h-0 flex-1 p-2">
        {loading && (kind === 'trends' ? !trends : !bars) && (
          <p className="absolute inset-0 grid place-items-center text-xs text-ink-dim">图表加载中…</p>
        )}
        {loading && (kind === 'trends' ? trends : bars) && (
          <span className="skel absolute inset-x-2 top-1 z-10 h-0.5 rounded-full" />
        )}
        {kind === 'trends'
          ? <TrendChart points={trends?.points ?? []} prevClose={quote.prevClose} quote={quote} markers={markers} />
          : <CandleChart bars={bars ?? []} markers={markers} />}
      </div>
    </div>
  );
}

export function HeldQuotes(board: Board | null, positions: { symbol: string }[]): Quote[] {
  if (!board) return [];
  const pool = [...board.indexes, ...board.etfs, ...board.stocks];
  const bySecid = new Map(pool.map((quote) => [quote.secid, quote]));
  return positions.map((position) => bySecid.get(position.symbol)).filter((quote): quote is Quote => Boolean(quote));
}

