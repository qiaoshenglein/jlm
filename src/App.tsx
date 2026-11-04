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
import type { Marker } from './components/charts';const DENSITY = ['compact', 'standard', 'roomy'] as const;
const SYNC_MS = 3_000;
const PUBLIC_MS = 10_000;
const START_CASH = 1_000_000_000_000; // 100 万虚拟本金（微元）
type User = { id: string; username: string; display: string };export default function App() {
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
  const [visibleRows, setVisibleRows] = useState<{ secid: string }[]>([]);
  const [density, setDensity] = useState<'compact' | 'standard' | 'roomy'>(() => {
    const saved = typeof localStorage !== 'undefined' ? localStorage.getItem('mirror.desk.density') : null;
    return saved === 'compact' || saved === 'roomy' || saved === 'standard' ? saved : 'standard';
  });
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
  }, []);  // 首轮同步不受可见性影响，否则用户从后台标签页打开时会先看到 0.00
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
  }, [applyEnvelope]);  useEffect(() => {
    document.documentElement.dataset.density = density;
    try { localStorage.setItem('mirror.desk.density', density); } catch { /* 隐私模式下仅本次生效 */ }
  }, [density]);

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
  }, [user, applyEnvelope]);  // 恢复会话 + 拉取服务端错误码文案
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
  }, [applyEnvelope]);  // 登录后开始撮合轮询；标签页隐藏时暂停，回到前台立即补一轮
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
  }, [user, syncNow]);  // 键盘流：不拦输入框与组合键，交易台的顺滑感主要来自这里
  useEffect(() => {
    if (!user) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || event.repeat) return;
      const target = event.target as HTMLElement | null;
      const typing = Boolean(target && (/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) || target.isContentEditable));
      if (event.key === 'Escape') {
        setShowRules(false);
        if (typing) target?.blur();
        else setSearch('');
        return;
      }
      if (typing || showRules) return;
      if (event.key === '/') {
        event.preventDefault();
        if (mobile) setView('quote');
        window.setTimeout(() => document.querySelector<HTMLInputElement>('input[aria-label^="搜索标的"]')?.focus(), 30);
        return;
      }
      if (event.key === 'ArrowDown' || event.key === 'j' || event.key === 'ArrowUp' || event.key === 'k') {
        if (!visibleRows.length) return;
        event.preventDefault();
        const step = event.key === 'ArrowUp' || event.key === 'k' ? -1 : 1;
        const at = visibleRows.findIndex((row) => row.secid === selected);
        const next = visibleRows[Math.min(visibleRows.length - 1, Math.max(0, (at < 0 ? 0 : at) + step))];
        if (next) setSelected(next.secid);
        return;
      }
      if (event.key === '1' || event.key === '2' || event.key === '3') {
        setView((['quote', 'trade', 'account'] as const)[Number(event.key) - 1]);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mobile, selected, showRules, visibleRows, user]);

  async function submitAuth(action: 'login' | 'register', payload: Record<string, string>) {
    const result = await api<{ token: string; user: User }>(action, payload);
    writeToken(result.token);
    setUser(result.user);
    setAccount(null);
    toast.success(action === 'register' ? '开户完成，100 万虚拟本金已到账' : `欢迎回来，${result.user.display}`);
  }  async function logout() {
    setSigningOut(true);
    try { await api('logout'); } catch { /* 令牌已在本地清除 */ }
    writeToken(null);
    setUser(null);
    setAccount(null);
    setOrders([]);
    setTrades([]);
    setSigningOut(false);
  }  // 搜索结果里可能包含行情池外的标的：先选中，取不到实时价就按代码补取
  function pickSearch(item: SearchRow) {
    setSelected(item.secid);
    setResolved(null);
    if (item.last === null) void resolveSymbol(item.code);
  }  async function toggleWatch(item: { secid: string; code: string; name: string; kind: string }) {
    const added = watch.some((row) => row.secid === item.secid);
    const before = watch;
    // 先落子再等服务器：星标立刻翻转，失败才还原。自选不是账户数据，不用再拖一次全量同步
    setWatch(added
      ? before.filter((row) => row.secid !== item.secid)
      : [...before, { secid: item.secid, code: item.code, name: item.name, kind: item.kind, created_at: new Date().toISOString() }]);
    try {
      const result = await api<{ watch: WatchRow[] }>(added ? 'watch_remove' : 'watch_add', {
        secid: item.secid, code: item.code, name: item.name, kind: item.kind,
      });
      setWatch(result.watch);
      if (added) toast(`已移出自选：${item.name}`);
      else toast.success(`已加入自选：${item.name}`, { description: `${item.code} · 自选标签下会实时显示涨跌` });
    } catch (error) {
      setWatch(before);
      toast.error(error instanceof ApiError ? error.message : '自选操作未成功');
    }
  }

  async function moveWatch(secid: string, delta: number) {
  const at = watch.findIndex((row) => row.secid === secid);
  const to = Math.max(0, Math.min(watch.length - 1, at + delta));
  if (at < 0 || at === to) return;
  const next = [...watch];
  const [row] = next.splice(at, 1);
  next.splice(to, 0, row);
  setWatch(next);
  try {
    const result = await api<{ watch: WatchRow[] }>('watch_sort', { secids: next.map((item) => item.secid) });
    setWatch(result.watch);
  } catch (error) {
    toast.error(error instanceof ApiError ? error.message : '顺序保存失败，已按服务端顺序还原');
    void syncNow();
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
  }  // 交易范围不限于行情池：任意 6 位代码都能即时取价下单
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
  const ratio = account?.guaranteeRatio ?? null;
  const ret = account ? account.netAssets / START_CASH - 1 : 0;
  const position = (account?.positions ?? []).find((item) => item.symbol === selected) ?? null;
  const markers: Marker[] = [];
  if (position && account) {
    markers.push({ price: position.avgCost, label: position.side === 'long' ? '成本' : '券成本', tone: 'cost' });
    if (position.side === 'long' && account.totalDebt > 0) {
      const others = account.totalAssets - position.value;
      const liq = Math.round((1.3 * account.totalDebt - others) / Math.max(1, position.qty));
      if (liq > 0 && liq < position.price) markers.push({ price: liq, label: '强平', tone: 'liq' });
    }
  }

  const pickSymbol = (secid: string) => {
    setSelected(secid);
    setResolved(null);
    if (mobile) setView('trade'); // 手机上选完标的直接进下单页，省一次滚动
  };
  const market = (
    <MarketPanel board={board} selected={selected} held={heldQuotes}
      watch={watch} watchQuotes={watchQuotes} compact={mobile}
      filter={filter} onFilter={setFilter} onSelect={pickSymbol}
      onPick={(item) => { pickSearch(item); if (mobile) setView('trade'); }} onToggleWatch={(entry) => void toggleWatch(entry)}
      searchText={search} onSearch={setSearch} onRowsChange={setVisibleRows} onMove={moveWatch} />
  );
  const detail = <DetailPanel quote={selectedQuote} markers={markers} compact={mobile} onToast={(message) => toast(message)} />;
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
  return (
    <div className={`flex flex-col ${mobile ? 'h-dvh overflow-hidden' : 'min-h-dvh'}`}>
      <header className={`z-20 border-b border-hairline bg-background/92 backdrop-blur ${mobile ? 'shrink-0' : 'sticky top-0'}`}>
        <div className={`flex flex-wrap items-center gap-y-1 ${mobile ? 'gap-x-2 px-3 py-1.5' : 'gap-x-4 px-4 py-2'}`}>
          <div className="flex items-baseline gap-2 border-l-2 border-primary pl-2">
            <span className={`font-semibold tracking-[0.2em] ${mobile ? 'text-[1.0625rem]' : 'text-[1.1875rem]'}`}>镜盘</span>
            {!mobile && <span className="num text-[0.625rem] tracking-[0.25em] text-primary">MIRROR DESK</span>}
          </div>          <span className={`chip num ${matchable ? 'border-down/40 bg-down/12 text-down' : 'border-hairline bg-muted text-muted-foreground'}`}>
            <span className={`inline-block size-1.5 rounded-full ${matchable ? 'bg-down' : 'bg-flat'}`} />
            {session ? SESSION_LABEL[session.phase] : '—'}
            <span className="opacity-70">{clock?.stamp.slice(11) ?? session?.stamp.slice(11) ?? ''}</span>
          </span>
          {stale && <span className="chip border-warn/45 bg-warn/12 text-warn">行情非当日数据 · 休市不撮合</span>}          <div className="num ml-auto flex flex-wrap items-center gap-x-4 gap-y-1">
            <span className="flex flex-col items-end leading-tight">
              <span className="text-[0.6562rem] tracking-[0.06em] text-ink-dim">净资产</span>
              <span className="text-[1.0625rem] font-semibold">{money(account?.netAssets ?? 0)}</span>
            </span>
            <span className="flex flex-col items-end leading-tight">
              <span className="text-[0.6562rem] tracking-[0.06em] text-ink-dim">可用</span>
              <span className="text-[0.875rem]">{money(account?.cash ?? 0)}</span>
            </span>
            {(account?.totalDebt ?? 0) > 0 && (
              <span className="flex flex-col items-end leading-tight">
                <span className="text-[0.6562rem] tracking-[0.06em] text-ink-dim">总负债</span>
                <span className="text-[0.875rem] text-warn">{money(account?.totalDebt ?? 0)}</span>
              </span>
            )}
            <Gauge ratio={ratio} ret={ret} compact={mobile} />
            {mobile ? (
              <button type="button" onClick={() => setDensity(DENSITY[(DENSITY.indexOf(density) + 1) % 3])}
                aria-label={`行距密度：${density === 'compact' ? '紧凑' : density === 'roomy' ? '宽松' : '标准'}，点击切换`}
                className="chip border-hairline text-ink-dim">
                {density === 'compact' ? '紧' : density === 'roomy' ? '疏' : '中'}
              </button>
            ) : (
              <span role="group" aria-label="行距密度" className="chip gap-0.5 border-hairline p-0.5">
                {([['compact', '紧'], ['standard', '中'], ['roomy', '疏']] as const).map(([value, label]) => (
                  <button key={value} type="button" onClick={() => setDensity(value)} aria-pressed={density === value}
                    title={`行距：${label}`}
                    className={`size-5 rounded text-[0.6875rem] transition ${density === value ? 'bg-primary/20 text-primary' : 'text-ink-dim hover:text-foreground'}`}>
                    {label}
                  </button>
                ))}
              </span>
            )}
            <button type="button" onClick={() => setShowRules(true)}
              className="chip border-hairline text-muted-foreground transition hover:border-input hover:text-foreground">规则</button>
            {!mobile && <span className="max-w-[10ch] truncate text-[0.8125rem]">{user.display}</span>}
            <button type="button" onClick={() => void logout()} disabled={signingOut}
              className="chip border-hairline text-muted-foreground transition hover:border-input hover:text-foreground">
              {signingOut ? '退出中' : '登出'}
            </button>
          </div>
        </div>
        <Tape indexes={board?.indexes ?? []} />
      </header>      {banner && <p role="alert" className="border-b border-up/40 bg-up/10 px-4 py-1.5 text-xs text-up">{banner}</p>}      {mobile ? (
        <main className="min-h-0 flex-1 overflow-hidden p-2">
          {view === 'quote' && (
            <div className="view-in flex h-full min-h-0 flex-col gap-2">
              <div className="h-[40%] min-h-[176px] shrink-0">{detail}</div>
              <div className="min-h-0 flex-1">{market}</div>
            </div>
          )}
          {view === 'trade' && <div className="view-in h-full">{ticket}</div>}
          {view === 'account' && <div className="view-in h-full">{book}</div>}
        </main>
      ) : (
        <main className="grid flex-1 gap-3 p-3 lg:h-[calc(100dvh-108px)] lg:min-h-0 lg:flex-none lg:grid-rows-[minmax(0,1fr)] lg:grid-cols-[minmax(230px,18rem)_minmax(0,1fr)_minmax(300px,21rem)] lg:overflow-hidden">
          {market}
          <div className="scrollbar-thin flex min-h-0 flex-col gap-3 lg:overflow-y-auto">
            <div className="min-h-[320px] flex-[6]">{detail}</div>
            <div className="min-h-[260px] flex-[5]">{book}</div>
          </div>
          {ticket}
        </main>
      )}      {mobile ? (
        <nav aria-label="页面切换" className="nav-safe grid shrink-0 grid-cols-3 border-t border-hairline bg-panel text-[0.75rem]">
          {([['quote', '行情'], ['trade', '交易'], ['account', '账户']] as const).map(([key, label]) => (
            <button key={key} type="button" aria-current={view === key} onClick={() => setView(key)}
              className={`flex min-h-12 flex-col items-center justify-center gap-0.5 py-2 transition-colors duration-75 active:bg-surface-2 ${view === key ? 'text-primary' : 'text-muted-foreground'}`}>
              <span className="text-[0.8125rem]">{label}</span>
              <span className="num text-[0.6875rem] text-ink-dim">
                {key === 'trade' ? (selectedQuote?.name ?? '未选标的')
                  : key === 'account' ? `持仓 ${(account?.positions ?? []).length} · 委托 ${orders.length}`
                    : `自选 ${watch.length}`}
              </span>
            </button>
          ))}
        </nav>
      ) : (
        <footer className="flex flex-wrap items-center gap-x-4 px-4 pb-3 text-[0.75rem] leading-5 text-ink-dim">
          <span className="num shrink-0">
            <kbd className="rounded border border-hairline px-1">/</kbd> 搜索
            <kbd className="ml-2 rounded border border-hairline px-1">J/K</kbd> 选标的
            <kbd className="ml-2 rounded border border-hairline px-1">滚轮</kbd> 翻页
            <kbd className="ml-2 rounded border border-hairline px-1">B/S</kbd> 方向
            <kbd className="ml-2 rounded border border-hairline px-1">1-5</kbd> 杠杆
            <kbd className="ml-2 rounded border border-hairline px-1">Enter</kbd> 下单
          </span>
          行情源：东方财富公开接口 · 每 {SYNC_MS / 1000} 秒撮合一轮 · 市价单以最新价全额成交 · 股票 T+1 · 涨跌停与两融担保比例按真实规则校验 · 虚拟资金，不构成投资建议
        </footer>
      )}      {showRules && <Rules extra={reasons} onClose={() => setShowRules(false)} />}
    </div>
  );
}// 断点用 JS 判定：移动端要换成「底部导航 + 单视图填满视口」的外壳，纯 CSS 切不出这种结构
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
}/** 维持担保比例仪表签：一条迷你刻度 + 阶梯线，比纯数字更快判断风险 */
function Gauge({ ratio, ret, compact }: { ratio: number | null; ret: number; compact: boolean }) {
  const pct = ratio === null ? null : Math.max(0, Math.min(1, (ratio - 1.1) / 1.5));
  const tone = ratio === null ? 'text-muted-foreground' : ratio < 1.3 ? 'text-up' : ratio < 1.4 ? 'text-warn' : 'text-down';
  return (
    <span className={`flex items-end gap-2 ${compact ? '' : 'border-l border-hairline pl-4'}`}>
      <span className="flex flex-col items-end leading-tight">
        <span className="text-[0.6562rem] tracking-[0.06em] text-ink-dim">维持担保比例</span>
        <span className={`text-[0.9375rem] font-semibold ${tone}`}>{ratioText(ratio)}</span>
      </span>
      {!compact && (
        <span className="relative mb-1 block h-1.5 w-16 overflow-hidden rounded-full bg-muted" aria-hidden="true">
          {[1.3, 1.4, 1.5].map((line) => (
            <span key={line} className="absolute inset-y-0 w-px bg-foreground/35" style={{ left: `${((line - 1.1) / 1.5) * 100}%` }} />
          ))}
          {pct !== null && <span className={`absolute inset-y-0 left-0 rounded-full ${ratio! < 1.3 ? 'bg-up' : ratio! < 1.4 ? 'bg-warn' : 'bg-down'}`} style={{ width: `${pct * 100}%` }} />}
        </span>
      )}
      <span className={`chip num mb-0.5 ${ret >= 0 ? 'border-up/40 bg-up/12 text-up' : 'border-down/40 bg-down/12 text-down'}`}>
        {`${ret >= 0 ? '+' : ''}${(ret * 100).toFixed(2)}%`}
      </span>
    </span>
  );
}
