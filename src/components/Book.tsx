import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { EquityCurve, PriceCell } from './charts';
import {
  MARKET_NAME, SIDE_LABEL, STATUS_LABEL, clockTime, dayTime, isCapitalSide, marketOfSecid, money, percent, priceText,
  ratioText, shares, tickOfSecid, tone,
  type Account, type Currency, type Lines, type Market, type OrderRow, type SideView, type SyncResponse, type TradeRow,
} from '../format';

type Panel = 'position' | 'order' | 'fill' | 'risk' | 'note';
const BUY_SIDE_SET = new Set(['buy', 'margin_buy', 'cover_buy']);

const PANELS: { key: Panel; label: string }[] = [
  { key: 'position', label: '持仓' },
  { key: 'order', label: '委托' },
  { key: 'fill', label: '成交' },
  { key: 'risk', label: '风控与排行' },
  { key: 'note', label: '通知' },
];

export function Book({ account, orders, trades, events, lines, curve, leader, startCash, today, market = 'cn', side, combined, onSelect, onCancel }: {
  account: Account | null;
  orders: OrderRow[];
  trades: TradeRow[];
  events: { kind: string; message: string; at: string }[];
  lines: Lines;
  curve: { day: string; netAssets: number; totalAssets: number; totalDebt: number }[];
  leader: { name: string; ret: number; netAssets: number; mine: boolean }[];
  startCash: number;
  today: string;
  market?: Market;
  side?: SideView | null;
  combined?: SyncResponse['combined'] | null;
  onSelect: (secid: string) => void;
  onCancel: (id: string) => void;
}) {
  const cur: Currency = account?.currency ?? (market === 'us' ? 'USD' : 'CNY');
  const [panel, setPanel] = useState<Panel>('position');
  const count = panel === 'order' ? orders.length : panel === 'fill' ? trades.length
    : panel === 'note' ? events.length : account?.positions.length ?? 0;

  return (
    <div className="panel flex h-full flex-col overflow-hidden">
      <header className="flex shrink-0 items-center gap-1 border-b border-hairline px-2 py-1">
        {PANELS.map((item) => (
          <button key={item.key} type="button" onClick={() => setPanel(item.key)} aria-selected={panel === item.key}
            className={`relative rounded px-2.5 py-1.5 text-[0.8125rem] transition-colors duration-75 active:translate-y-px ${panel === item.key
              ? 'text-primary after:absolute after:inset-x-2 after:-bottom-[5px] after:h-0.5 after:rounded-full after:bg-primary'
              : 'text-muted-foreground hover:text-foreground'}`}>
            {item.label}
            {item.key !== 'risk' && (
              <span className="num ml-1 text-[0.6875rem] text-ink-dim">
                {item.key === 'position' ? (account?.positions.length ?? 0)
                  : item.key === 'order' ? orders.length : item.key === 'fill' ? trades.length : events.length}
              </span>
            )}
          </button>
        ))}
        <span className="num ml-auto hidden pr-2 text-[0.75rem] text-ink-dim lg:inline">
          {/* 本市场净资产用本市场币种，另一个市场只剩一条摘要，切过去才展开 */}
          {MARKET_NAME[market]}净资产 {money(account?.netAssets ?? 0, cur)} · 杠杆 {account?.leverage ? `${account.leverage.toFixed(2)}×` : '—'}
          {side ? ` · ${MARKET_NAME[side.market]} ${money(side.netAssets, side.currency)}` : ''}
        </span>
      </header>

      <div className="scrollbar-thin min-h-0 flex-1 overflow-auto lg:overflow-y-auto lg:overflow-x-hidden">
        {count === 0 && panel !== 'risk' && (
          <p className="px-4 py-10 text-center text-xs text-ink-dim">
            {panel === 'position' ? '暂无持仓' : panel === 'order' ? '当前没有未了结委托'
              : panel === 'fill' ? '还没有成交记录' : '暂无风控通知（触发预警时在此显示）'}
          </p>
        )}

        {panel === 'risk' ? (
          <Risk account={account} curve={curve} leader={leader} startCash={startCash} lines={lines} cur={cur}
            market={market} side={side} combined={combined} />
        )
          : panel === 'position' ? <Positions account={account} cur={cur} onSelect={onSelect} />
            : panel === 'order' ? <Orders orders={orders} today={today} onCancel={onCancel} />
              : panel === 'fill' ? <Fills trades={trades} cur={cur} />
                : <Notes events={events} />}
      </div>
    </div>
  );
}

