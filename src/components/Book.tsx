import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { EquityCurve } from './charts';
import {
  SIDE_LABEL, STATUS_LABEL, clockTime, dayTime, money, percent, priceText, ratioText,
  shares, tone, type Account, type OrderRow, type TradeRow,
} from '../format';

type Panel = 'position' | 'order' | 'fill' | 'risk' | 'note';
const PANELS: { key: Panel; label: string }[] = [
  { key: 'position', label: '持仓' },
  { key: 'order', label: '委托' },
  { key: 'fill', label: '成交' },
  { key: 'risk', label: '风控与排行' },
  { key: 'note', label: '通知' },
];

export function Book({ account, orders, trades, events, curve, leader, startCash, today, onSelect, onCancel }: {
  account: Account | null;
  orders: OrderRow[];
  trades: TradeRow[];
  events: { kind: string; message: string; at: string }[];
  curve: { day: string; netAssets: number; totalAssets: number; totalDebt: number }[];
  leader: { name: string; ret: number; netAssets: number; mine: boolean }[];
  startCash: number;
  today: string;
  onSelect: (secid: string) => void;
  onCancel: (id: string) => void;
}) {
  const [panel, setPanel] = useState<Panel>('position');
  const count = panel === 'order' ? orders.length : panel === 'fill' ? trades.length
    : panel === 'note' ? events.length : account?.positions.length ?? 0;

  return (
    <div className="flex h-full flex-col rounded-lg border border-hairline bg-panel">
      <header className="flex items-center gap-1 border-b border-hairline px-2 py-1.5">
        {PANELS.map((item) => (
          <button key={item.key} type="button" onClick={() => setPanel(item.key)} aria-selected={panel === item.key}
            className={`rounded px-2.5 py-1 text-xs transition ${panel === item.key ? 'bg-raised text-primary' : 'text-muted-foreground hover:text-foreground'}`}>
            {item.label}
            {item.key !== 'risk' && (
              <span className="num ml-1 text-[10px] text-ink-dim">
                {item.key === 'position' ? (account?.positions.length ?? 0)
                  : item.key === 'order' ? orders.length : item.key === 'fill' ? trades.length : events.length}
              </span>
            )}
          </button>
        ))}
        <span className="num ml-auto hidden pr-2 text-[11px] text-ink-dim lg:inline">
          净资产 ¥{money(account?.netAssets ?? 0)} · 杠杆 {account?.leverage ? `${account.leverage.toFixed(2)}×` : '—'}
        </span>
      </header>

      <div className="scrollbar-thin min-h-0 flex-1 overflow-auto lg:overflow-y-auto lg:overflow-x-hidden">
        {count === 0 && panel !== 'risk' && (
          <p className="px-4 py-10 text-center text-xs text-ink-dim">
            {panel === 'position' ? '暂无持仓' : panel === 'order' ? '当前没有未了结委托'
              : panel === 'fill' ? '还没有成交记录' : '暂无风控通知（触发预警时在此显示）'}
          </p>
        )}

        {panel === 'risk' ? <Risk account={account} curve={curve} leader={leader} startCash={startCash} />
          : panel === 'position' ? <Positions account={account} onSelect={onSelect} />
            : panel === 'order' ? <Orders orders={orders} today={today} onCancel={onCancel} />
              : panel === 'fill' ? <Fills trades={trades} />
                : <Notes events={events} />}
      </div>
    </div>
  );
}

const minWidth = (cols: string[]) => ({ minWidth: `${cols.length * 5.5}rem` });

function Head({ cols }: { cols: string[] }) {
  return (
    <div className="grid gap-2 border-b border-hairline/70 px-3 py-1.5 text-[11px] text-ink-dim"
      style={{ ...minWidth(cols), gridTemplateColumns: cols.map(() => 'minmax(0,1fr)').join(' ') }}>
      {cols.map((label) => <span key={label}>{label}</span>)}
    </div>
  );
}

