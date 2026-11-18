import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { ApiError, api, currentMarket, readToken, setMarket as writeMarket, setServerReasons, writeToken } from './api';
import { Auth } from './components/Auth';
import { Book } from './components/Book';
import { DetailPanel, MarketPanel, Tape, type Tab } from './components/Market';
import { Admin } from './components/Admin';
import { ApiDocs } from './components/ApiDocs';
import { Rules } from './components/Rules';
import { Ticket } from './components/Ticket';
import {
  MARKET_NAME, SESSION_LABEL, SIDE_LABEL, Y, compact, currencyOfSecid, isCapitalSide, marketOfSecid,
  money, percent, priceText, ratioText, sessionLabel, shares, tickOfSecid, tone,
  DEFAULT_LINES,
  type Account, type Board, type Clock, type DeskParams, type Lines, type Market, type MarketStatus,
  type OrderRow, type Quote, type SearchRow, type Session, type SideView, type SyncResponse, type TradeRow, type WatchRow,
} from './format';
import type { Marker } from './components/charts';const DENSITY = ['compact', 'standard', 'roomy'] as const;
const SYNC_MS = 3_000;
const PUBLIC_MS = 10_000;
const START_CASH = 1_000_000_000_000; // 100 万虚拟本金（微元）
// 看盘时最常做的事就是把三块侧栏全收起，只留图表；显隐状态和行距密度一样按人记住
const PANELS_KEY = 'mirror.desk.panels';
const PANELS_ALL = { list: false, ticket: false, book: false } as const;
const PANELS_DEFAULT = { list: true, ticket: true, book: true } as const;
type Panels = { list: boolean; ticket: boolean; book: boolean };
const PANEL_LABEL: Record<keyof Panels, string> = { list: '行情列表', ticket: '下单', book: '账本' };
const PANEL_KEY_HINT: Record<keyof Panels, string> = { list: '[', ticket: ']', book: '\\' };
function readPanels(): Panels {
  try {
    const raw = localStorage.getItem(PANELS_KEY);
    if (!raw) return { ...PANELS_DEFAULT };
    const saved = JSON.parse(raw) as Partial<Panels>;
    return {
      list: saved.list !== false, ticket: saved.ticket !== false, book: saved.book !== false,
    };
  } catch { return { ...PANELS_DEFAULT }; }
}
type User = { id: string; username: string; display: string; role?: 'user' | 'admin'; status?: 'active' | 'frozen' };export default function App() {
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
  const [paused, setPaused] = useState(false); // 后台的撮合熔断开关，与「休市」是两件事，分开显示
  const [stale, setStale] = useState(false);
  // 当前市场：沪深用人民币账，美股用美元账，两边互不挪用
  const [market, setMarket] = useState<Market>(() => currentMarket());
  const [side, setSide] = useState<SideView | null>(null);
  const [combined, setCombined] = useState<SyncResponse['combined'] | null>(null);
  const [markets, setMarkets] = useState<Record<Market, MarketStatus> | null>(null);
  const [fx, setFx] = useState(0);
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
  const [showApi, setShowApi] = useState(false);
  const [visibleRows, setVisibleRows] = useState<{ secid: string }[]>([]);
  const [lines, setLines] = useState<Lines>(DEFAULT_LINES); // 风控线由后台热改，标签与刻度跟着走
  const [density, setDensity] = useState<'compact' | 'standard' | 'roomy'>(() => {
    const saved = typeof localStorage !== 'undefined' ? localStorage.getItem('mirror.desk.density') : null;
    return saved === 'compact' || saved === 'roomy' || saved === 'standard' ? saved : 'standard';
  });
  const [resolving, setResolving] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [panels, setPanels] = useState<Panels>(readPanels);
  const focusMode = !panels.list && !panels.ticket && !panels.book;
  const togglePanel = useCallback((key: keyof Panels) => {
    setPanels((prev) => ({ ...prev, [key]: !prev[key] }));
  }, []);
  const toggleFocus = useCallback(() => {
    setPanels((prev) => (prev.list || prev.ticket || prev.book ? { ...PANELS_ALL } : { ...PANELS_DEFAULT }));
  }, []);
  const [view, setView] = useState<'quote' | 'trade' | 'account'>('quote');
  const [route, setRoute] = useState(() => (typeof window === 'undefined' ? '' : window.location.hash));
  useEffect(() => {
    const onHash = () => setRoute(window.location.hash);
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  const mobile = useMedia('(max-width: 1023px)');
  const busy = useRef(false);
  const polling = useRef<number | null>(null);
  const cur = market === 'us' ? 'USD' : 'CNY';
  const applyEnvelope = useCallback((payload: {
    market: Board; session: Session; clock: Clock; matchable: boolean; matchPaused?: boolean; stale: boolean;
    side?: SideView; combined?: SyncResponse['combined']; markets?: Record<Market, MarketStatus>; fx?: number;
  }) => {
    setBoard(payload.market);
    setSession(payload.session);
    setClock(payload.clock);
    setMatchable(payload.matchable);
    setPaused(Boolean(payload.matchPaused));
    setStale(payload.stale);
    setSide(payload.side ?? null);
    setCombined(payload.combined ?? null);
    if (payload.markets) setMarkets(payload.markets);
    if (payload.fx) setFx(payload.fx);
  }, []);  // 首轮同步不受可见性影响，否则用户从后台标签页打开时会先看到 0.00
  const applyParams = useCallback((payload: { params?: DeskParams }) => {
    const next = payload.params?.lines;
    if (!next) return;
    // 值没变就保持同一引用，避免每 3 秒一次的同步白白重渲染
    setLines((prev) => (prev.liquid === next.liquid && prev.call === next.call
      && prev.warn === next.warn && prev.open === next.open && prev.withdraw === next.withdraw ? prev : next));
  }, []);
  const syncNow = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      const result = await api<SyncResponse>('sync', {}, true);
      setAccount(result.account);
      // 角色与冻结状态由后台改，靠这一路带回来；没变化时保持同一引用，不做无谓重渲染
      setUser((prev) => (prev && prev.role === result.user?.role && prev.status === result.user?.status
        ? prev : { ...prev, ...result.user }));
      setOrders(result.orders);
      setTrades(result.trades);
      setEvents(result.events);
      setCurve(result.curve);
      setLeader(result.leader);
      applyEnvelope(result);
      applyParams(result);
      setBanner('');
      setWatch(result.watch ?? []);
      setWatchQuotes(result.watchQuotes ?? []);
      for (const fill of result.fills ?? []) {
        knownWatch.current.add(fill.id);
        const fillCur = fill.currency ?? currencyOfSecid(fill.secid);
        if (isCapitalSide(fill.side)) {
          toast.info(`后台${fill.side === 'capital_out' ? '出金' : '入金'} ${money(fill.amount, fillCur)}`, {
            description: '由管理员调整，已作为资金流水入账', duration: 8000, id: `fill-${fill.id}`,
          });
          continue;
        }
        toast.success(`${SIDE_LABEL[fill.side] ?? fill.side}成交：${fill.name} ${shares(fill.qty)} 股 @ ${priceText(fill.price, tickOfSecid(fill.secid, fill.kind))}`, {
          description: `成交金额 ${money(fill.amount, fillCur)} · 费用 ${money(fill.fee, fillCur)}${fill.leaf > 1 ? ` · ${fill.leaf}× 杠杆` : ''}`,
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
  }, [applyEnvelope, applyParams]);

  // 切市场：先记住选择并立刻换上下文，行情/账本各归各的池子，不能拿 A 股的持仓去配美元的委托
  const switchMarket = useCallback((next: Market) => {
    if (next === currentMarket()) return;
    writeMarket(next);
    setMarket(next);
    setSelected('');
    setResolved(null);
    setSearch('');
    setWatch([]);
    setWatchQuotes([]);
    setOrders([]);
    setTrades([]);
    void syncNow();
  }, [syncNow]);  useEffect(() => {
    document.documentElement.dataset.density = density;
    try { localStorage.setItem('mirror.desk.density', density); } catch { /* 隐私模式下仅本次生效 */ }
  }, [density]);
  useEffect(() => {
    try { localStorage.setItem(PANELS_KEY, JSON.stringify(panels)); } catch { /* 隐私模式下仅本次生效 */ }
  }, [panels]);

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
    void api<{ rules: { reasons: Record<string, string>; lines: Lines } }>('rules', {}, true)
      .then((result) => {
        setReasons(result.rules.reasons); setServerReasons(result.rules.reasons);
        if (result.rules.lines) setLines(result.rules.lines);
      })
      .catch(() => undefined);
    if (!readToken()) return;
    void api<SyncResponse & { user: User }>('me', {}, true)
      .then((result) => {
        setUser(result.user);
        setAccount(result.account);
        applyEnvelope(result);
        applyParams(result);
      })
      .catch(() => writeToken(null));
  }, [applyEnvelope, applyParams]);  // 登录后开始撮合轮询；标签页隐藏时暂停，回到前台立即补一轮
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
        setShowApi(false);
        if (typing) target?.blur();
        else if (focusMode && !showRules && !showApi) toggleFocus();
        else setSearch('');
        return;
      }
      if (typing || showRules || showApi) return;
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
        return;
      }
      // M 切市场：中美时段互补，晚上从 A 股切到美股是最常用的一步
      if (event.key === 'm' || event.key === 'M') {
        event.preventDefault();
        switchMarket(market === 'us' ? 'cn' : 'us');
        return;
      }
      // A 打开 API 面板：程序化下单的人每天都要找密钥，不该藏在三步之外
      if (event.key === 'a' || event.key === 'A') {
        event.preventDefault();
        setShowApi(true);
        return;
      }
      // [ ] \ 分别收起/展开左列表、右下单、下账本；F 一键专注（三块全收），Esc 退出专注
      if (event.key === '[' || event.key === ']' || event.key === '\\') {
        event.preventDefault();
        togglePanel(event.key === '[' ? 'list' : event.key === ']' ? 'ticket' : 'book');
        return;
      }
      if (event.key === 'f' || event.key === 'F') {
        event.preventDefault();
        toggleFocus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [focusMode, market, mobile, selected, showApi, showRules, switchMarket, toggleFocus, togglePanel, visibleRows, user]);

  async function submitAuth(action: 'login' | 'register', payload: Record<string, string>) {
    const result = await api<{
      token: string; user: User; accounts?: Record<Market, Account>;
    }>(action, payload);
    writeToken(result.token);
    setUser(result.user);
    // 开户直接铺上当前市场那份账，省掉一次「先看到 0.00 再等同步」的空窗
    setAccount(result.accounts ? result.accounts[market] ?? null : null);
    toast.success(action === 'register'
      ? (result.accounts
        ? `开户完成：人民币子账户 ${money(result.accounts.cn.netAssets, 'CNY')} · 美元子账户 ${money(result.accounts.us.netAssets, 'USD')}`
        : '开户完成，两个市场的虚拟本金已到账')
      : `欢迎回来，${result.user.display}`);
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
  }  // 交易范围不限于行情池：A 股任意 6 位代码、美股任意股票代码都能即时取价下单
  async function resolveSymbol(code: string): Promise<Quote | null> {
    const clean = code.trim();
    const us = market === 'us';
    if (us ? !/^[A-Za-z][A-Za-z0-9._-]{0,9}$/.test(clean) : !/^\d{6}$/.test(clean)) return null;
    const pool = [...(board?.indexes ?? []), ...(board?.etfs ?? []), ...(board?.stocks ?? [])];
    const known = pool.find((quote) => quote.code.toUpperCase() === clean.toUpperCase());
    if (known) { setSelected(known.secid); setResolved(null); return known; }
    setResolving(true);
    try {
      // A 股可按首位数字猜交易所，美股同一代码分散在三个交易所，只能交给检索接口定位
      const secid = us ? await findUsSecid(clean) : `${/^[569]/.test(clean) ? '1' : '0'}.${clean}`;
      if (!secid) throw new ApiError(`未找到 ${clean}，请确认它已在纳斯达克或纽交所上市`, 'unknown_symbol');
      const result = await api<{ quote: Quote }>('lookup', { secid });
      setSelected(result.quote.secid);
      setResolved(result.quote);
      return result.quote;
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : `未找到 ${clean}，请确认代码${us ? '上市地点' : '属于沪、深或北交所'}`);
      return null;
    } finally {
      setResolving(false);
    }
  }

  async function findUsSecid(symbol: string): Promise<string | null> {
    const hit = await api<{ rows: SearchRow[] }>('search', { q: symbol });
    const rows = hit.rows ?? [];
    const tradable = rows.filter((row) => row.kind !== 'index');
    return tradable.find((row) => row.code.toUpperCase() === symbol.toUpperCase())?.secid
      ?? tradable[0]?.secid ?? null;
  }
  if (!user) return <Auth board={board} session={session} onSubmit={submitAuth} />;
  // 持仓标的即使不在行情池里也要能显示与切换，用持仓字段合成
  const heldQuotes: Quote[] = (account?.positions ?? []).map((position) => ({
    secid: position.symbol, code: position.code, name: position.name,
    kind: position.kind as Quote['kind'],
    last: position.price, prevClose: position.prevClose ?? position.price,
    open: null, high: null, low: null, change: 0, pct: position.pct,
    volume: 0, amount: 0, turnover: null, marketCap: null,
    // 美股没有当日涨跌停，持仓合成时保持 null，别让价格标签长出「涨停」两个字
    limitUp: marketOfSecid(position.symbol) === 'us' ? null : position.limitUp ?? position.price,
    limitDown: marketOfSecid(position.symbol) === 'us' ? null : position.limitDown ?? position.price,
    limitRatio: marketOfSecid(position.symbol) === 'us' ? 0 : 0.1,
    tick: tickOfSecid(position.symbol, position.kind),
    ts: 0, sealedUp: false, sealedDown: false,
  }));
  const pool = [...(board?.indexes ?? []), ...(board?.stocks ?? []), ...(board?.etfs ?? []), ...heldQuotes];
  const selectedQuote = resolved && resolved.secid === selected ? resolved
    : pool.find((quote) => quote.secid === selected) ?? null;
  const ratio = account?.guaranteeRatio ?? null;
  // 收益率看合并口径：两个子账户按同一汇率折成人民币，切市场不会再让数字跳一大截
  const base = combined?.startCash ?? account?.startCash ?? START_CASH;
  const netForRet = combined?.netAssets ?? account?.netAssets ?? 0;
  const ret = base > 0 ? netForRet / base - 1 : 0;
  const position = (account?.positions ?? []).find((item) => item.symbol === selected) ?? null;
  const markers: Marker[] = [];
  if (position && account) {
    markers.push({ price: position.avgCost, label: position.side === 'long' ? '成本' : '券成本', tone: 'cost' });
    if (position.side === 'long' && position.liquidationPrice) {
      const liq = position.liquidationPrice;
      if (liq > 0 && liq < position.price) markers.push({ price: liq, label: '强平', tone: 'liq' });
    }
  }

  const pickSymbol = (secid: string) => {
    setSelected(secid);
    setResolved(null);
    if (mobile) setView('trade'); // 手机上选完标的直接进下单页，省一次滚动
  };
  const marketPanel = (
    <MarketPanel board={board} selected={selected} held={heldQuotes}
      watch={watch} watchQuotes={watchQuotes} compact={mobile}
      filter={filter} onFilter={setFilter} onSelect={pickSymbol}
      onPick={(item) => { pickSearch(item); if (mobile) setView('trade'); }} onToggleWatch={(entry) => void toggleWatch(entry)}
      searchText={search} onSearch={setSearch} onRowsChange={setVisibleRows} onMove={moveWatch} />
  );
  const detail = <DetailPanel quote={selectedQuote} markers={markers} compact={mobile} onToast={(message) => toast(message)} />;
  const book = (
    <Book account={account} orders={orders} trades={trades} events={events} lines={lines}
      curve={curve} leader={leader} startCash={account?.startCash ?? START_CASH} today={clock?.day ?? session?.day ?? ''}
      market={market} side={side} combined={combined}
      onSelect={pickSymbol} onCancel={(id) => void cancelOrder(id)} />
  );
  const ticket = (
    <Ticket quote={selectedQuote} account={account} held={heldQuotes} lines={lines} resolving={resolving}
      onResolve={resolveSymbol} onFilled={(message) => toast.success(message)}
      onDuplicate={(confirm) => toast.warning('已有一笔完全相同的委托', {
        description: '15 秒内重复提交，通常是连点。确实要再来一笔请点确认。',
        duration: 12_000, closeButton: true,
        action: { label: '确认重复下单', onClick: () => confirm() },
      })} />
  );
  const onAdmin = route.startsWith('#/admin') && user.role === 'admin';
  const frozen = user.status === 'frozen';
  // 收起哪一栏就从网格里去掉哪一列：留着 0px 列会白占一份 gap，图表反而宽不出来
  const desktopColumns = [
    panels.list ? 'minmax(230px,18rem)' : null,
    'minmax(0,1fr)',
    panels.ticket ? 'minmax(300px,21rem)' : null,
  ].filter(Boolean).join(' ');
  return (
    <div className="flex h-dvh flex-col overflow-hidden">
      <header className="z-20 shrink-0 border-b border-hairline bg-background/92 backdrop-blur">
        <div className={`flex flex-wrap items-center gap-y-1 ${mobile ? 'gap-x-2 px-3 py-1.5' : 'gap-x-4 px-4 py-2'}`}>
          <div className="flex items-baseline gap-2 border-l-2 border-primary pl-2">
            <span className={`font-semibold tracking-[0.2em] ${mobile ? 'text-[1.0625rem]' : 'text-[1.1875rem]'}`}>镜盘</span>
            {!mobile && <span className="num text-[0.625rem] tracking-[0.25em] text-primary">MIRROR DESK</span>}
          </div>          <MarketChips markets={markets} active={market} compact={mobile} onPick={switchMarket} />
          {stale && <span className="chip border-warn/45 bg-warn/12 text-warn">{MARKET_NAME[market]}行情非当日数据 · 休市不撮合</span>}          {paused && <span className="chip border-warn/60 bg-warn/15 text-warn">后台已暂停{MARKET_NAME[market]}撮合 · 新委托会被拒</span>}          <div className="num ml-auto flex flex-wrap items-center gap-x-4 gap-y-1">
            <span className="flex flex-col items-end leading-tight">
              <span className="text-[0.6562rem] tracking-[0.06em] text-ink-dim">折合人民币净资产</span>
              <span className="text-[1.0625rem] font-semibold">{money(combined?.netAssets ?? account?.netAssets ?? 0, 'CNY')}</span>
            </span>
            <span className="flex flex-col items-end leading-tight">
              <span className="text-[0.6562rem] tracking-[0.06em] text-ink-dim">{MARKET_NAME[market]}可用</span>
              <span className="text-[0.875rem]">{money(account?.cash ?? 0, cur)}</span>
            </span>
            {(account?.totalDebt ?? 0) > 0 && (
              <span className="flex flex-col items-end leading-tight">
                <span className="text-[0.6562rem] tracking-[0.06em] text-ink-dim">总负债</span>
                <span className="text-[0.875rem] text-warn">{money(account?.totalDebt ?? 0, cur)}</span>
              </span>
            )}
            {side && (
              <button type="button" onClick={() => switchMarket(side.market)} title={`切换到${MARKET_NAME[side.market]}子账户`}
                className="flex flex-col items-end leading-tight text-ink-dim transition hover:text-foreground">
                <span className="text-[0.6562rem] tracking-[0.06em]">{MARKET_NAME[side.market]}净资产</span>
                <span className="text-[0.875rem]">{money(side.netAssets, side.currency)}</span>
              </button>
            )}
            <Gauge ratio={ratio} ret={ret} compact={mobile} lines={lines} market={market} />
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
            {user.role === 'admin' && (
              <button type="button" onClick={() => { window.location.hash = onAdmin ? '' : '#/admin'; }}
                className={`chip transition-colors duration-75 active:translate-y-px ${onAdmin ? 'border-primary bg-primary/15 text-primary' : 'border-primary/50 text-primary hover:bg-primary/12'}`}>
                {onAdmin ? '返回交易台' : '后台'}
              </button>
            )}
            <button type="button" onClick={() => setShowApi(true)}
              className="chip border-primary/45 text-primary transition hover:bg-primary/12"
              title="API 接口与密钥（快捷键 A）">API</button>
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
      </header>      {(banner || frozen) && (
        <p role="alert" className="border-b border-up/40 bg-up/10 px-4 py-1.5 text-xs text-up">
          {banner || '该账户已被后台冻结：不能下单，撤单与查询仍可用'}
        </p>
      )}      {onAdmin ? (
        <main className="flex min-h-0 flex-1 flex-col p-3">
          <Admin onExit={() => { window.location.hash = ''; }} />
        </main>
      ) : mobile ? (
        <main className="min-h-0 flex-1 overflow-hidden p-2">
          {view === 'quote' && (
            <div className="view-in flex h-full min-h-0 flex-col gap-2">
              <div className="h-[40%] min-h-[176px] shrink-0">{detail}</div>
              <div className="min-h-0 flex-1">{marketPanel}</div>
            </div>
          )}
          {view === 'trade' && <div className="view-in h-full">{ticket}</div>}
          {view === 'account' && <div className="view-in h-full">{book}</div>}
        </main>
      ) : (
        <main className="relative grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)] gap-3 overflow-hidden p-3"
          style={{ gridTemplateColumns: desktopColumns }}>
          {panels.list && marketPanel}
          <div className="scrollbar-thin flex min-h-0 flex-col gap-3 overflow-y-auto">
            <div className={panels.book ? 'min-h-[320px] flex-[6]' : 'min-h-0 flex-1'}>{detail}</div>
            {panels.book && <div className="min-h-[260px] flex-[5]">{book}</div>}
          </div>
          {panels.ticket && ticket}
          {!panels.list && <EdgeTab side="left" label={PANEL_LABEL.list} onClick={() => togglePanel('list')} />}
          {!panels.ticket && <EdgeTab side="right" label={PANEL_LABEL.ticket} onClick={() => togglePanel('ticket')} />}
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
            <kbd className="ml-2 rounded border border-hairline px-1">M</kbd> 切市场
            <kbd className="ml-2 rounded border border-hairline px-1">A</kbd> API
            <kbd className="ml-2 rounded border border-hairline px-1">Enter</kbd> 下单
            <kbd className="ml-2 rounded border border-hairline px-1">[ ] \</kbd> 收面板
            <kbd className="ml-2 rounded border border-hairline px-1">F</kbd> 专注
          </span>
          行情源：东方财富公开接口 · 每 {SYNC_MS / 1000} 秒撮合一轮 · 市价单以最新价全额成交 ·
          {market === 'us'
            ? ' 美股 T+0、1 股起、无每日涨跌停，两融与担保比例按 Reg T 口径'
            : ' 股票 T+1、100 股一手，涨跌停与两融担保比例按真实规则校验'} ·
          {fx > 0 ? ` · 美元折人民币 ${(fx / Y).toFixed(4)}` : ''} · 虚拟资金，不构成投资建议
          <PanelToggles panels={panels} focusMode={focusMode} onToggle={togglePanel} onFocus={toggleFocus} />
        </footer>
      )}      {showRules && <Rules extra={reasons} market={market} onClose={() => setShowRules(false)} />}
      {showApi && <ApiDocs onClose={() => setShowApi(false)} />}
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
}/** 收起来的栏要在原地留一个把手：竖排小标签贴着边，一次点击就能把那一栏叫回来 */
function EdgeTab({ side, label, onClick }: { side: 'left' | 'right'; label: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} aria-label={`展开${label}`} title={`展开${label}`}
      className={`absolute top-1/2 z-10 flex -translate-y-1/2 items-center rounded border border-hairline bg-panel/95 px-0.5 py-3 text-ink-dim shadow-sm transition hover:border-primary/50 hover:text-primary ${side === 'left' ? 'left-0.5' : 'right-0.5'}`}>
      <span className="text-[0.6875rem] tracking-[0.15em] [writing-mode:vertical-rl]">{label}</span>
    </button>
  );
}

