import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { api, ApiError, messageFor } from '../api';
import {
  MARKET_NAME, SIDE_LABEL, STATUS_LABEL, clockTime, marketOfSecid, money, percent, ratioText, tone,
  type Market,
} from '../format';

type Tab = 'overview' | 'users' | 'orders' | 'settings' | 'quote' | 'audit';
const TABS: { key: Tab; label: string }[] = [
  { key: 'overview', label: '概览' },
  { key: 'users', label: '账户' },
  { key: 'orders', label: '流水' },
  { key: 'settings', label: '参数' },
  { key: 'quote', label: '行情源' },
  { key: 'audit', label: '审计' },
];

const YUAN = 1_000_000;

type Stats = { orders: number; filled: number; rejected: number; canceled: number; live: number; trades: number; fees: number; turnover: number; reasons: Record<string, number>; truncated: boolean };
type Fees = Record<string, number>;
type Desk = { fees: Fees; rates: { margin: number; short: number }; lines: { open: number; warn: number; call: number; liquid: number; withdraw: number } };
type Settings = {
  register_enabled: boolean; invite_code: string;
  start_cash: number; start_cash_usd: number;
  match_paused: boolean; match_paused_us: boolean;
  params: Desk; us_params: Desk;
};
type Overview = {
  accounts: number; newToday: number; admins: number; locked: number; activeToday: number;
  stats: Stats; settings: Settings; recent: AuditRow[];
  params: Desk['lines']; usParams: Desk['lines']; breakers?: Record<Market, boolean>;
  risk: { belowCall: number; belowLiquid: number; leveraged: number };
  quote?: {
    source: string; lastCheck: LastCheck | null;
    cn: { ok: boolean; fresh: boolean; rows: number; note: string | null; partial: string; dataAgeMinutes: number | null; staleWarn: boolean };
    us: { ok: boolean; fresh: boolean; rows: number; note: string | null; partial: string; dataAgeMinutes: number | null; staleWarn: boolean };
  };
};
type OrderRow = {
  id: string; who: string; secid: string; code: string; name: string; side: string; qty: number; status: string;
  reason: string | null; source: string | null; day: string; created_at: string; price: number | null; fee: number;
};
type Row = {
  id: string; username: string; display: string; role: string; status: string;
  created_at: string; last_login: string | null; fail_count: number; locked_until: string | null;
  start_cash: number; start_cash_usd?: number; base?: number;
  net_assets: number | null; total_assets: number | null; total_debt: number;
  ret: number | null; ratio: number | null;
};
type AuditRow = { id: string; actor: string | null; action: string; target: string | null; detail: string | null; created_at: string };

type QuoteSource = {
  listHost: string; singleHost: string; histHost: string; searchHost: string;
  timeoutMs: number; cnTtlMs: number; usTtlMs: number; fxTtlMs: number;
  trendsTtlMs: number; klineTtlMs: number; cnPoolSize: number; usPoolSize: number; indexPoolSize: number;
  etfs: string[]; staleWarnMinutes: number;
};
type QuoteHealth = {
  market: string; ok: boolean; fresh: boolean; rows: number; note: string | null; partial: string;
  ageMs: number | null; ttlMs: number; day: string; today: string; dataTs: number | null;
  dataAgeMinutes: number | null; staleWarn: boolean; host: string;
};
type QuoteStatus = {
  source: QuoteSource; defaults: QuoteSource; hosts: string[];
  probes: { key: string; label: string; note: string }[];
  health: { cn: QuoteHealth; us: QuoteHealth }; fx: number; lastCheck: LastCheck | null;
};
type ProbeRow = {
  key: string; label?: string; host?: string; ok: boolean; ms: number;
  rows?: number; sample?: string; ts?: number | null; error?: string;
};
type LastCheck = { at: string; verdict: string; okCount: number; total: number; slowest: number };
type QuoteCheck = {
  results: ProbeRow[]; verdict: 'ok' | 'partial' | 'down'; okCount: number; total: number;
  health: { cn: QuoteHealth; us: QuoteHealth }; advice: string[]; source: QuoteSource; checkedAt: string;
};

// 数值项的展示顺序与说明；边界值由服务端校验，这里只负责写清楚每一项在管什么
const SOURCE_FIELDS: { key: keyof QuoteSource; label: string; hint: string }[] = [
  { key: 'timeoutMs', label: '上游超时', hint: '毫秒，单次请求最长等待' },
  { key: 'cnTtlMs', label: '沪深快照间隔', hint: '毫秒，越小越新但越吃上游' },
  { key: 'usTtlMs', label: '美股快照间隔', hint: '毫秒' },
  { key: 'fxTtlMs', label: '汇率缓存', hint: '毫秒，只影响折算展示' },
  { key: 'trendsTtlMs', label: '分时缓存', hint: '毫秒' },
  { key: 'klineTtlMs', label: '日 K 缓存', hint: '毫秒' },
  { key: 'cnPoolSize', label: '沪深个股池', hint: '按成交额取前 N 只' },
  { key: 'usPoolSize', label:  '美股池', hint: '三个交易所合起来取前 N 只' },
  { key: 'indexPoolSize', label: '指数池', hint: '条数' },
  { key: 'staleWarnMinutes', label: '数据落后告警', hint: '分钟，只影响检测结论' },
];
const HOST_FIELDS: { key: keyof QuoteSource; label: string; hint: string }[] = [
  { key: 'listHost', label: '板块接口域名', hint: '沪深与美股池、美股指数都走它' },
  { key: 'singleHost', label: '单标的域名', hint: '池外标的补价与汇率' },
  { key: 'histHost', label: '历史接口域名', hint: '分时与日 K' },
  { key: 'searchHost', label: '检索接口域名', hint: '代码联想' },
];

const ACTION_LABEL: Record<string, string> = {
  admin_freeze: '冻结账户', admin_unfreeze: '解冻账户', admin_unlock: '解除登录锁定',
  admin_revoke_sessions: '强制下线', admin_role: '调整角色', admin_grant_cash: '资金调整', admin_settings: '修改参数',
};

const round2 = (value: number) => Math.round(value * 100) / 100;