function Positions({ account, onSelect }: { account: Account | null; onSelect: (secid: string) => void }) {
  const cols = ['名称/方向', '持仓', '可用(T+1)', '成本', '现价', '市值', '浮动盈亏', '当日盈亏'];
  return (
    <div>
      <Head cols={cols} />
      {(account?.positions ?? []).map((position) => (
        <button key={`${position.symbol}-${position.side}`} type="button" onClick={() => onSelect(position.symbol)}
          className="grid w-full gap-2 border-b border-hairline/40 px-3 py-2 text-left text-xs hover:bg-raised"
          style={{ ...minWidth(cols), gridTemplateColumns: cols.map(() => 'minmax(0,1fr)').join(' ') }}>
          <span className="min-w-0">
            <span className="block truncate">{position.name}</span>
            <span className="num text-[10px] text-ink-dim">
              {position.code} · {position.side === 'long' ? '多头' : '融券空头'}
              {position.collateral ? ` · 担保物 ¥${money(position.collateral)}` : ''}
            </span>
          </span>
          <span className="num">{shares(position.qty)}</span>
          <span className={`num ${position.avail === 0 ? 'text-up' : ''}`}>{shares(position.avail)}</span>
          <span className="num">{priceText(position.avgCost, position.kind === 'etf' ? 1_000 : 10_000)}</span>
          <span className={`num ${tone(position.pct)}`}>{priceText(position.price, position.kind === 'etf' ? 1_000 : 10_000)}</span>
          <span className="num">{money(position.value)}</span>
          <span className={`num ${tone(position.pnl)}`}>
            {money(position.pnl)}<span className="ml-1 text-[10px]">{percent(position.pnlPct)}</span>
          </span>
          <span className={`num ${tone(position.dayPnl)}`}>{money(position.dayPnl)}</span>
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
        <div key={order.id} className="grid items-center gap-2 border-b border-hairline/40 px-3 py-2 text-xs"
          style={{ ...minWidth(cols), gridTemplateColumns: cols.map(() => 'minmax(0,1fr)').join(' ') }}>
          <span className="num text-ink-dim">{clockTime(order.created_at)}</span>
          <span className="truncate">{order.name}<span className="num ml-1 text-[10px] text-ink-dim">{order.code}</span></span>
          <span className={order.side.includes('short') || order.side === 'cover_buy' ? 'text-down' : 'text-foreground'}>
            {SIDE_LABEL[order.side] ?? order.side}
          </span>
          <span className="num">{order.leaf > 1 ? `${order.leaf}×` : '—'}</span>
          <span className="num">{shares(order.qty)}</span>
          <span className="num">{order.limitPrice ? priceText(order.limitPrice, order.kind === 'etf' ? 1_000 : 10_000) : '市价'}</span>
          <span className={order.status === 'rejected' ? 'text-up' : order.status === 'canceled' ? 'text-ink-dim' : 'text-primary'}>
            {STATUS_LABEL[order.status] ?? order.status}
          </span>
          <span className="flex items-center gap-2">
            <em className="min-w-0 flex-1 truncate not-italic text-[11px] text-ink-dim" title={order.reason}>
              {order.source === 'system' ? '⚠ ' : ''}{order.reason || (order.day > today ? `预埋 · 归属 ${order.day}` : '等待撮合')}
            </em>
            {order.source !== 'system' && order.status === 'open' && (
              <Button size="xs" variant="ghost" className="h-6 shrink-0 px-2 text-[11px]"
                onClick={() => onCancel(order.id)}>撤单</Button>
            )}
          </span>
        </div>
      ))}
    </div>
  );
}

function Fills({ trades }: { trades: TradeRow[] }) {
  const cols = ['时间', '标的', '方向', '数量', '成交价', '金额', '费用', '杠杆'];
  return (
    <div>
      <Head cols={cols} />
      {trades.map((trade) => (
        <div key={trade.id} className="grid gap-2 border-b border-hairline/40 px-3 py-2 text-xs"
          style={{ ...minWidth(cols), gridTemplateColumns: cols.map(() => 'minmax(0,1fr)').join(' ') }}>
          <span className="num text-ink-dim">{dayTime(trade.created_at)}</span>
          <span className="truncate">{trade.name}</span>
          <span className={SIDE_LABEL[trade.side]?.includes('卖') ? 'text-down' : 'text-up'}>{SIDE_LABEL[trade.side] ?? trade.side}</span>
          <span className="num">{shares(trade.qty)}</span>
          <span className="num">{priceText(trade.price, trade.kind === 'etf' ? 1_000 : 10_000)}</span>
          <span className="num">{money(trade.amount)}</span>
          <span className="num text-ink-dim">{money(trade.fee)}</span>
          <span className="num">{trade.leaf > 1 ? `${trade.leaf}×` : '—'}</span>
        </div>
      ))}
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
          <span className="num mr-2 text-[10px] opacity-70">{clockTime(event.at)}</span>
          {event.message}
        </li>
      ))}
    </ul>
  );
}