/** 面板显隐放在页脚常驻：栏收起后它自己的开关也跟着不见了，控制器必须待在不会被收起的地方 */
function PanelToggles({ panels, focusMode, onToggle, onFocus }: {
  panels: Panels;
  focusMode: boolean;
  onToggle: (key: keyof Panels) => void;
  onFocus: () => void;
}) {
  return (
    <span role="group" aria-label="面板显隐" className="num ml-auto flex shrink-0 flex-wrap items-center gap-1">
      {(Object.keys(PANEL_LABEL) as (keyof Panels)[]).map((key) => (
        <button key={key} type="button" onClick={() => onToggle(key)} aria-pressed={panels[key]}
          title={`${panels[key] ? '收起' : '展开'}${PANEL_LABEL[key]}（快捷键 ${PANEL_KEY_HINT[key]}）`}
          className={`flex items-center gap-1 rounded border px-1.5 py-0.5 transition ${panels[key]
            ? 'border-hairline text-foreground' : 'border-dashed border-hairline text-ink-dim hover:text-foreground'}`}>
          <kbd className="rounded border border-hairline px-1 text-[0.625rem]">{PANEL_KEY_HINT[key]}</kbd>
          {PANEL_LABEL[key]}
        </button>
      ))}
      <button type="button" onClick={onFocus} aria-pressed={focusMode}
        title={focusMode ? '恢复三块面板（Esc）' : '只看图表：收起行情列表、下单与账本（F）'}
        className={`flex items-center gap-1 rounded border px-1.5 py-0.5 transition ${focusMode
          ? 'border-primary bg-primary/15 text-primary' : 'border-primary/45 text-primary hover:bg-primary/12'}`}>
        <kbd className="rounded border border-hairline px-1 text-[0.625rem]">F</kbd>
        {focusMode ? '退出专注' : '专注看图'}
      </button>
    </span>
  );
}