// 每个市场一套费用字段名，单位口径也不同，所以用表单描述而不是写死控件。
// micro 字段存的是微单位（元/美元），必须用除法与四舍五入换算，乘 1e-6 会显示成 8.2999999999
type FeeField = { key: string; label: string; hint: string; scale?: number; micro?: boolean };
const FEE_FIELDS: Record<Market, FeeField[]> = {
  cn: [
    { key: 'stockCommission', label: '股票佣金', hint: '万分之', scale: 1e4 },
    { key: 'etfCommission', label: 'ETF 佣金', hint: '万分之', scale: 1e4 },
    { key: 'commissionMin', label: '最低佣金', hint: '元', micro: true },
    { key: 'stampTax', label: '印花税（卖出）', hint: '千分之', scale: 1e3 },
    { key: 'transferFee', label: '过户费', hint: '万分之', scale: 1e4 },
  ],
  us: [
    { key: 'commission', label: '佣金', hint: '万分之', scale: 1e4 },
    { key: 'commissionMin', label: '最低佣金', hint: '美元', micro: true },
    { key: 'secFee', label: 'SEC 费（卖出）', hint: '万分之', scale: 1e4 },
    { key: 'activityPerShare', label: 'FINRA 活动费', hint: '美元/股', micro: true },
    { key: 'activityCap', label: '活动费单笔上限', hint: '美元', micro: true },
  ],
};
const feeShow = (raw: number, field: FeeField) => (field.micro ? raw / YUAN : raw * (field.scale ?? 1));
const feeStore = (value: number, field: FeeField) => (field.micro ? Math.round(value * YUAN) : value / (field.scale ?? 1));

const deskOf = (draft: Settings, market: Market): Desk => (market === 'us' ? draft.us_params : draft.params);
const withDesk = (draft: Settings, market: Market, next: Desk): Settings =>
  (market === 'us' ? { ...draft, us_params: next } : { ...draft, params: next });
const patchGroup = <K extends 'fees' | 'rates' | 'lines',>(desk: Desk, group: K, part: Partial<Desk[K]>): Desk =>
  ({ ...desk, [group]: { ...desk[group], ...part } });

