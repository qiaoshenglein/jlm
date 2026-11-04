import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { CandleChart, MiniBar, TrendChart } from './charts';
import { percent, priceText, tone, type Board, type Quote, type SearchRow, type Session, type WatchRow } from '../format';

export type Tab = 'index' | 'etf' | 'stock' | 'gainer' | 'loser' | 'watch' | 'held';

const TABS: { key: Tab; label: string }[] = [
  { key: 'index', label: '沪深指数' },
  { key: 'etf', label: '指数 ETF' },
  { key: 'stock', label: '活跃个股' },
  { key: 'gainer', label: '涨幅榜' },
  { key: 'loser', label: '跌幅榜' },
  { key: 'watch', label: '自选' },
  { key: 'held', label: '我的持仓' },
];

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

export function MarketPanel({ board, session, selected, held, watch, watchQuotes, filter, onFilter, onSelect, onPick, onToggleWatch, searchText, onSearch, compact = false }: {
  board: Board | null;
  session: Session | null;
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
      gainer: board.gainers, loser: board.losers, held, watch: watchQuotes,
    };
    return base[filter] ?? [];
  }, [board, filter, held, watchQuotes]);

  // 搜索走服务端：全市场代码/拼音建议接口 + 本地标的索引，不只是筛当前列表
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
    }, 260);
    return () => window.clearTimeout(timer);
  }, [query]);

  const breadth = board?.breadth;

  return (
    <div className="flex h-full flex-col rounded-lg border border-hairline bg-panel">
      <header className="flex flex-wrap items-center gap-2 border-b border-hairline px-3 py-2">
        <div role="tablist" aria-label="行情分类" className="flex flex-wrap gap-1">
          {TABS.map((tab) => (
            <button key={tab.key} role="tab" type="button" aria-selected={filter === tab.key}
              onClick={() => { onFilter(tab.key); if (tab.key === 'watch') onSearch(''); }}
              className={`rounded px-2.5 py-1 text-xs transition ${filter === tab.key
                ? 'bg-raised text-primary'
                : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'}`}>
              {tab.label}
              {tab.key === 'watch' && watch.length > 0 && <span className="num ml-1 text-[10px] opacity-70">{watch.length}</span>}
            </button>
          ))}
        </div>
      </header>

      <div className="border-b border-hairline px-3 py-2">
        <input value={searchText} onChange={(event) => onSearch(event.target.value)}
          aria-label="搜索标的代码、名称或拼音" placeholder="搜索代码 / 名称 / 拼音，如 600519、gzmt、平安"
          className="h-7 w-full rounded border border-hairline bg-raised px-2 text-xs outline-none placeholder:text-ink-dim focus:border-input" />
      </div>

      {breadth && !query && (
        <div className="num flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-hairline/70 px-3 py-1.5 text-[11px] text-ink-dim">
          <span>上涨 <b className="text-up">{breadth.up}</b></span>
          <span>下跌 <b className="text-down">{breadth.down}</b></span>
          <span>平盘 {breadth.flat}</span>
          <span>涨停 <b className="text-up">{breadth.limitUp}</b></span>
          <span>跌停 <b className="text-down">{breadth.limitDown}</b></span>
          <span className="ml-auto">{session?.stamp.slice(11) ?? ''}</span>
          {board?.status && !board.status.ok && (
            <span className="rounded bg-up/15 px-1.5 py-0.5 text-up">行情源异常，显示上次快照</span>
          )}
        </div>
      )}

      <div className="grid grid-cols-[1fr_auto_auto_auto] gap-2 border-b border-hairline/70 px-3 py-1 text-[11px] text-ink-dim">
        <span>{query ? '搜索结果' : '名称 / 代码'}</span><span className="w-20 text-right">最新</span>
        <span className="w-16 text-right">涨跌</span><span className="w-8 text-right">自选</span>
      </div>

      <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto">
        {query ? (
          results === null || searching ? (
            <p className="px-3 py-8 text-center text-xs text-ink-dim">搜索中…</p>
          ) : results!.length === 0 ? (
            <p className="px-3 py-8 text-center text-xs leading-6 text-ink-dim">
              没有匹配「{query}」的标的。<br />可试 6 位代码、拼音首字母（gzmt）或名称关键词。
            </p>
          ) : results!.map((item) => (
            <Row key={item.secid} item={item} selected={selected} inWatch={watchSet.has(item.secid)} compact={compact}
              onPick={onPick} onToggleWatch={onToggleWatch} />
          ))
        ) : (
          <>
            {rows.length === 0 && (
              <p className="px-3 py-8 text-center text-xs leading-6 text-ink-dim">
                {filter === 'watch' ? '还没有自选标的：搜索后点右侧的 ☆ 即可加入'
                  : filter === 'held' ? '暂无持仓，先下一笔委托' : '行情加载中…'}
              </p>
            )}
            {rows.map((quote) => (
              <Row key={quote.secid} item={{ ...quote, fromList: true }} selected={selected} inWatch={watchSet.has(quote.secid)} compact={compact}
                onPick={(item) => onSelect(item.secid)} onToggleWatch={onToggleWatch} />
            ))}
          </>
        )}
      </div>
    </div>
  );
}