/** 市场开关即双市时段状态：中美时段互补，两个 chip 同时说清「哪边在交易、我现在看哪边」 */
const PHASE_SHORT: Record<string, string> = {
  open: '盘中', auction: '竞价', lunch: '午休', closed: '收盘', pre: '盘前', after: '盘后',
};

function MarketChips({ markets, active, compact, onPick }: {
  markets: Record<Market, MarketStatus> | null;
  active: Market;
  compact: boolean;
  onPick: (market: Market) => void;
}) {
  if (!markets) {
    return (
      <span role="group" aria-label="交易市场" className="chip gap-0.5 border-hairline p-0.5">
        {(['cn', 'us'] as Market[]).map((item) => (
          <button key={item} type="button" onClick={() => onPick(item)} aria-pressed={item === active}
            className={`rounded px-2 py-1 text-[0.75rem] ${item === active ? 'bg-primary/20 text-primary' : 'text-ink-dim hover:text-foreground'}`}>
            {MARKET_NAME[item]}
          </button>
        ))}
      </span>
    );
  }
  return (
    <span role="group" aria-label="交易市场与开市状态" className="flex items-center gap-1">
      {(['cn', 'us'] as Market[]).map((item) => {
        const status = markets[item];
        const on = item === active;
        const label = compact ? (PHASE_SHORT[status?.session.phase] ?? '收盘')
          : sessionLabel(item, status?.session.phase);
        return (
          <button key={item} type="button" onClick={() => onPick(item)} aria-pressed={on}
            title={`${MARKET_NAME[item]}子账户 · ${status?.currency} · ${status?.day ?? ''}`}
            className={`chip num min-h-7 border transition-colors duration-75 active:translate-y-px ${status?.matchable
              ? 'border-down/40 bg-down/12 text-down' : 'border-hairline bg-muted text-muted-foreground'} ${on
              ? 'ring-1 ring-primary/50' : 'opacity-75 hover:opacity-100'}`}>
            <span className={`inline-block size-1.5 rounded-full ${status?.matchable ? 'bg-down' : 'bg-flat'}`} />
            {MARKET_NAME[item]} {label}
            {on && status?.matchable && <span className="opacity-70">{status.session.stamp.slice(11, 16)}</span>}
          </button>
        );
      })}
    </span>
  );
}

