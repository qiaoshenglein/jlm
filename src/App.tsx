import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { ApiError, api, readToken, setServerReasons, writeToken } from './api';
import { Auth } from './components/Auth';
import { Book } from './components/Book';
import { DetailPanel, MarketPanel, Tape, type Tab } from './components/Market';
import { Rules } from './components/Rules';
import { Ticket } from './components/Ticket';
import {
  SIDE_LABEL, SESSION_LABEL, Y, compact, money, ratioText, shares, tone,
  type Account, type Board, type Clock, type OrderRow, type Quote, type SearchRow,
  type Session, type SyncResponse, type TradeRow, type WatchRow,
} from './format';

const SYNC_MS = 3_000;
const PUBLIC_MS = 10_000;
const START_CASH = 1_000_000_000_000; // 100 万虚拟本金（微元）
type User = { id: string; username: string; display: string };

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [account, setAccount] = useState<Account | null>(null);
  const [board, setBoard] = useState<Board | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [clock, setClock] = useState<Clock | null>(null);
  const [orders, setOrders] = useState<OrderRow[]>([]);
  const [trades, setTrades] = useState<TradeRow[]>([]);
  const [events, setEvents] = useState<SyncResponse['events']>([]);
  const [curve, setCurve] = useState<SyncResponse['curve']>([]);
  const [leader, setLeader] = useState<SyncResponse['leader']>([]);
  const [matchable, setMatchable] = useState(false);
  const [stale, setStale] = useState(false);
  const [reasons, setReasons] = useState<Record<string, string> | null>(null);
  const [selected, setSelected] = useState('');
  const [resolved, setResolved] = useState<Quote | null>(null);
  const [filter, setFilter] = useState<Tab>('index');
  const [search, setSearch] = useState('');
  const [watch, setWatch] = useState<WatchRow[]>([]);
  const [watchQuotes, setWatchQuotes] = useState<Quote[]>([]);
  const seenEvents = useRef<Set<string>>(new Set());
  const knownWatch = useRef<Set<string>>(new Set());
  const [banner, setBanner] = useState('');
  const [showRules, setShowRules] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [view, setView] = useState<'quote' | 'trade' | 'account'>('quote');
  const mobile = useMedia('(max-width: 1023px)');
  const busy = useRef(false);
  const polling = useRef<number | null>(null);

  const applyEnvelope = useCallback((payload: { market: Board; session: Session; clock: Clock; matchable: boolean; stale: boolean }) => {
    setBoard(payload.market);
    setSession(payload.session);
    setClock(payload.clock);
    setMatchable(payload.matchable);
    setStale(payload.stale);
  }, []);

  // 首轮同步不受可见性影响，否则用户从后台标签页打开时会先看到 0.00
  const syncNow = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      const result = await api<SyncResponse>('sync', {}, true);
      setAccount(result.account);
      setOrders(result.orders);
      setTrades(result.trades);
      setEvents(result.events);
      setCurve(result.curve);
      setLeader(result.leader);
      applyEnvelope(result);
      setBanner('');
      setWatch(result.watch ?? []);
      setWatchQuotes(result.watchQuotes ?? []);
      for (const fill of result.fills ?? []) {
        knownWatch.current.add(fill.id);
        toast.success(`${SIDE_LABEL[fill.side] ?? fill.side}成交：${fill.name} ${shares(fill.qty)} 股 @ ${((fill.price ?? 0) / Y).toFixed(fill.kind === 'etf' ? 3 : 2)}`, {
          description: `成交金额 ¥${money(fill.amount)} · 费用 ¥${money(fill.fee)}${fill.leaf > 1 ? ` · ${fill.leaf}× 杠杆` : ''}`,
          duration: 6000, id: `fill-${fill.id}`,
        });
      }
      if (result.canceled > 0) toast.info(`${result.canceled} 笔未成交委托已按「当日有效」撤销`);
      for (const event of result.events ?? []) {
        const key = `${event.kind}:${event.at}`;
        if (seenEvents.current.has(key)) continue;
        seenEvents.current.add(key);
        if (event.kind === 'liquidation') toast.error(event.message, { duration: 12000 });
        else if (event.kind === 'call') toast.warning(event.message, { duration: 10000 });
      }
    } catch (error) {
      if (error instanceof ApiError) {
        if (error.code === 'login_required') {
          writeToken(null);
          setUser(null);
          setBanner('登录状态已失效，请重新登录。');
        } else {
          setBanner(error.message);
        }
      }
    } finally {
      busy.current = false;
    }
  }, [applyEnvelope]);

  // 未登录时也要有真实指数带：注册页的背景就是行情
  useEffect(() => {
    if (user) return;
    let live = true;
    const pull = async () => {
      try {
        const result = await api<SyncResponse>('board', {}, true);
        if (live) { applyEnvelope(result); setBanner(''); }
      } catch (error) {
        if (live && error instanceof ApiError) setBanner(error.message);
      }
    };
    void pull();
    const timer = window.setInterval(() => { if (!document.hidden) void pull(); }, PUBLIC_MS);
    return () => { live = false; window.clearInterval(timer); };
  }, [user, applyEnvelope]);

  // 恢复会话 + 拉取服务端错误码文案
  useEffect(() => {
    void api<{ rules: { reasons: Record<string, string> } }>('rules', {}, true)
      .then((result) => { setReasons(result.rules.reasons); setServerReasons(result.rules.reasons); })
      .catch(() => undefined);
    if (!readToken()) return;
    void api<SyncResponse & { user: User }>('me', {}, true)
      .then((result) => {
        setUser(result.user);
        setAccount(result.account);
        applyEnvelope(result);
      })
      .catch(() => writeToken(null));
  }, [applyEnvelope]);

  // 登录后开始撮合轮询；标签页隐藏时暂停，回到前台立即补一轮
  useEffect(() => {
    if (!user) {
      if (polling.current) window.clearInterval(polling.current);
      polling.current = null;
      return;
    }
    void syncNow();
    polling.current = window.setInterval(() => { if (!document.hidden) void syncNow(); }, SYNC_MS);
    const resume = () => void syncNow();
    document.addEventListener('visibilitychange', resume);
    return () => {
      if (polling.current) window.clearInterval(polling.current);
      polling.current = null;
      document.removeEventListener('visibilitychange', resume);
    };
  }, [user, syncNow]);

  async function submitAuth(action: 'login' | 'register', payload: Record<string, string>) {
    const result = await api<{ token: string; user: User }>(action, payload);
    writeToken(result.token);
    setUser(result.user);
    setAccount(null);
    toast.success(action === 'register' ? '开户完成，100 万虚拟本金已到账' : `欢迎回来，${result.user.display}`);
  }

  async function logout() {
    setSigningOut(true);
    try { await api('logout'); } catch { /* 令牌已在本地清除 */ }
    writeToken(null);
    setUser(null);
    setAccount(null);
    setOrders([]);
    setTrades([]);
    setSigningOut(false);
  }

  // 搜索结果里可能包含行情池外的标的：先选中，取不到实时价就按代码补取
  function pickSearch(item: SearchRow) {
    setSelected(item.secid);
    setResolved(null);
    if (item.last === null) void resolveSymbol(item.code);
  }

  async function toggleWatch(item: { secid: string; code: string; name: string; kind: string }) {
    const added = watch.some((row) => row.secid === item.secid);
    try {
      const result = await api<{ watch: WatchRow[] }>(added ? 'watch_remove' : 'watch_add', {
        secid: item.secid, code: item.code, name: item.name, kind: item.kind,
      });
      setWatch(result.watch);
      if (added) toast(`已移出自选：${item.name}`);
      else toast.success(`已加入自选：${item.name}`, { description: `${item.code} · 自选标签下会实时显示涨跌` });
      void syncNow();
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : '自选操作未成功');
    }
  }

  async function cancelOrder(id: string) {
    try {
      const result = await api<{ orders: OrderRow[] }>('cancel', { orderId: id });
      setOrders(result.orders);
      toast.success('撤单成功', { description: '该委托已撤销，占用保证金已释放' });
      void syncNow();
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : '撤单未成功');
    }
  }

  // 交易范围不限于行情池：任意 6 位代码都能即时取价下单
  async function resolveSymbol(code: string): Promise<Quote | null> {
    const clean = code.trim();
    if (!/^\d{6}$/.test(clean)) return null;
    const pool = [...(board?.indexes ?? []), ...(board?.etfs ?? []), ...(board?.stocks ?? [])];
    const known = pool.find((quote) => quote.code === clean);
    if (known) { setSelected(known.secid); setResolved(null); return known; }
    setResolving(true);
    try {
      const secid = `${/^[569]/.test(clean) ? '1' : '0'}.${clean}`;
      const result = await api<{ quote: Quote }>('lookup', { secid });
      setSelected(result.quote.secid);
      setResolved(result.quote);
      return result.quote;
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : `未找到 ${clean}，请确认代码属于沪、深或北交所`);
      return null;
    } finally {
      setResolving(false);
    }
  }

  if (!user) return <Auth board={board} session={session} onSubmit={submitAuth} />;

  // 持仓标的即使不在行情池里也要能显示与切换，用持仓字段合成
  const heldQuotes: Quote[] = (account?.positions ?? []).map((position) => ({
    secid: position.symbol, code: position.code, name: position.name,
    kind: position.kind as Quote['kind'],
    last: position.price, prevClose: position.prevClose ?? position.price,
    open: null, high: null, low: null, change: 0, pct: position.pct,
    volume: 0, amount: 0, turnover: null, marketCap: null,
    limitUp: position.limitUp ?? position.price, limitDown: position.limitDown ?? position.price,
    limitRatio: 0.1, tick: position.kind === 'etf' ? 1_000 : 10_000,
    ts: 0, sealedUp: false, sealedDown: false,
  }));
  const pool = [...(board?.indexes ?? []), ...(board?.stocks ?? []), ...(board?.etfs ?? []), ...heldQuotes];
  const selectedQuote = resolved && resolved.secid === selected ? resolved
    : pool.find((quote) => quote.secid === selected) ?? null;

  const pickSymbol = (secid: string) => {
    setSelected(secid);
    setResolved(null);
    if (mobile) setView('trade'); // 手机上选完标的直接进下单页，省一次滚动
  };

  const market = (
    <MarketPanel board={board} session={session} selected={selected} held={heldQuotes}
      watch={watch} watchQuotes={watchQuotes} compact={mobile}
      filter={filter} onFilter={setFilter} onSelect={pickSymbol}
      onPick={(item) => { pickSearch(item); if (mobile) setView('trade'); }} onToggleWatch={(entry) => void toggleWatch(entry)}
      searchText={search} onSearch={setSearch} />
  );
  const detail = <DetailPanel quote={selectedQuote} compact={mobile} onToast={(message) => toast(message)} />;
  const book = (
    <Book account={account} orders={orders} trades={trades} events={events}
      curve={curve} leader={leader} startCash={START_CASH} today={clock?.day ?? session?.day ?? ''}
      onSelect={pickSymbol} onCancel={(id) => void cancelOrder(id)} />
  );
  const ticket = (
    <Ticket quote={selectedQuote} account={account} held={heldQuotes} resolving={resolving}
      onResolve={resolveSymbol} onFilled={(message) => toast.success(message)}
      onDuplicate={(confirm) => toast.warning('已有一笔完全相同的委托', {
        description: '15 秒内重复提交，通常是连点。确实要再来一笔请点确认。',
        duration: 12_000, closeButton: true,
        action: { label: '确认重复下单', onClick: () => confirm() },
      })} />
  );

  const ratio = account?.guaranteeRatio ?? null;
  const ret = account ? account.netAssets / START_CASH - 1 : 0;

  return (
    <div className={`flex flex-col ${mobile ? 'h-dvh overflow-hidden' : 'min-h-dvh'}`}>
      <header className={`z-20 border-b border-hairline bg-background/92 backdrop-blur ${mobile ? 'shrink-0' : 'sticky top-0'}`}>
        <div className={`flex flex-wrap items-center ${mobile ? 'gap-x-2 gap-y-1 px-3 py-1.5' : 'gap-x-5 gap-y-2 px-4 py-2'}`}>
          <div className="flex items-baseline gap-2">
            <span className={`font-semibold tracking-[0.2em] ${mobile ? 'text-base' : 'text-lg'}`}>镜盘</span>
            {!mobile && <span className="num text-[10px] tracking-[0.25em] text-primary">MIRROR DESK</span>}
          </div>

          <div className={`num flex flex-wrap items-center gap-2 text-[11px] ${mobile ? 'w-full order-3' : ''}`}>
            <span className={`rounded px-2 py-0.5 ${matchable ? 'bg-down/15 text-down' : 'bg-muted text-muted-foreground'}`}>
              {session ? SESSION_LABEL[session.phase] : '—'}
            </span>
            <span className="text-ink-dim">北京时间 {clock?.stamp.slice(11) ?? session?.stamp.slice(11) ?? '—'}</span>
            {stale && <span className={`rounded bg-up/15 px-2 py-0.5 text-up ${mobile ? 'text-[10px]' : ''}`}>行情非当日数据，休市不撮合</span>}
          </div>

          <div className="num ml-auto flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px]">
            <Metric label="净资产" value={money(account?.netAssets ?? 0)} />
            {!mobile && <Metric label="可用资金" value={money(account?.cash ?? 0)} />}
            {!mobile && <Metric label="总负债" value={money(account?.totalDebt ?? 0)} className={(account?.totalDebt ?? 0) > 0 ? 'text-primary' : ''} />}
            {mobile && <Metric label="可用" value={compact(account?.cash ?? 0)} />}
            <Metric label="担保比例" value={ratioText(ratio)}
              className={ratio !== null && ratio < 1.3 ? 'text-up' : ratio !== null && ratio < 1.5 ? 'text-primary' : 'text-down'} />
            {!mobile && <Metric label="收益率" value={`${ret >= 0 ? '+' : ''}${(ret * 100).toFixed(2)}%`} className={tone(ret * START_CASH)} />}
            <button type="button" onClick={() => setShowRules(true)}
              className="rounded border border-hairline px-2 py-1 text-[11px] text-muted-foreground hover:border-input hover:text-foreground">
              规则
            </button>
            <span className={`truncate ${mobile ? 'hidden' : 'max-w-[10ch]'}`}>{user.display}</span>
            <button type="button" onClick={() => void logout()} disabled={signingOut}
              className="rounded border border-hairline px-2 py-1 text-[11px] text-muted-foreground hover:border-input hover:text-foreground">
              {signingOut ? '退出中' : '登出'}
            </button>
          </div>
        </div>
        <Tape indexes={board?.indexes ?? []} />
      </header>

      {banner && <p role="alert" className="border-b border-up/40 bg-up/10 px-4 py-1.5 text-xs text-up">{banner}</p>}

      {mobile ? (
        <main className="min-h-0 flex-1 overflow-hidden p-2">
          {view === 'quote' && (
            <div className="flex h-full min-h-0 flex-col gap-2">
              <div className="h-[46%] min-h-[190px] shrink-0">{detail}</div>
              <div className="min-h-0 flex-1">{market}</div>
            </div>
          )}
          {view === 'trade' && <div className="h-full">{ticket}</div>}
          {view === 'account' && <div className="h-full">{book}</div>}
        </main>
      ) : (
        <main className="grid flex-1 gap-3 p-3 lg:h-[calc(100dvh-108px)] lg:grid-rows-[minmax(0,1fr)] lg:grid-cols-[minmax(230px,18rem)_minmax(0,1fr)_minmax(300px,21rem)] lg:overflow-hidden">
          {market}
          <div className="scrollbar-thin flex min-h-0 flex-col gap-3 lg:overflow-y-auto">
            <div className="min-h-[320px] flex-[6]">{detail}</div>
            <div className="min-h-[260px] flex-[5]">{book}</div>
          </div>
          {ticket}
        </main>
      )}

      {mobile ? (
        <nav aria-label="页面切换" className="nav-safe grid shrink-0 grid-cols-3 border-t border-hairline bg-panel text-[11px]">
          {([['quote', '行情'], ['trade', '交易'], ['account', '账户']] as const).map(([key, label]) => (
            <button key={key} type="button" aria-current={view === key} onClick={() => setView(key)}
              className={`flex min-h-12 flex-col items-center justify-center gap-0.5 py-2 transition ${view === key ? 'text-primary' : 'text-muted-foreground'}`}>
              <span className="text-[13px]">{label}</span>
              <span className="num text-[10px] text-ink-dim">
                {key === 'trade' ? (selectedQuote?.name ?? '未选标的')
                  : key === 'account' ? `持仓 ${(account?.positions ?? []).length} · 委托 ${orders.length}`
                    : `自选 ${watch.length}`}
              </span>
            </button>
          ))}
        </nav>
      ) : (
        <footer className="px-4 pb-4 text-[11px] leading-5 text-ink-dim">
          行情源：东方财富公开接口 · 每 {SYNC_MS / 1000} 秒撮合一轮 · 市价单以最新价全额成交 · 股票 T+1 · 涨跌停与两融担保比例按真实规则校验 · 虚拟资金，不构成投资建议
        </footer>
      )}

      {showRules && <Rules extra={reasons} onClose={() => setShowRules(false)} />}
    </div>
  );
}

// 断点用 JS 判定：移动端要换成「底部导航 + 单视图填满视口」的外壳，纯 CSS 切不出这种结构
function useMedia(query: string) {
  const [matches, setMatches] = useState(() => typeof window !== 'undefined' && window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const sync = () => setMatches(mq.matches);
    sync();
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, [query]);
  return matches;
}

function Metric({ label, value, className = '' }: { label: string; value: string; className?: string }) {
  return (
    <span className="flex items-baseline gap-1">
      <span className="text-ink-dim">{label}</span>
      <span className={className || 'text-foreground'}>{value}</span>
    </span>
  );
}