const minWidth = (cols: string[]) => ({ minWidth: `${cols.length * 5.5}rem` });

function Head({ cols }: { cols: string[] }) {
  return (
    <div className="sticky top-0 z-10 grid gap-2 border-b border-hairline bg-surface-1 px-3 py-1.5 text-[0.7188rem] tracking-[0.04em] text-ink-dim"
      style={{ ...minWidth(cols), gridTemplateColumns: cols.map(() => 'minmax(0,1fr)').join(' ') }}>
      {cols.map((label) => <span key={label}>{label}</span>)}
    </div>
  );
}

function Positions({ account, cur, onSelect }: { account: Account | null; cur: Currency; onSelect: (secid: string) => void }) {
  const us = marketOfSecid(account?.positions[0]?.symbol) === 'us';
  const cols = ['名称/方向', '持仓', us ? '可用(T+0)' : '可用(T+1)', '成本', '现价', '市值', '浮动盈亏', '当日盈亏'];
  return (
    <div>
      <Head cols={cols} />
      {(account?.positions ?? []).map((position) => (
        <button key={`${position.symbol}-${position.side}`} type="button" onClick={() => onSelect(position.symbol)}
          className={`dense-row grid w-full gap-2 border-b border-hairline/40 px-3 text-left text-[0.8125rem] transition-colors duration-75 hover:bg-surface-2 active:bg-surface-3 ${position.side === 'long' ? 'shadow-[inset_2px_0_0_var(--up)]' : 'shadow-[inset_2px_0_0_var(--down)]'}`}
          style={{ ...minWidth(cols), gridTemplateColumns: cols.map(() => 'minmax(0,1fr)').join(' ') }}>
          <span className="min-w-0">
            <span className="block truncate">{position.name}</span>
            <span className="num text-[0.6875rem] text-ink-dim">
              {position.code} · {position.side === 'long' ? '多头' : '融券空头'}
              {position.collateral ? ` · 担保物 ${money(position.collateral, cur)}` : ''}
            </span>
          </span>
          <span className="num">{shares(position.qty)}</span>
          <span className={`num ${position.avail === 0 ? 'text-up' : ''}`}>{shares(position.avail)}</span>
          <span className="num">{priceText(position.avgCost, tickOfSecid(position.symbol, position.kind))}</span>
          <PriceCell value={position.price} tick={tickOfSecid(position.symbol, position.kind)} className={tone(position.pct)} />
          <span className="num">{money(position.value, cur)}</span>
          <span className={`num ${tone(position.pnl)}`}>
            {money(position.pnl, cur)}<span className="ml-1 text-[0.6875rem]">{percent(position.pnlPct)}</span>
          </span>
          <span className={`num ${tone(position.dayPnl)}`}>{money(position.dayPnl, cur)}</span>
        </button>
      ))}
    </div>
  );
}