/** 维持担保比例仪表签：一条迷你刻度 + 阶梯线，比纯数字更快判断风险 */
function Gauge({ ratio, ret, compact, lines, market }: {
  ratio: number | null; ret: number; compact: boolean; lines: Lines; market: Market;
}) {
  const from = 1.1;
  const to = Math.max(2.6, lines.open + 0.5);
  const span = to - from;
  const pct = ratio === null ? null : Math.max(0, Math.min(1, (ratio - from) / span));
  const tone = ratio === null ? 'text-muted-foreground' : ratio < lines.liquid ? 'text-up' : ratio < lines.call ? 'text-warn' : 'text-down';
  return (
    <span className={`flex items-end gap-2 ${compact ? '' : 'border-l border-hairline pl-4'}`}>
      <span className="flex flex-col items-end leading-tight">
        <span className="text-[0.6562rem] tracking-[0.06em] text-ink-dim">{MARKET_NAME[market]}维持担保比例</span>
        <span className={`text-[0.9375rem] font-semibold ${tone}`}>{ratioText(ratio)}</span>
      </span>
      {!compact && (
        <span className="relative mb-1 block h-1.5 w-16 overflow-hidden rounded-full bg-muted" aria-hidden="true">
          {[lines.liquid, lines.call, lines.warn].map((line, index) => (
            <span key={index} className="absolute inset-y-0 w-px bg-foreground/35" style={{ left: `${((line - from) / span) * 100}%` }} />
          ))}
          {pct !== null && <span className={`absolute inset-y-0 left-0 rounded-full ${ratio! < lines.liquid ? 'bg-up' : ratio! < lines.call ? 'bg-warn' : 'bg-down'}`} style={{ width: `${pct * 100}%` }} />}
        </span>
      )}
      <span className={`chip num mb-0.5 ${ret >= 0 ? 'border-up/40 bg-up/12 text-up' : 'border-down/40 bg-down/12 text-down'}`}>
        {`${ret >= 0 ? '+' : ''}${(ret * 100).toFixed(2)}%`}
      </span>
    </span>
  );
}