function Row({ item, selected, inWatch, compact, onPick, onToggleWatch }: {
  item: SearchRow | (Quote & { fromList?: boolean });
  selected: string;
  inWatch: boolean;
  compact?: boolean;
  onPick: (item: SearchRow) => void;
  onToggleWatch: (item: { secid: string; code: string; name: string; kind: string }) => void;
}) {
  const quote = item as Partial<Quote>;
  const live = typeof quote.last === 'number' && quote.last > 0;
  const pct = quote.pct ?? 0;
  const tick = quote.tick ?? (item.kind === 'etf' ? 1_000 : 10_000);
  return (
    <div className={`grid grid-cols-[1fr_auto_auto_auto] items-center gap-2 border-b border-hairline/40 px-3 text-xs transition hover:bg-raised ${compact ? 'py-1' : 'py-1.5'} ${selected === item.secid ? 'bg-raised' : ''}`}>
      <button type="button" className="min-w-0 text-left" onClick={() => onPick(item)}>
        <span className="block truncate">{item.name}
          {quote.sealedUp && <em className="ml-1 not-italic text-[10px] text-up">涨停</em>}
          {quote.sealedDown && <em className="ml-1 not-italic text-[10px] text-down">跌停</em>}
          {item.kind === 'index' && <em className="ml-1 not-italic text-[10px] text-ink-dim">指数</em>}
        </span>
        <span className={`num block text-[10px] text-ink-dim ${compact ? 'truncate' : ''}`}>
          {item.code}{live && quote.amount && !compact ? ` · ${(quote.amount / 1e8).toFixed(2)}亿` : ''}
        </span>
      </button>
      <span className={`num w-20 text-right ${live ? tone(pct) : 'text-ink-dim'}`}>{live ? priceText(quote.last as number, tick) : '—'}</span>
      <span className={`num w-16 text-right ${live ? tone(pct) : 'text-ink-dim'}`}>{live ? percent(pct) : '—'}</span>
      <button type="button" title={inWatch ? '移出自选' : '加入自选'}
        aria-label={inWatch ? `将 ${item.name} 移出自选` : `将 ${item.name} 加入自选`}
        onClick={() => onToggleWatch({ secid: item.secid, code: item.code, name: item.name, kind: item.kind })}
        className={`w-8 text-center text-sm leading-none ${inWatch ? 'text-primary' : 'text-ink-dim hover:text-foreground'}`}>
        {inWatch ? '★' : '☆'}
      </button>
    </div>
  );
}

type Trends = { name: string; preClose: number; points: { t: string; price: number; volume: number; avg: number }[] };
type Bars = { day: string; open: number; close: number; high: number; low: number; volume: number }[];