export function Admin({ onExit }: { onExit: () => void }) {
  const [tab, setTab] = useState<Tab>('overview');
  const [overview, setOverview] = useState<Overview | null>(null);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [total, setTotal] = useState(0);
  const [query, setQuery] = useState('');
  const [audit, setAudit] = useState<AuditRow[] | null>(null);
  const [flow, setFlow] = useState<{ rows: OrderRow[]; stats: Stats; day: string; offset: number; limit: number; hasMore: boolean } | null>(null);
  const [flowFilter, setFlowFilter] = useState<{ status: string; day: string }>({ status: '', day: '' });
  const [pending, setPending] = useState('');
  const [adjust, setAdjust] = useState<Row | null>(null);
  const [adjustMarket, setAdjustMarket] = useState<Market>('cn');
  const [amount, setAmount] = useState('10000');
  const [reason, setReason] = useState('');
  const [draft, setDraft] = useState<Settings | null>(null);
  const [defaults, setDefaults] = useState<{ cn: Desk; us: Desk } | null>(null);
  const [paramMarket, setParamMarket] = useState<Market>('cn');
  const [quote, setQuote] = useState<QuoteStatus | null>(null);
  const [quoteDraft, setQuoteDraft] = useState<QuoteSource | null>(null);
  const [check, setCheck] = useState<QuoteCheck | null>(null);
  const [checking, setChecking] = useState(false);
  const [loading, setLoading] = useState(false);
  const timer = useRef(0);

  // 危险动作的二次确认只维持 5 秒，超时自动收回，避免留下「点了就会执行」的悬空状态
  useEffect(() => {
    if (!pending) return undefined;
    const at = window.setTimeout(() => setPending(''), 5_000);
    return () => window.clearTimeout(at);
  }, [pending]);

  const load = useCallback(async (which: Tab, search = '') => {
    setLoading(true);
    try {
      if (which === 'overview') setOverview(await api<Overview>('admin_overview'));
      if (which === 'users') {
        const result = await api<{ rows: Row[]; total: number }>('admin_users', search ? { q: search } : {});
        setRows(result.rows); setTotal(result.total);
      }
      if (which === 'settings') {
        const result = await api<{
          settings: Settings;
          defaults: { params: Desk; us_params: Desk };
        }>('admin_settings');
        setDraft(result.settings);
        setDefaults({ cn: result.defaults.params, us: result.defaults.us_params });
      }
      if (which === 'audit') setAudit((await api<{ rows: AuditRow[] }>('admin_audit', { limit: 120 })).rows);
      if (which === 'quote') {
        const result = await api<QuoteStatus>('admin_quote_status');
        setQuote(result);
        setQuoteDraft(result.source);
      }
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : '后台数据读取失败');
    } finally {
      setLoading(false);
    }
  }, []);

  const loadFlow = useCallback(async (offset = 0) => {
    setLoading(true);
    try {
      const payload: Record<string, unknown> = { limit: 30, offset };
      if (flowFilter.status) payload.status = flowFilter.status;
      if (flowFilter.day) payload.day = flowFilter.day;
      setFlow(await api<{ rows: OrderRow[]; stats: Stats; day: string; offset: number; limit: number; hasMore: boolean }>('admin_orders', payload));
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : '流水读取失败');
    } finally {
      setLoading(false);
    }
  }, [flowFilter]);

  useEffect(() => {
    if (tab === 'orders') void loadFlow(0);
    else void load(tab, query);
  }, [tab]); // eslint-disable-line react-hooks/exhaustive-deps

  const search = (value: string) => {
    setQuery(value);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => { if (tab === 'users') void load('users', value); }, 220);
  };

  async function act(key: string, run: () => Promise<unknown>, done: string) {
    if (pending !== key) { setPending(key); toast('再点一次以确认', { description: '该操作会写入审计日志' }); return; }
    setPending('');
    try {
      await run();
      toast.success(done);
      void load(tab, query);
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : messageFor('request_failed'));
    }
  }

  return (
    <div className="panel flex h-full min-h-0 flex-col overflow-hidden">
      <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-hairline px-3 py-2">
        <div className="flex items-baseline gap-2 border-l-2 border-primary pl-2">
          <span className="text-[1.0625rem] font-semibold tracking-[0.14em]">后台管理</span>
          <span className="num text-[0.6875rem] tracking-[0.2em] text-primary">ADMIN DESK</span>
        </div>
        <div role="tablist" aria-label="后台分区" className="ml-2 flex gap-1">
          {TABS.map((item) => (
            <button key={item.key} type="button" role="tab" aria-selected={tab === item.key} onClick={() => setTab(item.key)}
              className={`rounded px-2.5 py-1 text-[0.8125rem] transition-colors duration-75 active:translate-y-px ${tab === item.key
                ? 'bg-surface-2 text-primary shadow-[inset_0_0_0_1px_var(--hairline)]'
                : 'text-muted-foreground hover:bg-surface-2/60 hover:text-foreground'}`}>
              {item.label}
            </button>
          ))}
        </div>
        <span className="num ml-auto text-[0.6875rem] text-ink-dim">{loading ? '同步中…' : '权限由服务端校验'}</span>
        <button type="button" onClick={() => (tab === 'orders' ? void loadFlow(flow?.offset ?? 0) : void load(tab, query))}
          className="rounded border border-hairline px-2 py-1 text-[0.75rem] transition-colors duration-75 hover:bg-surface-2 active:translate-y-px">刷新</button>
        <button type="button" onClick={onExit}
          className="rounded border border-primary/60 px-2 py-1 text-[0.75rem] text-primary transition-colors duration-75 hover:bg-primary/12 active:translate-y-px">返回交易台</button>
      </header>

      <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto p-3">
        {tab === 'overview' && (overview ? <OverviewPane data={overview} /> : <Empty text="概览加载中…" />)}

        {tab === 'users' && (
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <input value={query} onChange={(event) => search(event.target.value)} aria-label="搜索账户"
                placeholder="搜索用户名或昵称" className="h-8 w-56 rounded border border-hairline bg-raised px-2 text-xs outline-none focus:border-input" />
              <span className="num text-[0.75rem] text-ink-dim">共 {total} 个账户</span>
            </div>
            {rows === null ? <Empty text="账户加载中…" /> : rows.length === 0 ? <Empty text="没有匹配的账户" /> : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[62rem] border-collapse text-[0.8125rem]">
                  <thead>
                    <tr className="border-b border-hairline text-left text-[0.6875rem] text-ink-dim">
                      {['账户', '角色', '状态', '本金 ¥ / $', '净资产（折¥）', '收益率', '担保比例', '最后登录', '操作'].map((head) => (
                        <th key={head} className="px-2 py-1 font-normal">{head}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => (
                      <tr key={row.id} className="border-b border-hairline/40 transition-colors duration-75 hover:bg-surface-3">
                        <td className="px-2 py-1.5">
                          <span className="block truncate">{row.display}</span>
                          <span className="num block text-[0.6875rem] text-ink-dim">{row.username}
                            {row.fail_count > 0 && <em className="ml-1 not-italic text-warn">失败 {row.fail_count}</em>}
                          </span>
                        </td>
                        <td className="px-2"><Badge text={row.role === 'admin' ? '管理员' : '用户'} kind={row.role === 'admin' ? 'primary' : 'muted'} /></td>
                        <td className="px-2"><Badge text={row.status === 'frozen' ? '已冻结' : '正常'} kind={row.status === 'frozen' ? 'down' : 'muted'} /></td>
                        <td className="num px-2 text-right">
                          {money(row.start_cash, 'CNY')}
                          <span className="block text-[0.6875rem] text-ink-dim">{money(row.start_cash_usd ?? 0, 'USD')}</span>
                        </td>
                        <td className="num px-2 text-right">{row.net_assets === null ? '—' : money(row.net_assets, 'CNY')}</td>
                        <td className={`num px-2 text-right ${row.ret === null ? 'text-ink-dim' : tone(row.ret)}`}>{row.ret === null ? '—' : percent(row.ret * 100)}</td>
                        <td className="num px-2 text-right">{ratioText(row.ratio)}</td>
                        <td className="num px-2 text-[0.75rem] text-ink-dim">{row.last_login ? clockTime(row.last_login) : '未登录'}</td>
                        <td className="px-1 py-1">
                          <div className="flex flex-wrap gap-1">
                            <MiniButton armedKey={`freeze-${row.id}`} pending={pending} text={row.status === 'frozen' ? '已冻结' : '冻结'}
                              armed="确认冻结" disabled={row.status === 'frozen'}
                              onFire={() => act(`freeze-${row.id}`, () => api('admin_freeze', { userId: row.id, confirm: true }), `已冻结 ${row.display}`)} />
                            <MiniButton armedKey={`unfreeze-${row.id}`} pending={pending} text="解冻" armed="确认解冻"
                              disabled={row.status !== 'frozen'}
                              onFire={() => act(`unfreeze-${row.id}`, () => api('admin_unfreeze', { userId: row.id, confirm: true }), `已解冻 ${row.display}`)} />
                            <MiniButton armedKey={`unlock-${row.id}`} pending={pending} text="登录解锁" armed="确认解锁"
                              onFire={() => act(`unlock-${row.id}`, () => api('admin_unlock', { userId: row.id }), `已解除 ${row.display} 的登录锁定`)} />
                            <MiniButton armedKey={`kick-${row.id}`} pending={pending} text="强制下线" armed="确认下线"
                              onFire={() => act(`kick-${row.id}`, () => api('admin_revoke_sessions', { userId: row.id, confirm: true }), '该账户会话已全部下线')} />
                            <MiniButton armedKey={`role-${row.id}`} pending={pending} text={row.role === 'admin' ? '降为普通' : '设为管理员'}
                              armed="确认修改"
                              onFire={() => act(`role-${row.id}`, () => api('admin_role', { userId: row.id, role: row.role === 'admin' ? 'user' : 'admin', confirm: true }), '角色已更新')} />
                            <MiniButton armedKey="" pending="" text="资金调整" kind="primary" onFire={() => { setAdjust(row); setAmount('10000'); setReason(''); }} />
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {adjust && (
              <div className="rounded border border-hairline bg-raised p-3 text-xs">
                <p className="mb-2 text-[0.8125rem]">给 <b>{adjust.display}</b>（{adjust.username}）补单调整资金</p>
                <div className="flex flex-wrap items-center gap-2">
                  {/* 两个现金池各记各的账，调整必须先选边，不然美元会被记进人民币池 */}
                  <span role="group" aria-label="调整哪个现金池" className="flex gap-1">
                    {(['cn', 'us'] as Market[]).map((item) => (
                      <button key={item} type="button" onClick={() => setAdjustMarket(item)} aria-pressed={adjustMarket === item}
                        className={`rounded border px-2 py-1 transition-colors duration-75 active:translate-y-px ${adjustMarket === item
                          ? 'border-primary bg-primary/15 text-primary' : 'border-hairline text-ink-dim hover:text-foreground'}`}>
                        {MARKET_NAME[item]}池{item === 'us' ? '（$）' : '（¥）'}
                      </button>
                    ))}
                  </span>
                  <button type="button" onClick={() => setAmount(`-${Math.abs(Number(amount) || 0)}`)}
                    className="rounded border border-hairline px-2 py-1 transition-colors duration-75 hover:bg-surface-2 active:translate-y-px">出金</button>
                  <button type="button" onClick={() => setAmount(`${Math.abs(Number(amount) || 0)}`)}
                    className="rounded border border-hairline px-2 py-1 transition-colors duration-75 hover:bg-surface-2 active:translate-y-px">入金</button>
                  <input value={amount} onChange={(event) => setAmount(event.target.value)}
                    aria-label={`调整金额（${adjustMarket === 'us' ? '美元' : '元'}，负数为出金）`}
                    className="num h-8 w-32 rounded border border-hairline bg-panel px-2 outline-none focus:border-input" />
                  <input value={reason} onChange={(event) => setReason(event.target.value)} aria-label="调整原因"
                    placeholder="原因（写入审计）" className="h-8 w-48 rounded border border-hairline bg-panel px-2 outline-none focus:border-input" />
                  <MiniButton armedKey="grant" pending={pending} text="提交补单" armed="确认提交" kind="primary"
                    onFire={() => act('grant', () => api('admin_grant_cash', {
                      userId: adjust.id, market: adjustMarket,
                      side: Number(amount) < 0 ? 'out' : 'in', amount: Math.abs(Number(amount) || 0), reason, confirm: true,
                    }), `已入账到${MARKET_NAME[adjustMarket]}现金池`)} />
                  <button type="button" onClick={() => setAdjust(null)} className="rounded px-2 py-1 text-ink-dim hover:text-foreground">取消</button>
                </div>
                <p className="mt-2 text-[0.6875rem] leading-5 text-ink-dim">
                  调整以只追加的资金流水入账，不修改任何历史成交；任何时候都能从流水重放复原账户状态。
                  美元池的调整不会改变人民币可用资金，反之亦然。
                </p>
              </div>
            )}
          </div>
        )}

        {tab === 'orders' && (flow ? (
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <select value={flowFilter.status} onChange={(event) => setFlowFilter({ ...flowFilter, status: event.target.value })}
                aria-label="按委托状态筛选" className="h-8 rounded border border-hairline bg-raised px-2 text-xs outline-none focus:border-input">
                <option value="">全部状态</option>
                <option value="open">已报</option>
                <option value="filling">成交中</option>
                <option value="filled">已成交</option>
                <option value="canceled">已撤销</option>
                <option value="rejected">废单</option>
              </select>
              <input value={flowFilter.day} onChange={(event) => setFlowFilter({ ...flowFilter, day: event.target.value })}
                placeholder="交易日 YYYY-MM-DD" aria-label="按交易日筛选"
                className="num h-8 w-40 rounded border border-hairline bg-raised px-2 text-xs outline-none focus:border-input" />
              <MiniButton armedKey="" pending="" text="应用筛选" kind="primary" onFire={() => void loadFlow(0)} />
              <span className="num ml-auto text-[0.6875rem] text-ink-dim">
                {flow.day} · 委托 {flow.stats.orders} · 成交 {flow.stats.filled} · 废单 {flow.stats.rejected} · 在途 {flow.stats.live}
              </span>
            </div>
            {Object.keys(flow.stats.reasons ?? {}).length > 0 && (
              <div className="flex flex-wrap gap-1 text-[0.6875rem]">
                {Object.entries(flow.stats.reasons).sort((a, b) => b[1] - a[1]).map(([text, n]) => (
                  <span key={text} className="chip border-hairline bg-muted text-muted-foreground">{text}<b className="num ml-1">{n}</b></span>
                ))}
              </div>
            )}
            <div className="overflow-x-auto">
              <table className="w-full min-w-[52rem] border-collapse text-[0.8125rem]">
                <thead>
                  <tr className="border-b border-hairline text-left text-[0.6875rem] text-ink-dim">
                    {['时间', '账户', '市场', '标的', '方向', '数量', '委托价', '状态', '来源', '说明'].map((head) => (
                      <th key={head} className="px-2 py-1 font-normal">{head}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {flow.rows.map((row) => (
                    <tr key={row.id} className="border-b border-hairline/40 transition-colors duration-75 hover:bg-surface-3">
                      <td className="num px-2 py-1.5 text-[0.75rem] text-ink-dim">{row.created_at.slice(5, 19).replace('T', ' ')}</td>
                      <td className="px-2">{row.who}</td>
                      <td className="px-2 text-[0.6875rem] text-ink-dim">{MARKET_NAME[marketOfSecid(row.secid)]}</td>
                      <td className="px-2"><span className="block truncate">{row.name || row.code}</span>
                        <span className="num block text-[0.6875rem] text-ink-dim">{row.code}</span></td>
                      <td className="px-2">{SIDE_LABEL[row.side] ?? row.side}</td>
                      <td className="num px-2 text-right">{row.qty.toLocaleString('zh-CN')}</td>
                      <td className="num px-2 text-right">{row.price ? (row.price / YUAN).toFixed(row.price > 1e6 ? 2 : 3) : '市价'}</td>
                      <td className="px-2"><Badge text={STATUS_LABEL[row.status] ?? row.status}
                        kind={row.status === 'rejected' ? 'down' : row.status === 'filled' ? 'up' : 'muted'} /></td>
                      <td className="px-2 text-[0.6875rem] text-ink-dim">{row.source === 'system' ? '系统强平' : '用户'}</td>
                      <td className="max-w-[18rem] truncate px-2 text-[0.75rem] text-ink-dim" title={row.reason ?? ''}>{row.reason || '—'}</td>
                    </tr>
                  ))}
                  {flow.rows.length === 0 && (
                    <tr><td colSpan={10} className="px-2 py-10 text-center text-xs text-ink-dim">该条件下没有委托记录</td></tr>
                  )}
                </tbody>
              </table>
            </div>
            <div className="flex items-center gap-2 text-[0.6875rem] text-ink-dim">
              <MiniButton armedKey="" pending="" text="上一页" disabled={flow.offset <= 0} onFire={() => void loadFlow(Math.max(0, flow.offset - flow.limit))} />
              <span className="num">第 {Math.floor(flow.offset / flow.limit) + 1} 页 · 每页 {flow.limit} 条</span>
              <MiniButton armedKey="" pending="" text="下一页" disabled={!flow.hasMore} onFire={() => void loadFlow(flow.offset + flow.limit)} />
              <span className="ml-auto">只读视图：后台不能修改或删除任何委托与成交</span>
            </div>
          </div>
        ) : <Empty text="流水加载中…" />)}

        {tab === 'settings' && (draft ? (
          <div className="flex max-w-3xl flex-col gap-3 text-sm">
            <p className="text-[0.75rem] leading-6 text-ink-dim">
              这里只放「改了只影响未来」的参数：已落库的成交与费用永不重算，开户本金的历史值冻结在每个账户上，
              担保线只影响之后的判定，利率按挂牌价对存量负债继续计提。沪深与美股各一组参数，互不覆盖。
            </p>
            <div className="grid gap-2 sm:grid-cols-2">
              {/* 熔断是分市场的：停美股不该连带停掉 A 股撮合 */}
              {(['cn', 'us'] as Market[]).map((item) => (
                <label key={item} className="flex items-center justify-between gap-3 rounded border border-hairline bg-raised px-3 py-2">
                  <span>{MARKET_NAME[item]}撮合熔断
                    <span className="block text-[0.6875rem] text-ink-dim">开启后停掉该市场撮合与新委托，另一市场不受影响</span>
                  </span>
                  <input type="checkbox" checked={item === 'us' ? draft.match_paused_us : draft.match_paused}
                    onChange={(event) => setDraft(item === 'us'
                      ? { ...draft, match_paused_us: event.target.checked } : { ...draft, match_paused: event.target.checked })}
                    aria-label={`${MARKET_NAME[item]}撮合熔断`} className="size-4 accent-[var(--primary)]" />
                </label>
              ))}
              <label className="flex items-center justify-between gap-3 rounded border border-hairline bg-raised px-3 py-2">
                <span>允许新账户注册<span className="block text-[0.6875rem] text-ink-dim">关闭后注册请求直接拒绝，公网开放前先关这里</span></span>
                <input type="checkbox" checked={draft.register_enabled} onChange={(event) => setDraft({ ...draft, register_enabled: event.target.checked })}
                  aria-label="允许新账户注册" className="size-4 accent-[var(--primary)]" />
              </label>
              <label className="flex items-center justify-between gap-3 rounded border border-hairline bg-raised px-3 py-2">
                <span>注册邀请码<span className="block text-[0.6875rem] text-ink-dim">留空表示不需要邀请码</span></span>
                <input value={draft.invite_code} onChange={(event) => setDraft({ ...draft, invite_code: event.target.value })}
                  aria-label="注册邀请码" className="h-8 w-32 rounded border border-hairline bg-panel px-2 text-xs outline-none focus:border-input" />
              </label>
              <Field label="新账户默认人民币本金" hint="元，只影响之后开的户" value={Math.round(draft.start_cash / YUAN)}
                onChange={(value) => setDraft({ ...draft, start_cash: value * YUAN })} />
              <Field label="新账户默认美元本金" hint="美元，美股子账户的起始资金" value={Math.round(draft.start_cash_usd / YUAN)}
                onChange={(value) => setDraft({ ...draft, start_cash_usd: value * YUAN })} />
            </div>

            <div role="tablist" aria-label="挂牌参数所属市场" className="flex items-center gap-1 pt-1">
              {(['cn', 'us'] as Market[]).map((item) => (
                <button key={item} type="button" role="tab" aria-selected={paramMarket === item} onClick={() => setParamMarket(item)}
                  className={`rounded px-2.5 py-1 text-[0.75rem] transition-colors duration-75 active:translate-y-px ${paramMarket === item
                    ? 'bg-surface-2 text-primary shadow-[inset_0_0_0_1px_var(--hairline)]' : 'text-muted-foreground hover:bg-surface-2/60'}`}>
                  {MARKET_NAME[item]}参数
                </button>
              ))}
              <span className="text-[0.6875rem] text-ink-dim">编辑哪一组只由这里决定，保存时两组一起提交</span>
            </div>

            <p className="pt-1 text-[0.6875rem] tracking-[0.08em] text-primary">{MARKET_NAME[paramMarket]}费用</p>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {FEE_FIELDS[paramMarket].map((field) => (
                <Field key={field.key} label={field.label} hint={field.hint}
                  value={feeShow(Number(deskOf(draft, paramMarket).fees[field.key] ?? 0), field)}
                  onChange={(value) => setDraft(withDesk(draft, paramMarket,
                    patchGroup(deskOf(draft, paramMarket), 'fees', { [field.key]: feeStore(value, field) })))} />
              ))}
            </div>

            <p className="pt-1 text-[0.6875rem] tracking-[0.08em] text-primary">{MARKET_NAME[paramMarket]}两融利率与风控线</p>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              <Field label="融资年利率" hint="%" value={round2(deskOf(draft, paramMarket).rates.margin * 100)}
                onChange={(value) => setDraft(withDesk(draft, paramMarket, patchGroup(deskOf(draft, paramMarket), 'rates', { margin: value / 100 })))} />
              <Field label="融券年利率" hint="%" value={round2(deskOf(draft, paramMarket).rates.short * 100)}
                onChange={(value) => setDraft(withDesk(draft, paramMarket, patchGroup(deskOf(draft, paramMarket), 'rates', { short: value / 100 })))} />
              {([
                ['open', '开仓线', '%，低于此值不给新开杠杆仓'],
                ['warn', '预警线', '%'],
                ['call', '追保线', '%'],
                ['liquid', '平仓线', '%，低于此值自动生成强平委托'],
                ['withdraw', '担保品卖出提取线', '%'],
              ] as const).map(([key, label, hint]) => (
                <Field key={key} label={label} hint={hint} value={round2(deskOf(draft, paramMarket).lines[key] * 100)}
                  onChange={(value) => setDraft(withDesk(draft, paramMarket, patchGroup(deskOf(draft, paramMarket), 'lines', { [key]: value / 100 })))} />
              ))}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <MiniButton armedKey="settings" pending={pending} text="保存参数" armed="确认保存" kind="primary"
                onFire={() => act('settings', () => api('admin_settings', {
                  // start_cash 的接口单位是「元/美元」，表单里存的是微单位，这里必须换算
                  patch: {
                    register_enabled: draft.register_enabled,
                    invite_code: draft.invite_code,
                    match_paused: draft.match_paused,
                    match_paused_us: draft.match_paused_us,
                    start_cash: Math.round(draft.start_cash / YUAN),
                    start_cash_usd: Math.round(draft.start_cash_usd / YUAN),
                    params: draft.params,
                    us_params: draft.us_params,
                  },
                  confirm: true,
                }), '参数已保存并立即生效')} />
              {defaults && (
                <MiniButton armedKey="reset" pending={pending} text={`恢复${MARKET_NAME[paramMarket]}默认参数`} armed="确认恢复"
                  onFire={() => act('reset', () => api('admin_settings', {
                    patch: paramMarket === 'us' ? { us_params: defaults.us } : { params: defaults.cn }, confirm: true,
                  }), `已恢复${MARKET_NAME[paramMarket]}默认挂牌参数`)} />
              )}
              <span className="text-[0.6875rem] text-ink-dim">保存与恢复都写入审计（含变更项对照）</span>
            </div>
          </div>
        ) : <Empty text="参数加载中…" />)}

        {tab === 'quote' && (quote && quoteDraft ? (
          <div className="flex flex-col gap-3 text-sm">
            <div className="grid gap-2 sm:grid-cols-2">
              <HealthCard item={quote.health.cn} fx={quote.fx} />
              <HealthCard item={quote.health.us} fx={quote.fx} />
            </div>

            <section className="rounded border border-hairline bg-raised p-3">
              <div className="flex flex-wrap items-center gap-2">
                <MiniButton armedKey="" pending="" text="立即检测八个端点" kind="primary"
                  onFire={async () => {
                    setChecking(true);
                    try {
                      setCheck(await api<QuoteCheck>('admin_quote_check'));
                      toast.success('检测完成');
                    } catch (error) {
                      toast.error(error instanceof ApiError ? error.message : '检测失败');
                    } finally {
                      setChecking(false);
                    }
                  }} />
                {checking && <span className="text-[0.75rem] text-ink-dim">探测中…</span>}
                {check && (
                  <span className={`chip num ${check.verdict === 'ok' ? 'border-down/40 bg-down/12 text-down'
                    : check.verdict === 'partial' ? 'border-warn/50 bg-warn/12 text-warn' : 'border-up/45 bg-up/12 text-up'}`}>
                    {check.verdict === 'ok' ? '全部可用' : check.verdict === 'partial' ? '部分可用' : '全部不可用'}
                    {' '}{check.okCount}/{check.total} · 最慢 {Math.max(...check.results.map((row) => row.ms), 0)}ms
                  </span>
                )}
                {quote.lastCheck && !check && (
                  <span className="num text-[0.6875rem] text-ink-dim">上次检测 {clockTime(quote.lastCheck.at)} · {quote.lastCheck.okCount}/{quote.lastCheck.total} 可用</span>
                )}
                <span className="ml-auto text-[0.6875rem] text-ink-dim">检测会真实请求上游，每分钟最多 12 次</span>
              </div>

              {check && (
                <div className="mt-3 overflow-x-auto">
                  <table className="w-full min-w-[46rem] border-collapse text-[0.8125rem]">
                    <thead>
                      <tr className="border-b border-hairline text-left text-[0.6875rem] text-ink-dim">
                        {['端点', '结果', '耗时', '域名', '条数', '样本', '说明'].map((head) => <th key={head} className="px-2 py-1 font-normal">{head}</th>)}
                      </tr>
                    </thead>
                    <tbody>
                      {check.results.map((row) => (
                        <tr key={row.key} className="border-b border-hairline/40">
                          <td className="px-2 py-1.5">{row.label ?? row.key}</td>
                          <td className="px-2"><Badge text={row.ok ? '可用' : '不可用'} kind={row.ok ? 'down' : 'up'} /></td>
                          <td className={`num px-2 text-right ${row.ms > 1500 ? 'text-warn' : ''}`}>{row.ms}ms</td>
                          <td className="num px-2 text-[0.75rem] text-ink-dim">{row.host ?? '—'}</td>
                          <td className="num px-2 text-right">{row.rows ?? '—'}</td>
                          <td className="num max-w-[16rem] truncate px-2 text-[0.75rem] text-ink-dim" title={row.sample ?? ''}>{row.sample || '—'}</td>
                          <td className="max-w-[18rem] truncate px-2 text-[0.75rem] text-up" title={row.error ?? ''}>{row.error || '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {check.advice.length > 0 && (
                    <ul className="mt-2 space-y-1 text-[0.75rem] leading-5 text-ink-dim">
                      {check.advice.map((line) => <li key={line} className="border-l border-warn/50 pl-2">{line}</li>)}
                    </ul>
                  )}
                </div>
              )}
            </section>

            <p className="text-[0.75rem] leading-6 text-ink-dim">
              域名只能从实测可用的清单里选：本运行时按 UTF-8 解 JSON，换成腾讯 / 新浪这类 GBK 源会整片乱码；
              而允许填任意主机等于给服务端开一个内网探测口。保存后缓存立即清空，下一次同步就用新配置，不用重启。
            </p>

            <section>
              <h3 className="mb-1.5 text-[0.6875rem] tracking-[0.08em] text-primary">接口域名</h3>
              <div className="grid gap-2 sm:grid-cols-2">
                {HOST_FIELDS.map((field) => (
                  <label key={field.key} className="flex items-center justify-between gap-3 rounded border border-hairline bg-raised px-3 py-2 text-xs">
                    <span>{field.label}<span className="block text-[0.6875rem] text-ink-dim">{field.hint}</span></span>
                    <select value={String(quoteDraft[field.key])} aria-label={field.label}
                      onChange={(event) => setQuoteDraft({ ...quoteDraft, [field.key]: event.target.value })}
                      className="num h-8 max-w-[15rem] rounded border border-hairline bg-panel px-1 text-[0.75rem] outline-none focus:border-input">
                      {quote.hosts.map((host) => <option key={host} value={host}>{host}</option>)}
                    </select>
                  </label>
                ))}
              </div>
            </section>

            <section>
              <h3 className="mb-1.5 text-[0.6875rem] tracking-[0.08em] text-primary">节奏与池子</h3>
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {SOURCE_FIELDS.map((field) => (
                  <Field key={field.key} label={field.label} hint={field.hint}
                    value={Number(quoteDraft[field.key] ?? 0)}
                    onChange={(value) => setQuoteDraft({ ...quoteDraft, [field.key]: Math.round(value) })} />
                ))}
              </div>
            </section>

            <label className="flex flex-col gap-1.5 rounded border border-hairline bg-raised px-3 py-2 text-xs">
              <span>指数 ETF 池<span className="ml-1 text-[0.6875rem] text-ink-dim">逗号分隔的 secid，最多 20 条；这些标的逐个补价，不在板块池里也能进列表</span></span>
              <input value={quoteDraft.etfs.join(', ')} aria-label="指数 ETF 池"
                onChange={(event) => setQuoteDraft({ ...quoteDraft, etfs: event.target.value.split(/[,，\s]+/).filter(Boolean) })}
                className="num h-8 rounded border border-hairline bg-panel px-2 text-[0.75rem] outline-none focus:border-input" />
              <span className="num text-[0.6875rem] text-ink-dim">当前 {quoteDraft.etfs.length} 条 · 默认 {quote.defaults.etfs.length} 条</span>
            </label>

            <div className="flex flex-wrap items-center gap-2">
              <MiniButton armedKey="quote-save" pending={pending} text="保存行情源配置" armed="确认保存" kind="primary"
                onFire={() => act('quote-save', () => api('admin_settings', { patch: { quote_source: quoteDraft }, confirm: true }), '行情源配置已保存并立即生效')} />
              <MiniButton armedKey="quote-reset" pending={pending} text="恢复默认配置" armed="确认恢复"
                onFire={() => act('quote-reset', () => api('admin_settings', { patch: { quote_source: quote.defaults }, confirm: true }), '已恢复默认行情源配置')} />
              <span className="text-[0.6875rem] text-ink-dim">保存与恢复都写入审计（含变更项对照）</span>
            </div>
          </div>
        ) : <Empty text="行情源加载中…" />)}

        {tab === 'audit' && (audit === null ? <Empty text="审计加载中…" /> : audit.length === 0 ? <Empty text="还没有后台操作记录" /> : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[44rem] border-collapse text-[0.8125rem]">
              <thead>
                <tr className="border-b border-hairline text-left text-[0.6875rem] text-ink-dim">
                  {['时间', '操作人', '动作', '对象', '详情'].map((head) => <th key={head} className="px-2 py-1 font-normal">{head}</th>)}
                </tr>
              </thead>
              <tbody>
                {audit.map((row) => (
                  <tr key={row.id} className="border-b border-hairline/40 transition-colors duration-75 hover:bg-surface-3">
                    <td className="num px-2 py-1.5 text-[0.75rem] text-ink-dim">{row.created_at.slice(5, 19).replace('T', ' ')}</td>
                    <td className="px-2">{row.actor ?? '系统'}</td>
                    <td className="px-2">{ACTION_LABEL[row.action] ?? row.action}</td>
                    <td className="num px-2">{row.target ?? '—'}</td>
                    <td className="num max-w-[26rem] truncate px-2 text-[0.75rem] text-ink-dim" title={row.detail ?? ''}>{row.detail ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      </div>
    </div>
  );
}

function OverviewPane({ data }: { data: Overview }) {
  const breakers = data.breakers ?? { cn: data.settings.match_paused, us: false };
  const q = data.quote;
  const quoteState = !q
    ? { label: '未取数', hint: '打开「行情源」页检测', className: 'text-ink-dim' }
    : (() => {
      const down = !q.cn.ok && !q.cn.rows && !q.us.ok && !q.us.rows;
      const stale = !q.cn.fresh || !q.us.fresh;
      const degraded = Boolean(q.cn.partial || q.us.partial);
      return {
        label: down ? '取不到' : degraded ? '部分降级' : stale ? '非当日' : '正常',
        hint: `沪深 ${q.cn.rows} 条 · 美股 ${q.us.rows} 条`
          + (q.cn.note || q.us.note ? ` · 上游错误 ${q.cn.note ?? q.us.note}` : '')
          + (down ? ' · 去「行情源」页逐项定位'
            : q.lastCheck ? ` · 上次检测 ${q.lastCheck.okCount}/${q.lastCheck.total} 可用` : ''),
        className: down ? 'text-up' : stale || degraded ? 'text-warn' : 'text-down',
      };
    })();
  const cards: { label: string; value: string; hint?: string; className?: string }[] = [
    { label: '账户总数', value: `${data.accounts}`, hint: `今日新增 ${data.newToday} · 今日活跃 ${data.activeToday}` },
    { label: '管理员', value: `${data.admins}`, hint: data.locked > 0 ? `${data.locked} 个账户处于登录锁定` : '无登录锁定' },
    { label: '今日委托', value: `${data.stats.orders}`, hint: `成交 ${data.stats.filled} · 废单 ${data.stats.rejected} · 在途 ${data.stats.live}` },
    { label: '今日成交', value: `${data.stats.trades} 笔`, hint: `成交额 ${money(data.stats.turnover, 'CNY')}（两市按当日汇率合并）` },
    { label: '今日手续费', value: money(data.stats.fees, 'CNY'), hint: '沪深按人民币、美股按美元分别计提' },
    {
      label: '风险账户', value: `${data.risk.belowLiquid} / ${data.risk.belowCall}`,
      hint: `负债账户 ${data.risk.leveraged} · 低于平仓线 / 追保线（合并口径按沪深线判）`,
      className: data.risk.belowLiquid > 0 ? 'text-up' : data.risk.belowCall > 0 ? 'text-warn' : 'text-down',
    },
    {
      label: '撮合', value: breakers.cn && breakers.us ? '两市熔断' : breakers.cn ? '沪深熔断' : breakers.us ? '美股熔断' : '正常',
      hint: `沪深 平仓 ${(data.params.liquid * 100).toFixed(0)}% / 追保 ${(data.params.call * 100).toFixed(0)}% · 美股 平仓 ${(data.usParams.liquid * 100).toFixed(0)}% / 开仓 ${(data.usParams.open * 100).toFixed(0)}%`,
      className: breakers.cn || breakers.us ? 'text-warn' : 'text-down',
    },
    {
      label: '注册', value: data.settings.register_enabled ? '开放' : '已关闭',
      hint: data.settings.invite_code ? '需要邀请码' : '无需邀请码', className: data.settings.register_enabled ? 'text-up' : 'text-warn',
    },
    {
      label: '行情源', value: quoteState.label,
      hint: quoteState.hint, className: quoteState.className,
    },
  ];
  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {cards.map((card) => (
          <div key={card.label} className="rounded border border-hairline bg-raised px-3 py-2.5">
            <p className="text-[0.6875rem] tracking-[0.08em] text-ink-dim">{card.label}</p>
            <p className={`num text-[1.375rem] leading-8 ${card.className ?? ''}`}>{card.value}</p>
            {card.hint && <p className="text-[0.6875rem] text-ink-dim">{card.hint}</p>}
          </div>
        ))}
      </div>
      {data.stats.truncated && <p className="text-[0.75rem] text-warn">当日流水超过 2000 条，统计按前 2000 条计算。</p>}
      <div className="rounded border border-hairline bg-raised">
        <p className="border-b border-hairline px-3 py-2 text-[0.6875rem] tracking-[0.08em] text-ink-dim">最近后台操作</p>
        {data.recent.length === 0 ? <p className="px-3 py-6 text-center text-xs text-ink-dim">还没有后台操作</p> : (
          <ul className="divide-y divide-hairline/40">
            {data.recent.map((row) => (
              <li key={row.id} className="flex flex-wrap items-baseline gap-x-3 px-3 py-1.5 text-[0.75rem] transition-colors duration-75 hover:bg-surface-3">
                <span className="num text-ink-dim">{row.created_at.slice(5, 19).replace('T', ' ')}</span>
                <span>{row.actor ?? '系统'}</span>
                <span className="text-primary">{ACTION_LABEL[row.action] ?? row.action}</span>
                <span className="num text-ink-dim">{row.target ?? ''}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
      <p className="text-[0.75rem] leading-6 text-ink-dim">
        后台权限来自 <span className="num">ADMIN_USERNAMES</span>；未配置该变量时所有后台接口一律 403。
        冻结只挡新的风险敞口，撤单与查询仍可用；资金调整以只追加流水入账，历史成交永不可改。
      </p>
    </div>
  );
}

// 行情健康卡：只报事实（条数、缓存年龄、数据落后多久、是否当日），结论留给检测
function HealthCard({ item, fx }: { item: QuoteHealth; fx: number }) {
  const state = !item.ok && !item.rows ? 'bad' : item.partial ? 'warn' : !item.fresh ? 'warn' : item.staleWarn ? 'warn' : 'ok';
  const toneMap = { ok: 'border-down/40 bg-down/12 text-down', warn: 'border-warn/50 bg-warn/12 text-warn', bad: 'border-up/45 bg-up/12 text-up' } as const;
  return (
    <div className={`rounded border px-3 py-2.5 text-xs ${toneMap[state]}`}>
      <p className="flex items-center justify-between gap-2">
        <span className="text-[0.8125rem] font-medium">{MARKET_NAME[item.market === 'us' ? 'us' : 'cn']}行情</span>
        <span className="num">{item.rows} 条</span>
      </p>
      <p className="num mt-1 text-[0.6875rem] leading-5">
        缓存 {item.ageMs === null ? '未取过' : `${(item.ageMs / 1000).toFixed(1)}s`} · 阈值 {(item.ttlMs / 1000).toFixed(1)}s
        · 数据落后 {item.dataAgeMinutes === null ? '—' : `${item.dataAgeMinutes} 分钟`}
      </p>
      <p className="num text-[0.6875rem] leading-5">
        系统日 {item.today} · 数据日 {item.day || '空'} · {item.fresh ? '当日数据，可撮合' : '非当日数据，不撮合'}
      </p>
      <p className="num truncate text-[0.6875rem] leading-5" title={item.host}>{item.host}</p>
      {(item.note || item.partial) && (
        <p className="mt-1 text-[0.6875rem] leading-5">{item.note ? `上游错误：${item.note}` : ''}{item.partial ? ` · 降级：${item.partial}` : ''}</p>
      )}
      {item.market === 'us' && <p className="num text-[0.6875rem] text-ink-dim">折算 {(fx / 1e6).toFixed(4)} ¥/$</p>}
    </div>
  );
}

function Badge({ text, kind }: { text: string; kind: 'up' | 'down' | 'primary' | 'muted' }) {  const map = {
    up: 'border-up/40 bg-up/12 text-up', down: 'border-down/40 bg-down/12 text-down',
    primary: 'border-primary/45 bg-primary/12 text-primary', muted: 'border-hairline bg-muted text-muted-foreground',
  } as const;
  return <span className={`chip num ${map[kind]}`}>{text}</span>;
}

function Empty({ text }: { text: string }) {
  return <p className="px-4 py-12 text-center text-xs text-ink-dim">{text}</p>;
}

function Field({ label, hint, value, onChange }: { label: string; hint: string; value: number; onChange: (value: number) => void }) {
  return (
    <label className="flex items-center justify-between gap-3 rounded border border-hairline bg-raised px-3 py-2 text-xs">
      <span>{label}<span className="block text-[0.6875rem] text-ink-dim">{hint}</span></span>
      <input type="number" step="any" value={Number.isFinite(value) ? value : 0}
        onChange={(event) => onChange(Number(event.target.value))}
        aria-label={`${label}（${hint}）`} className="num h-8 w-28 rounded border border-hairline bg-panel px-2 text-xs outline-none focus:border-input" />
    </label>
  );
}

function MiniButton({ armedKey, pending, text, armed = '确认执行', kind = 'default', disabled = false, onFire }: {
  armedKey: string; pending: string; text: string; armed?: string; kind?: 'default' | 'primary'; disabled?: boolean; onFire: () => void;
}) {
  const armedNow = Boolean(armedKey) && pending === armedKey;
  return (
    <button type="button" disabled={disabled} onClick={onFire}
      className={`rounded border px-1.5 py-0.5 text-[0.6875rem] transition-colors duration-75 active:translate-y-px disabled:opacity-35 ${armedNow
        ? 'border-warn/60 bg-warn/15 text-warn'
        : kind === 'primary' ? 'border-primary/50 text-primary hover:bg-primary/12'
          : 'border-hairline text-muted-foreground hover:bg-surface-2 hover:text-foreground'}`}>
      {armedNow ? armed : text}
    </button>
  );
}