function Orders({ orders, today, onCancel }: { orders: OrderRow[]; today: string; onCancel: (id: string) => void }) {
  const cols = ['时间', '标的', '方向', '杠杆', '数量', '委托价', '状态', '备注'];
  return (
    <div>
      <Head cols={cols} />
      {orders.map((order) => (
        <div key={order.id} className="dense-row grid items-center gap-2 border-b border-hairline/40 px-3 text-xs"
          style={{ ...minWidth(cols), gridTemplateColumns: cols.map(() => 'minmax(0,1fr)').join(' ') }}>
          <span className="num text-ink-dim">{clockTime(order.created_at)}</span>
          <span className="truncate">{order.name}<span className="num ml-1 text-[0.6875rem] text-ink-dim">{order.code}</span></span>
          <span className={order.side.includes('short') || order.side === 'cover_buy' ? 'text-down' : 'text-foreground'}>
            {SIDE_LABEL[order.side] ?? order.side}
          </span>
          <span className="num">{order.leaf > 1 ? `${order.leaf}×` : '—'}</span>
          <span className="num">{shares(order.qty)}</span>
          <span className="num">{order.limitPrice ? priceText(order.limitPrice, tickOfSecid(order.secid, order.kind)) : '市价'}</span>
          <span className={`chip justify-self-start ${order.status === 'rejected' ? 'border-up/40 bg-up/12 text-up'
            : order.status === 'canceled' ? 'border-hairline text-ink-dim'
              : order.source === 'system' ? 'border-warn/45 bg-warn/12 text-warn' : 'border-info/40 bg-info/12 text-info'}`}>
            {STATUS_LABEL[order.status] ?? order.status}
          </span>
          <span className="flex items-center gap-2">
            <em className="min-w-0 flex-1 truncate not-italic text-[0.75rem] text-ink-dim" title={order.reason}>
              {order.source === 'system' ? '⚠ ' : ''}{order.reason || (order.day > today ? `预埋 · 归属 ${order.day}` : '等待撮合')}
            </em>
            {order.source !== 'system' && order.status === 'open' && (
              <Button size="xs" variant="ghost" className="h-6 shrink-0 px-2 text-[0.75rem]"
                onClick={() => onCancel(order.id)}>撤单</Button>
            )}
          </span>
        </div>
      ))}
    </div>
  );
}

function Fills({ trades, cur }: { trades: TradeRow[]; cur: Currency }) {
  const cols = ['时间', '标的', '方向', '数量', '成交价', '金额', '费用', '杠杆'];
  return (
    <div>
      <Head cols={cols} />
      {trades.map((trade) => {
        const capital = isCapitalSide(trade.side);
        // 每行自带币种：资金调整这类流水可能与当前市场不同池
        const rowCur = trade.currency ?? cur;
        return (
          <div key={trade.id} className="dense-row grid gap-2 border-b border-hairline/40 px-3 text-xs"
            style={{ ...minWidth(cols), gridTemplateColumns: cols.map(() => 'minmax(0,1fr)').join(' ') }}>
            <span className="num text-ink-dim">{dayTime(trade.created_at)}</span>
            <span className="truncate">{trade.name}</span>
            <span className={`chip justify-self-start ${capital ? 'border-primary/40 bg-primary/10 text-primary'
              : BUY_SIDE_SET.has(trade.side) ? 'border-up/35 bg-up/10 text-up' : 'border-down/35 bg-down/10 text-down'}`}>
              {SIDE_LABEL[trade.side] ?? trade.side}
            </span>
            <span className="num">{capital ? '—' : shares(trade.qty)}</span>
            <span className="num">{capital ? '—' : priceText(trade.price, tickOfSecid(trade.secid, trade.kind))}</span>
            <span className={`num ${capital ? (trade.side === 'capital_out' ? 'text-down' : 'text-up') : ''}`}>{money(trade.amount, rowCur)}</span>
            <span className="num text-ink-dim">{money(trade.fee, rowCur)}</span>
            <span className="num">{trade.leaf > 1 ? `${trade.leaf}×` : '—'}</span>
          </div>
        );
      })}
    </div>
  );
}

function Notes({ events }: { events: { kind: string; message: string; at: string }[] }) {
  return (
    <ul className="space-y-1 p-3 text-xs">
      {events.map((event, index) => (
        <li key={`${event.at}-${index}`}
          className={`rounded border px-3 py-2 leading-6 ${event.kind === 'liquidation'
            ? 'border-up/40 bg-up/10 text-up' : event.kind === 'call' ? 'border-primary/40 bg-primary/10 text-primary' : 'border-hairline text-muted-foreground'}`}>
          <span className="num mr-2 text-[0.6875rem] opacity-70">{clockTime(event.at)}</span>
          {event.message}
        </li>
      ))}
    </ul>
  );
}