export function DetailPanel({ quote, compact = false, onToast }: { quote: Quote | null; compact?: boolean; onToast: (message: string) => void }) {
  const [kind, setKind] = useState<'trends' | 'kline'>('trends');
  const [trends, setTrends] = useState<Trends | null>(null);
  const [bars, setBars] = useState<Bars | null>(null);
  const [loading, setLoading] = useState(false);
  const cache = useRef(new Map<string, { at: number; data: unknown }>());

  useEffect(() => {
    if (!quote) return;
    let cancelled = false;
    setLoading(true);
    const key = `${quote.secid}:${kind}`;
    const hit = cache.current.get(key);
    if (hit && Date.now() - hit.at < 30_000) {
      if (kind === 'trends') setTrends(hit.data as Trends); else setBars(hit.data as Bars);
      setLoading(false);
      return;
    }
    void api<{ series: Trends | Bars }>('chart', { secid: quote.secid, kind, count: kind === 'kline' ? 160 : undefined }, true)
      .then((result) => {
        if (cancelled) return;
        cache.current.set(key, { at: Date.now(), data: result.series });
        if (kind === 'trends') setTrends(result.series as Trends); else setBars(result.series as Bars);
      })
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

  const full = [
    ['今开', priceText(quote.open ?? 0, quote.tick), tone((quote.open ?? 0) - quote.prevClose)],
    ['最高', priceText(quote.high ?? 0, quote.tick), tone((quote.high ?? 0) - quote.prevClose)],
    ['最低', priceText(quote.low ?? 0, quote.tick), tone((quote.low ?? 0) - quote.prevClose)],
    ['昨收', priceText(quote.prevClose, quote.tick), 'text-muted-foreground'],
    ['涨停', priceText(quote.limitUp, quote.tick), 'text-up'],
    ['跌停', priceText(quote.limitDown, quote.tick), 'text-down'],
    ['成交量', quote.kind === 'index' ? '—' : `${(quote.volume / 1e4).toFixed(1)}万手`, 'text-muted-foreground'],
    ['成交额', quote.amount > 0 ? `${(quote.amount / 1e8).toFixed(2)}亿` : '—', 'text-muted-foreground'],
    ['换手率', quote.turnover === null ? '—' : `${quote.turnover.toFixed(2)}%`, 'text-muted-foreground'],
    ['总市值', quote.marketCap === null ? '—' : `${(quote.marketCap / 1e8).toFixed(0)}亿`, 'text-muted-foreground'],
  ] as const;
  // 手机上只留一行四项，其余高度全部让给图形
  const cells = compact
    ? ([
      ['昨收', priceText(quote.prevClose, quote.tick), 'text-muted-foreground'],
      ['最高', priceText(quote.high ?? 0, quote.tick), tone((quote.high ?? 0) - quote.prevClose)],
      ['最低', priceText(quote.low ?? 0, quote.tick), tone((quote.low ?? 0) - quote.prevClose)],
      ['成交额', quote.amount > 0 ? `${(quote.amount / 1e8).toFixed(2)}亿` : '—', 'text-muted-foreground'],
    ] as const)
    : full;

  return (
    <div className="flex h-full flex-col rounded-lg border border-hairline bg-panel">
      <header className="flex flex-wrap items-end gap-x-6 gap-y-2 border-b border-hairline px-4 py-3">
        <div>
          <h2 className="text-base">{quote.name}<span className="num ml-2 text-xs text-ink-dim">{quote.code}</span></h2>
          <p className="text-[11px] text-ink-dim">沪深实时行情 · 涨跌停幅度 {percent(quote.limitRatio * 100, 0)} · 股票 T+1 交收</p>
        </div>
        <div className={`num flex items-baseline gap-3 ${tone(quote.pct)}`}>
          <span className={`leading-none ${compact ? 'text-2xl' : 'text-3xl'}`}>{priceText(quote.last, quote.tick)}</span>
          <span className="text-sm">{percent(quote.pct)}</span>
        </div>
        <div className="ml-auto flex gap-1 rounded bg-muted/60 p-1 text-xs">
          {(['trends', 'kline'] as const).map((value) => (
            <button key={value} type="button" onClick={() => setKind(value)} aria-pressed={kind === value}
              className={`rounded px-3 py-1 ${kind === value ? 'bg-raised text-primary' : 'text-muted-foreground'}`}>
              {value === 'trends' ? '分时' : '日 K'}
            </button>
          ))}
        </div>
      </header>

      <div className={`grid gap-x-4 gap-y-1 border-b border-hairline/70 px-4 text-[11px] ${compact ? 'grid-cols-4 py-1' : 'grid-cols-5 py-2 gap-y-1'}`} style={compact ? { columnGap: '0.5rem' } : undefined}>
        {cells.map(([label, value, className]) => (
          <div key={label} className="flex flex-col">
            <span className="text-ink-dim">{label}</span>
            <span className={`num ${className}`}>{value}</span>
          </div>
        ))}
      </div>

      <div className="min-h-0 flex-1 p-2">
        {loading && !trends && !bars && <p className="p-8 text-center text-xs text-ink-dim">图表加载中…</p>}
        {kind === 'trends'
          ? <TrendChart points={trends?.points ?? []} prevClose={quote.prevClose} quote={quote} />
          : <CandleChart bars={bars ?? []} />}
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

