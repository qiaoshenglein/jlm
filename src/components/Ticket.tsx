import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ApiError, api } from '../api';
import {
  money, percent, priceText, ratioText, shares, tone, Y,
  type Account, type Preview, type Quote,
} from '../format';

const DIRS = [
  { side: 'buy', label: '担保品买入', hint: '用自有资金买入，T+1 可卖', group: 'cash' },
  { side: 'sell', label: '担保品卖出', hint: '卖出自有持仓并提取资金', group: 'cash' },
  { side: 'margin_buy', label: '融资买入', hint: '借钱加杠杆做多', group: 'credit' },
  { side: 'sell_repay', label: '卖券还款', hint: '卖出并优先偿还融资负债', group: 'credit' },
  { side: 'short_sell', label: '融券卖出', hint: '借券做空，卖出所得冻结为担保物', group: 'credit' },
  { side: 'cover_buy', label: '买券还券', hint: '买回归还融券负债', group: 'credit' },
] as const;

// A 股惯例：买入类红、卖出类绿，按钮配色与语义一致
export const BUY_SIDES = new Set(['buy', 'margin_buy', 'cover_buy']);

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
  const [pending, setPending] = useState(false);
  const timer = useRef<number | null>(null);

  const leveraged = side === 'margin_buy' || side === 'short_sell';
  const buying = side === 'buy' || side === 'margin_buy';
  const indexOnly = quote?.kind === 'index';
  const buySide = BUY_SIDES.has(side); // 指数不可直接交易，不再发注定被拒的试算请求
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
    if (!secid || qty <= 0 || indexOnly) { setPreview(null); setPending(false); return; }
    if (timer.current) window.clearTimeout(timer.current);
    const request = ++seq.current;
    setPending(true);
    timer.current = window.setTimeout(async () => {
      try {
        const result = await api<{ preview: Preview }>('preview', {
          side, secid, qty, mode, leaf: leveraged ? leaf : 1,
          limitPrice: mode === 'limit' ? priceText_ : null,
        }, true);
        if (request === seq.current) { setPreview(result.preview); setError(''); setPending(false); }
      } catch (caught) {
        if (request !== seq.current) return;
        setPending(false);
        if (caught instanceof ApiError && !['network_error', 'invalid_response', 'server_error', 'read_failed'].includes(caught.code)) {
          setError(caught.message);
        }
      }
    }, 420);
    return () => { if (timer.current) window.clearTimeout(timer.current); };
  }, [secid, lastPrice, side, qty, mode, leaf, priceText_, leveraged, indexOnly]);

  function pickSide(value: string) {
    setSide(value);
    setError('');
    setLeaf(value === 'margin_buy' || value === 'short_sell' ? (leaf > 1 ? leaf : 2) : 1);
  }

  // 手不离键盘：b/s 切方向，1-5 切杠杆，Enter 下单（数量框内同样有效）
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || event.repeat || !quote) return;
      const target = event.target as HTMLElement | null;
      const typing = Boolean(target && (/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) || target.isContentEditable));
      if (event.key === 'Enter') {
        if (typing && target?.id !== 'order-qty') return;
        event.preventDefault();
        void submit();
        return;
      }
      if (typing) return;
      if (event.key === 'b' || event.key === 'B') { pickSide(buySide ? 'sell' : 'buy'); return; }
      if (event.key === 's' || event.key === 'S') { pickSide(buySide ? 'margin_buy' : 'short_sell'); return; }
      if (/^[1-5]$/.test(event.key)) {
        const value = Number(event.key);
        if (leveraged || value === 1) setLeaf(value);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

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
    <div className="panel flex h-full flex-col overflow-hidden">
      <header className="panel-hd shrink-0 justify-between">
        <h2>下单</h2>
        <span className="chip border-hairline text-ink-dim">虚拟资金</span>
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
          <div className={`rounded-md border px-3 py-2 ${buySide ? 'border-up/35 bg-up/8' : 'border-down/35 bg-down/8'}`}>
            <div className="flex items-baseline justify-between gap-2">
              <p className="truncate text-[0.9375rem] font-medium">{quote.name}
                <span className="num ml-2 text-[0.75rem] text-ink-dim">{quote.code}</span></p>
              <p className={`num shrink-0 text-[1.375rem] leading-none ${tone(quote.pct)}`}>{priceText(quote.last, quote.tick)}</p>
            </div>
            <div className="mt-1 flex items-center justify-between gap-2">
              <p className="text-[0.75rem] text-ink-dim">
                {quote.kind === 'etf' ? '场内 ETF' : '股票'} · 涨跌停 {percent(quote.limitRatio * 100, 0)} · T+1 交收
              </p>
              <p className={`num text-[0.8125rem] ${tone(quote.pct)}`}>{percent(quote.pct)}</p>
            </div>
          </div>
        ) : (
          <p className="rounded border border-dashed border-hairline px-3 py-6 text-center text-xs text-ink-dim">
            从左侧行情列表选择标的，或输入 6 位代码
          </p>
        )}

        {([['现货（自有资金）', DIRS.filter((dir) => dir.group === 'cash')],
          ['信用（可用杠杆）', DIRS.filter((dir) => dir.group === 'credit')]] as const).map(([group, list]) => (
          <fieldset key={group} className="space-y-1">
            <legend className="mb-1 text-[0.6875rem] tracking-[0.08em] text-ink-dim">{group}</legend>
            <div role="group" aria-label="交易方向" className="grid grid-cols-2 gap-1.5">
              {list.map((dir) => {
                const isBuy = BUY_SIDES.has(dir.side);
                const on = side === dir.side;
                return (
                  <button key={dir.side} type="button" title={dir.hint} disabled={!quote} onClick={() => pickSide(dir.side)}
                    aria-pressed={on}
                    className={`rounded-md border px-2 py-2 text-left text-[0.8125rem] transition-colors duration-75 active:translate-y-px disabled:opacity-40 ${on
                      ? isBuy ? 'border-up bg-up/14 text-up' : 'border-down bg-down/14 text-down'
                      : 'border-hairline text-muted-foreground hover:border-input hover:text-foreground'}`}>
                    {dir.label}
                  </button>
                );
              })}
            </div>
          </fieldset>
        ))}
        <p className="text-[0.75rem] leading-5 text-ink-dim">{activeDir?.hint}</p>

        <div role="group" aria-label="委托类型" className="flex gap-1.5">
          {(['market', 'limit'] as const).map((value) => (
            <button key={value} type="button" onClick={() => setMode(value)} aria-pressed={mode === value}
              className={`flex-1 rounded border py-1.5 text-xs transition-colors duration-75 active:translate-y-px ${mode === value ? 'border-primary/70 text-primary' : 'border-hairline text-muted-foreground hover:text-foreground'}`}>
              {value === 'market' ? '市价（最新价撮合）' : '限价当日有效'}
            </button>
          ))}
        </div>

        {mode === 'limit' && quote && (
          <div className="space-y-1.5">
            <label className="text-[0.75rem] text-muted-foreground" htmlFor="limit-price">委托价格</label>
            <Input id="limit-price" className="num h-8" inputMode="decimal" value={priceText_}
              placeholder={priceText(quote.last, quote.tick)}
              onInput={(event) => setPriceText((event.target as HTMLInputElement).value)} />
            <div className="flex gap-1.5 text-[0.75rem]">
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
          <label className="text-[0.75rem] text-muted-foreground" htmlFor="order-qty">
            委托数量（股，100 整数倍，上限 100 万）
          </label>
          <Input id="order-qty" className="num h-8" inputMode="numeric" value={qtyText}
            onInput={(event) => setQtyText((event.target as HTMLInputElement).value.replace(/[^\d]/g, ''))} />
          <div className="flex gap-1.5 text-[0.75rem]">
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
          <label className="text-[0.75rem] text-muted-foreground">
            杠杆倍数（保证金比例 {((1 / (leveraged ? leaf : 1)) * 100).toFixed(0)}%）
            {!leveraged && <span className="ml-1 text-ink-dim">· 该方向不使用杠杆</span>}
          </label>
          <div role="group" aria-label="杠杆倍数" className="grid grid-cols-5 gap-1.5">
            {[1, 2, 3, 4, 5].map((value) => (
              <button key={value} type="button" disabled={!leveraged && value > 1}
                onClick={() => setLeaf(value)} aria-pressed={(leveraged ? leaf : 1) === value}
                title={!leveraged && value > 1 ? '只有融资买入 / 融券卖出可用杠杆' : undefined}
                className={`num rounded border py-1.5 text-xs transition-colors duration-75 active:translate-y-px disabled:opacity-35 ${
                  (leveraged ? leaf : 1) === value ? 'border-primary/70 bg-primary/15 text-primary' : 'border-hairline text-muted-foreground hover:border-input hover:text-foreground'}`}>
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
          <p className="flex h-5 items-center gap-2 text-[0.75rem] leading-5">
            {pending && !indexOnly && <span className="skel inline-block h-2 w-14" aria-hidden="true" />}
            {indexOnly ? <span className="text-primary">指数不可直接交易：改选对应场内 ETF，或在下方输入框输入代码（如 510300）</span>
              : !preview && !error ? <span className="text-ink-dim">{quote ? '试算中…' : '选择标的后自动试算'}</span> : null}
          </p>
        </dl>
      </div>

      {/* 提交区钉在面板底部：内容高度变化、试算刷新、滚动都不会移动它的位置 */}
      <div className="shrink-0 space-y-2 border-t border-hairline px-4 py-3">
        <p className="min-h-5 text-[0.75rem] leading-5 text-up" role="status">{error}</p>
        <button type="button" disabled={!quote || busy || qty <= 0 || indexOnly || Boolean(error)} onClick={() => void submit()}
          className={`flex h-11 w-full items-center justify-center gap-2 rounded-md text-[0.875rem] font-semibold transition-[filter,transform,opacity] duration-75
            active:translate-y-px
            disabled:cursor-not-allowed disabled:opacity-45 disabled:active:translate-y-0
            ${buySide ? 'bg-up text-[#20060a] hover:brightness-110' : 'bg-down text-[#04211a] hover:brightness-110'}`}>
          <span>{busy ? '提交中…' : `${activeDir?.label ?? '下单'} ${shares(qty)} 股`}</span>
          {preview && !busy && <span className="num text-[0.75rem] font-normal opacity-80">¥{money(preview.amount)}</span>}
        </button>
        <p className="text-[0.75rem] leading-5 text-ink-dim">
          当前可用 ¥{money(account?.cash ?? 0)} · 融资负债 ¥{money(account?.marginBalance ?? 0)} ·
          融券负债 ¥{money(account?.securityBalance ?? 0)}
        </p>
        {held.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[0.75rem] text-ink-dim">持仓速览</span>
            {held.map((item) => (
              <button key={item.secid} type="button" onClick={() => void onResolve(item.code)}
                className={`num rounded border border-hairline px-2 py-1 text-[0.75rem] ${tone(item.pct)} hover:border-input`}>
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