function Risk({ account, curve, leader, startCash, lines, cur, market, side, combined }: {
  account: Account | null;
  curve: { day: string; netAssets: number }[];
  leader: { name: string; ret: number; netAssets: number; mine: boolean }[];
  startCash: number;
  lines: Lines;
  cur: Currency;
  market: Market;
  side?: SideView | null;
  combined?: SyncResponse['combined'] | null;
}) {
  const ratio = account?.guaranteeRatio ?? null;
  const ret = account && startCash > 0 ? account.netAssets / startCash - 1 : 0;
  // 合并口径才是「我到底赚了多少」：两市折人民币，本金也按同一汇率合并
  const base = combined?.startCash ?? 0;
  const combinedRet = combined && base > 0 ? combined.netAssets / base - 1 : null;
  // 刻度区间跟着挂牌线走：美股开仓线 200%，写死 260% 会把阶梯线挤出图外
  const from = 1.1;
  const to = Math.max(2.6, lines.open + 0.5);
  const span = to - from;
  const gauge = ratio === null ? null : Math.max(0, Math.min(1, (ratio - from) / span));
  const at = (value: number) => `${((value - from) / span) * 100}%`;

  return (
    <div className="grid gap-4 p-4 lg:grid-cols-[1.2fr_1fr]">
      <section className="space-y-3">
        <h3 className="text-xs tracking-wide text-muted-foreground">
          {MARKET_NAME[market]}维持担保比例
          <span className="num ml-2 text-[0.6875rem] text-ink-dim">
            平仓 {(lines.liquid * 100).toFixed(0)}% / 追保 {(lines.call * 100).toFixed(0)}% / 预警 {(lines.warn * 100).toFixed(0)}% / 开仓 {(lines.open * 100).toFixed(0)}%
          </span>
        </h3>
        <div className="flex items-baseline gap-3">
          <p className={`num text-3xl ${ratio === null ? 'text-muted-foreground' : ratio < lines.liquid ? 'text-up' : ratio < lines.warn ? 'text-primary' : 'text-down'}`}>
            {ratioText(ratio)}
          </p>
          <p className="text-[0.75rem] text-ink-dim">
            {ratio === null ? '该市场当前无负债，普通现货交易'
              : ratio < lines.liquid ? `已低于平仓线 ${(lines.liquid * 100).toFixed(0)}%，系统正在强制平仓`
                : ratio < lines.call ? `低于追保线 ${(lines.call * 100).toFixed(0)}%，请尽快追加担保物`
                  : ratio < lines.warn ? `低于预警线 ${(lines.warn * 100).toFixed(0)}%，注意杠杆风险` : '担保充足，可继续融资买入'}
          </p>
        </div>
        <div className="relative h-2 overflow-hidden rounded bg-muted" role="img"
          aria-label={ratio === null ? '无负债' : `维持担保比例 ${(ratio * 100).toFixed(1)}%`}>
          {gauge !== null && <div className="absolute inset-y-0 left-0 bg-current opacity-70" style={{ width: `${gauge * 100}%` }} />}
          {[lines.liquid, lines.call, lines.warn].map((line, index) => (
            <span key={index} className="absolute inset-y-0 w-px bg-foreground/30" style={{ left: at(line) }} />
          ))}
        </div>
        <div className="flex justify-between text-[0.6875rem] text-ink-dim">
          <span>{(from * 100).toFixed(0)}%</span>
          <span>平仓 {(lines.liquid * 100).toFixed(0)}%</span>
          <span>追保 {(lines.call * 100).toFixed(0)}%</span>
          <span>预警 {(lines.warn * 100).toFixed(0)}%</span>
          <span>{(to * 100).toFixed(0)}%+</span>
        </div>

        <dl className="grid grid-cols-2 gap-x-5 gap-y-1.5 pt-1 text-xs sm:grid-cols-3">
          <Cell label="总资产" value={money(account?.totalAssets ?? 0, cur)} />
          <Cell label="负债合计" value={money(account?.totalDebt ?? 0, cur)} warn={(account?.totalDebt ?? 0) > 0} />
          <Cell label="净资产" value={money(account?.netAssets ?? 0, cur)} />
          <Cell label="可用资金" value={money(account?.cash ?? 0, cur)} />
          <Cell label="持仓市值" value={money(account?.longValue ?? 0, cur)} />
          <Cell label="融券担保物" value={money(account?.collateral ?? 0, cur)} />
          <Cell label="融资本金" value={money(account?.marginPrincipal ?? 0, cur)} />
          <Cell label="融资利息" value={money(account?.marginInterest ?? 0, cur)} />
          <Cell label="融券市值" value={money(account?.securityBalance ?? 0, cur)} />
          <Cell label="当日盈亏" value={money(account?.todayPnl ?? 0, cur)} toneValue={account?.todayPnl ?? 0} />
          <Cell label="浮动盈亏" value={money(account?.floatPnl ?? 0, cur)} toneValue={account?.floatPnl ?? 0} />
          <Cell label="累计手续费" value={money(account?.feesPaid ?? 0, cur)} />
          <Cell label={`${MARKET_NAME[market]}收益率`} value={percent(ret * 100)} toneValue={ret} />
          <Cell label="成交笔数" value={String(account?.tradeCount ?? 0)} />
          <Cell label="账户杠杆" value={account?.leverage ? `${account.leverage.toFixed(2)}×` : '—'} />
        </dl>
        {/* 两市各一套账，最后再按当日汇率合并成人民币：这样切市场看得见本市场的数，看合并又不漏另一边 */}
        <dl className="grid grid-cols-2 gap-x-5 gap-y-1.5 border-t border-hairline pt-2 text-xs sm:grid-cols-4">
          <Cell label="人民币净资产" value={money(market === 'cn' ? account?.netAssets ?? 0 : side?.netAssets ?? 0, 'CNY')} />
          <Cell label="美元净资产" value={money(market === 'us' ? account?.netAssets ?? 0 : side?.netAssets ?? 0, 'USD')} />
          <Cell label="合并净资产（折人民币）" value={money(combined?.netAssets ?? 0, 'CNY')} />
          <Cell label="合并收益率" value={combinedRet === null ? '—' : percent(combinedRet * 100)} toneValue={combinedRet ?? 0} />
        </dl>
      </section>

      <section className="space-y-4">
        <div>
          <h3 className="mb-2 text-xs tracking-wide text-muted-foreground">净值曲线（两市合并，折人民币）</h3>
          <EquityCurve points={curve} baseline={base > 0 ? base : startCash} height={170} />
        </div>
        <div>
          <h3 className="mb-2 text-xs tracking-wide text-muted-foreground">今日盈亏榜</h3>
          {leader.length === 0 ? (
            <p className="rounded border border-dashed border-hairline px-3 py-6 text-center text-[0.75rem] leading-5 text-ink-dim">
              排行榜在每日日结后生成。多次同步会持续更新当日快照。
            </p>
          ) : (
            <ol className="space-y-1 text-xs">
              {leader.map((row, index) => (
                <li key={`${row.name}-${index}`}
                  className={`flex items-center gap-2 rounded px-2 py-1.5 ${row.mine ? 'bg-primary/10 text-primary' : ''}`}>
                  <span className="num w-6 text-ink-dim">{index + 1}</span>
                  <span className="min-w-0 flex-1 truncate">{row.name}{row.mine && '（我）'}</span>
                  <span className="num">{money(row.netAssets, 'CNY')}</span>
                  <span className={`num w-16 text-right ${tone(row.ret)}`}>{percent(row.ret * 100)}</span>
                </li>
              ))}
            </ol>
          )}
        </div>
      </section>
    </div>
  );
}

function Cell({ label, value, warn, toneValue }: { label: string; value: string; warn?: boolean; toneValue?: number }) {
  return (
    <div className="flex flex-col">
      <span className="text-[0.6875rem] text-ink-dim">{label}</span>
      <span className={`num ${toneValue !== undefined ? tone(toneValue) : warn ? 'text-primary' : ''}`}>{value}</span>
    </div>
  );
}