function Risk({ account, curve, leader, startCash }: {
  account: Account | null;
  curve: { day: string; netAssets: number }[];
  leader: { name: string; ret: number; netAssets: number; mine: boolean }[];
  startCash: number;
}) {
  const ratio = account?.guaranteeRatio ?? null;
  const ret = account ? account.netAssets / startCash - 1 : 0;
  const gauge = ratio === null ? null : Math.max(0, Math.min(1, (ratio - 1.1) / (2.6 - 1.1)));

  return (
    <div className="grid gap-4 p-4 lg:grid-cols-[1.2fr_1fr]">
      <section className="space-y-3">
        <h3 className="text-xs tracking-wide text-muted-foreground">维持担保比例</h3>
        <div className="flex items-baseline gap-3">
          <p className={`num text-3xl ${ratio === null ? 'text-muted-foreground' : ratio < 1.3 ? 'text-up' : ratio < 1.5 ? 'text-primary' : 'text-down'}`}>
            {ratioText(ratio)}
          </p>
          <p className="text-[11px] text-ink-dim">
            {ratio === null ? '当前无负债，普通现货交易'
              : ratio < 1.3 ? '已低于平仓线 130%，系统正在强制平仓'
                : ratio < 1.4 ? '低于追保线 140%，请尽快追加担保物'
                  : ratio < 1.5 ? '低于预警线 150%，注意杠杆风险' : '担保充足，可继续融资买入'}
          </p>
        </div>
        <div className="relative h-2 overflow-hidden rounded bg-muted" role="img"
          aria-label={ratio === null ? '无负债' : `维持担保比例 ${(ratio * 100).toFixed(1)}%`}>
          {gauge !== null && <div className="absolute inset-y-0 left-0 bg-current opacity-70" style={{ width: `${gauge * 100}%` }} />}
          {[1.3, 1.4, 1.5].map((line) => (
            <span key={line} className="absolute inset-y-0 w-px bg-foreground/30" style={{ left: `${((line - 1.1) / 1.5) * 100}%` }} />
          ))}
        </div>
        <div className="flex justify-between text-[10px] text-ink-dim"><span>110%</span><span>平仓 130%</span><span>追保 140%</span><span>预警 150%</span><span>260%+</span></div>

        <dl className="grid grid-cols-2 gap-x-5 gap-y-1.5 pt-1 text-xs sm:grid-cols-3">
          <Cell label="总资产" value={money(account?.totalAssets ?? 0)} />
          <Cell label="负债合计" value={money(account?.totalDebt ?? 0)} warn={(account?.totalDebt ?? 0) > 0} />
          <Cell label="净资产" value={money(account?.netAssets ?? 0)} />
          <Cell label="可用资金" value={money(account?.cash ?? 0)} />
          <Cell label="持仓市值" value={money(account?.longValue ?? 0)} />
          <Cell label="融券担保物" value={money(account?.collateral ?? 0)} />
          <Cell label="融资本金" value={money(account?.marginPrincipal ?? 0)} />
          <Cell label="融资利息" value={money(account?.marginInterest ?? 0)} />
          <Cell label="融券市值" value={money(account?.securityBalance ?? 0)} />
          <Cell label="当日盈亏" value={money(account?.todayPnl ?? 0)} toneValue={account?.todayPnl ?? 0} />
          <Cell label="浮动盈亏" value={money(account?.floatPnl ?? 0)} toneValue={account?.floatPnl ?? 0} />
          <Cell label="累计手续费" value={money(account?.feesPaid ?? 0)} />
          <Cell label="累计收益率" value={percent(ret * 100)} toneValue={ret} />
          <Cell label="成交笔数" value={String(account?.tradeCount ?? 0)} />
          <Cell label="账户杠杆" value={account?.leverage ? `${account.leverage.toFixed(2)}×` : '—'} />
        </dl>
      </section>

      <section className="space-y-4">
        <div>
          <h3 className="mb-2 text-xs tracking-wide text-muted-foreground">净值曲线（每日日结快照）</h3>
          <EquityCurve points={curve} baseline={startCash} height={170} />
        </div>
        <div>
          <h3 className="mb-2 text-xs tracking-wide text-muted-foreground">今日盈亏榜</h3>
          {leader.length === 0 ? (
            <p className="rounded border border-dashed border-hairline px-3 py-6 text-center text-[11px] leading-5 text-ink-dim">
              排行榜在每日日结后生成。多次同步会持续更新当日快照。
            </p>
          ) : (
            <ol className="space-y-1 text-xs">
              {leader.map((row, index) => (
                <li key={`${row.name}-${index}`}
                  className={`flex items-center gap-2 rounded px-2 py-1.5 ${row.mine ? 'bg-primary/10 text-primary' : ''}`}>
                  <span className="num w-6 text-ink-dim">{index + 1}</span>
                  <span className="min-w-0 flex-1 truncate">{row.name}{row.mine && '（我）'}</span>
                  <span className="num">{money(row.netAssets)}</span>
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
      <span className="text-[10px] text-ink-dim">{label}</span>
      <span className={`num ${toneValue !== undefined ? tone(toneValue) : warn ? 'text-primary' : ''}`}>{value}</span>
    </div>
  );
}
