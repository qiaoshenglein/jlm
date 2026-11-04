import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ApiError, api } from '../api';
import {
  money, percent, priceText, ratioText, shares, tone, Y,
  type Account, type Preview, type Quote,
} from '../format';

const DIRS = [
  { side: 'buy', label: '担保品买入', hint: '用自有资金买入，T+1 可卖' },
  { side: 'sell', label: '担保品卖出', hint: '卖出自有持仓提取资金' },
  { side: 'margin_buy', label: '融资买入', hint: '借钱加杠杆做多' },
  { side: 'sell_repay', label: '卖券还款', hint: '卖出并偿还融资负债' },
  { side: 'short_sell', label: '融券卖出', hint: '借券做空' },
  { side: 'cover_buy', label: '买券还券', hint: '买回归还融券负债' },
] as const;

const LEAVE_LABEL = (leaf: number) => (leaf === 1 ? '1×' : `${leaf}×`);

export function Ticket({ quote, account, held, onFilled, onResolve, onDuplicate, resolving }: {
  quote: Quote | null;
  account: Account | null;
  held: Quote[];
  onFilled: (message: string) => void;
  onResolve: (secid: string) => Promise<Quote | null>;
  onDuplicate: (confirm: () => void) => void;
  resolving: boolean;
}) {
  const [side, setSide] = useState<string>('buy');
  const [mode, setMode] = useState<'market' | 'limit'>('market');
  const [qtyText, setQtyText] = useState('1000');
  const [priceText_, setPriceText] = useState('');
  const [leaf, setLeaf] = useState(2);
  const [query, setQuery] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const timer = useRef<number | null>(null);

  const leveraged = side === 'margin_buy' || side === 'short_sell';
  const buying = side === 'buy' || side === 'margin_buy';
  const indexOnly = quote?.kind === 'index'; // 指数不可直接交易，不再发注定被拒的试算请求
  const qty = Math.trunc(Number(qtyText) || 0);
  const activeDir = DIRS.find((dir) => dir.side === side);
  const position = account?.positions.find((p) => p.symbol === quote?.secid);
  const refPrice = mode === 'limit' && priceText_ ? Math.round(Number(priceText_) * Y) : quote?.last ?? 0;

  // 数量快捷键：按可用资金、杠杆倍数与当前价折算，服务端仍会做最终校验
  const maxBuy = useMemo(() => {
    if (!account || !refPrice) return 0;
    const own = leveraged ? account.cash / leaf : account.cash;
    const unit = leveraged ? refPrice / leaf : refPrice;
    if (unit <= 0) return 0;
    return Math.floor((own * 0.995) / unit / 100) * 100;
  }, [account, refPrice, leaf, leveraged]);

  const sellable = position && (side === 'sell' || side === 'sell_repay') ? position.avail
    : position && side === 'cover_buy' ? position.qty : 0;

  // 试算走「先留旧值、拿到新值再替换」：面板高度恒定，按钮不会在点击瞬间被顶走
  const secid = quote?.secid ?? '';
  const lastPrice = quote?.last ?? 0;
  const seq = useRef(0);
  useEffect(() => {
    if (!secid || qty <= 0 || indexOnly) { setPreview(null); return; }
    if (timer.current) window.clearTimeout(timer.current);
    const request = ++seq.current;
    timer.current = window.setTimeout(async () => {
      try {
        const result = await api<{ preview: Preview }>('preview', {
          side, secid, qty, mode, leaf: leveraged ? leaf : 1,
          limitPrice: mode === 'limit' ? priceText_ : null,
        }, true);
        if (request === seq.current) { setPreview(result.preview); setError(''); }
      } catch (caught) {
        if (request !== seq.current) return;
        if (caught instanceof ApiError && !['network_error', 'invalid_response', 'server_error', 'read_failed'].includes(caught.code)) {
          setError(caught.message);
        }
      }
    }, 420);
    return () => { if (timer.current) window.clearTimeout(timer.current); };
  }, [secid, lastPrice, side, qty, mode, leaf, priceText_, leveraged, indexOnly]);

  async function submit(confirmDuplicate = false) {
    if (!quote || busy) return;
    setBusy(true);
    setError('');
    try {
      const result = await api<{ order: { status: string }; queued?: boolean }>('order', {
        side, secid: quote.secid, qty, mode, leaf: leveraged ? leaf : 1,
        limitPrice: mode === 'limit' ? priceText_ : null, confirmDuplicate,
      });
      const queued = result.queued ? '（非交易时段，已作为下一交易日预埋委托）' : '';
      onFilled(`${activeDir?.label ?? side} ${shares(qty)} ${quote.name} 已受理${queued}`);
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === 'duplicate_order') {
        setError('');
        onDuplicate(() => void submit(true));
      } else {
        setError(caught instanceof ApiError ? caught.message : '下单失败');
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex h-full flex-col rounded-lg border border-hairline bg-panel">
      <header className="flex items-center justify-between border-b border-hairline px-4 py-2.5">
        <h2 className="text-sm font-medium tracking-wide">下单</h2>
        <span className="num text-[11px] text-ink-dim">虚拟资金</span>
      </header>

      <div className="scrollbar-thin min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
        <div className="flex gap-2">
          <Input aria-label="标的代码或 6 位数字" value={query} placeholder="输入 6 位代码后回车，如 600519"
            maxLength={8} className="h-8 text-sm"
            onInput={(event) => setQuery((event.target as HTMLInputElement).value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && /^\d{6}$/.test(query.trim())) {
                void onResolve(query.trim());
                setQuery('');
              }
            }} />
          <Button size="sm" variant="outline" className="h-8 shrink-0" disabled={resolving || !/^\d{6}$/.test(query.trim())}
            onClick={() => void onResolve(query.trim())}>查找</Button>
        </div>

        {quote ? (
          <div className="flex items-baseline justify-between rounded border border-hairline/70 bg-raised px-3 py-2">
            <div>
              <p className="text-sm">{quote.name}<span className="num ml-2 text-xs text-ink-dim">{quote.code}</span></p>
              <p className="text-[11px] text-ink-dim">
                {quote.kind === 'etf' ? '场内 ETF' : '股票'} · 涨跌停 {percent(quote.limitRatio * 100, 0)} · T+1
              </p>
            </div>
            <p className={`num text-lg ${tone(quote.pct)}`}>{priceText(quote.last, quote.tick)}
              <span className="ml-2 text-xs">{percent(quote.pct)}</span></p>
          </div>
        ) : (
          <p className="rounded border border-dashed border-hairline px-3 py-6 text-center text-xs text-ink-dim">
            从左侧行情列表选择标的，或输入 6 位代码
          </p>
        )}

        <div role="group" aria-label="交易方向" className="grid grid-cols-3 gap-1.5">
          {DIRS.map((dir) => (
            <button key={dir.side} type="button" title={dir.hint} disabled={!quote}
              onClick={() => { setSide(dir.side); if (dir.side !== 'margin_buy' && dir.side !== 'short_sell') setLeaf(1); else setLeaf((v) => v || 2); }}
              aria-pressed={side === dir.side}
              className={`rounded border px-2 py-2 text-xs transition disabled:opacity-40 ${side === dir.side
                ? 'border-primary/70 bg-primary/15 text-primary'
                : 'border-hairline text-muted-foreground hover:border-input hover:text-foreground'}`}>
              {dir.label}
            </button>
          ))}
        </div>
        <p className="text-[11px] leading-5 text-ink-dim">{activeDir?.hint}</p>

        <div role="group" aria-label="委托类型" className="flex gap-1.5">
          {(['market', 'limit'] as const).map((value) => (
            <button key={value} type="button" onClick={() => setMode(value)} aria-pressed={mode === value}
              className={`flex-1 rounded border py-1.5 text-xs ${mode === value ? 'border-primary/70 text-primary' : 'border-hairline text-muted-foreground'}`}>
              {value === 'market' ? '市价（最新价撮合）' : '限价当日有效'}
            </button>
          ))}
        </div>

        {mode === 'limit' && quote && (
          <div className="space-y-1.5">
            <label className="text-[11px] text-muted-foreground" htmlFor="limit-price">委托价格</label>
            <Input id="limit-price" className="num h-8" inputMode="decimal" value={priceText_}
              placeholder={priceText(quote.last, quote.tick)}
              onInput={(event) => setPriceText((event.target as HTMLInputElement).value)} />
            <div className="flex gap-1.5 text-[11px]">
              <button type="button" className="rounded border border-hairline px-2 py-1 hover:border-input"
                onClick={() => setPriceText((quote.last / Y).toFixed(quote.tick === 1_000 ? 3 : 2))}>最新</button>
              <button type="button" className="rounded border border-hairline px-2 py-1 text-up hover:border-input"
                onClick={() => setPriceText((quote.limitUp / Y).toFixed(quote.tick === 1_000 ? 3 : 2))}>涨停 {priceText(quote.limitUp, quote.tick)}</button>
              <button type="button" className="rounded border border-hairline px-2 py-1 text-down hover:border-input"
                onClick={() => setPriceText((quote.limitDown / Y).toFixed(quote.tick === 1_000 ? 3 : 2))}>跌停 {priceText(quote.limitDown, quote.tick)}</button>
            </div>
          </div>
        )}

        <div className="space-y-1.5">
          <label className="text-[11px] text-muted-foreground" htmlFor="order-qty">
            委托数量（股，100 整数倍，上限 100 万）
          </label>
          <Input id="order-qty" className="num h-8" inputMode="numeric" value={qtyText}
            onInput={(event) => setQtyText((event.target as HTMLInputElement).value.replace(/[^\d]/g, ''))} />
          <div className="flex gap-1.5 text-[11px]">
            {(buying
              ? ([['25%', maxBuy * 0.25], ['50%', maxBuy * 0.5], ['75%', maxBuy * 0.75], ['最大', maxBuy]] as [string, number][])
              : ([['可用', sellable], ['一半', sellable * 0.5], ['全部', sellable]] as [string, number][])
            ).map(([label, value]) => (
              <button key={label} type="button" disabled={Math.floor((value || 0) / 100) * 100 < 100}
                className="flex-1 rounded border border-hairline px-2 py-1 text-ink-dim hover:border-input hover:text-foreground disabled:opacity-35"
                onClick={() => setQtyText(String(Math.floor((value || 0) / 100) * 100))}>
                {label}
              </button>
            ))}
          </div>
        </div>

        <div className="space-y-1.5">
          <label className="text-[11px] text-muted-foreground">
            杠杆倍数（保证金比例 {((1 / (leveraged ? leaf : 1)) * 100).toFixed(0)}%）
            {!leveraged && <span className="ml-1 text-ink-dim">· 该方向不使用杠杆</span>}
          </label>
          <div role="group" aria-label="杠杆倍数" className="grid grid-cols-5 gap-1.5">
            {[1, 2, 3, 4, 5].map((value) => (
              <button key={value} type="button" disabled={!leveraged && value > 1}
                onClick={() => setLeaf(value)} aria-pressed={(leveraged ? leaf : 1) === value}
                title={!leveraged && value > 1 ? '只有融资买入 / 融券卖出可用杠杆' : undefined}
                className={`num rounded border py-1.5 text-xs disabled:opacity-35 ${
                  (leveraged ? leaf : 1) === value ? 'border-primary/70 bg-primary/15 text-primary' : 'border-hairline text-muted-foreground'}`}>
                {LEAVE_LABEL(value)}
              </button>
            ))}
          </div>
        </div>

        <dl className="space-y-1 rounded border border-hairline/70 bg-raised px-3 py-2 text-xs">
          <Row label="成交金额" value={preview ? `¥${money(preview.amount)}` : '—'} />
          <Row label="费用合计" value={preview ? `¥${money(preview.fee)}（佣金/印花税/过户费）` : '—'} />
          <Row label={leveraged ? '自付保证金' : '占用自有资金'} value={preview ? `¥${money(preview.own)}` : '—'} />
          <Row label={side === 'short_sell' ? '借券卖出所得（冻结为担保物）' : '新增负债'}
            value={preview ? `¥${money(preview.borrow)}` : '—'} />
          <Row label="成交后可用" value={preview ? `¥${money(preview.cashAfter)}` : '—'} />
          <Row label="成交后担保比例" value={preview ? ratioText(preview.ratioAfter) : '—'}
            warn={Boolean(preview && preview.ratioAfter !== null && preview.ratioAfter < 1.5)} />
          <Row label="该持仓强平价" value={preview?.liquidationPrice ? priceText(preview.liquidationPrice, quote?.tick) : '—'} warn={Boolean(preview?.liquidationPrice)} />
          <p className="h-5 text-[11px] leading-5">
            {indexOnly ? <span className="text-primary">指数不可直接交易：改选对应场内 ETF，或在下方输入框输入代码（如 510300）</span>
              : !preview && !error ? <span className="text-ink-dim">{quote ? '试算中…' : '选择标的后自动试算'}</span> : null}
          </p>
        </dl>
      </div>

      {/* 提交区钉在面板底部：内容高度变化、试算刷新、滚动都不会移动它的位置 */}
      <div className="shrink-0 space-y-2 border-t border-hairline px-4 py-3">
        <p className="min-h-5 text-[11px] leading-5 text-up" role="status">{error}</p>
        <Button className="w-full" disabled={!quote || busy || qty <= 0 || indexOnly || Boolean(error)} onClick={() => void submit()}>
          {busy ? '提交中…' : `${activeDir?.label ?? '下单'} ${shares(qty)} 股`}
        </Button>
        <p className="text-[11px] leading-5 text-ink-dim">
          当前可用 ¥{money(account?.cash ?? 0)} · 融资负债 ¥{money(account?.marginBalance ?? 0)} ·
          融券负债 ¥{money(account?.securityBalance ?? 0)}
        </p>
        {held.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[11px] text-ink-dim">持仓速览</span>
            {held.map((item) => (
              <button key={item.secid} type="button" onClick={() => void onResolve(item.code)}
                className={`num rounded border border-hairline px-2 py-1 text-[11px] ${tone(item.pct)} hover:border-input`}>
                {item.name} {percent(item.pct)}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function Row({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-ink-dim">{label}</dt>
      <dd className={`num ${warn ? 'text-up' : ''}`}>{value}</dd>
    </div>
  );
}
