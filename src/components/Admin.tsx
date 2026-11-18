import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { api, ApiError, messageFor, writeToken } from '../api';
import {
  MARKET_NAME, SIDE_LABEL, STATUS_LABEL, clockTime, marketOfSecid, money, percent, ratioText, tone,
  type Market,
} from '../format';

type Tab = 'overview' | 'users' | 'orders' | 'settings' | 'quote' | 'backup' | 'audit';
const TABS: { key: Tab; label: string }[] = [
  { key: 'overview', label: '概览' },
  { key: 'users', label: '账户' },
  { key: 'orders', label: '流水' },
  { key: 'settings', label: '参数' },
  { key: 'quote', label: '行情源' },
  { key: 'backup', label: '备份' },
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
    cn: { ok: boolean; fresh: boolean; rows: number; note: string | null; partial: string; dataAgeMinutes: number | null; staleWarn: boolean; sourceLabel?: string | null; fellBack?: boolean };
    us: { ok: boolean; fresh: boolean; rows: number; note: string | null; partial: string; dataAgeMinutes: number | null; staleWarn: boolean; sourceLabel?: string | null; fellBack?: boolean };
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
  txQuoteHost: string; txListHost: string; txHistHost: string; txKlineHost: string;
  sinaQuoteHost: string; sinaListHost: string; sinaHistHost: string;
  timeoutMs: number; cnTtlMs: number; usTtlMs: number; fxTtlMs: number;
  trendsTtlMs: number; klineTtlMs: number; cnPoolSize: number; usPoolSize: number; indexPoolSize: number;
  etfs: string[]; staleWarnMinutes: number;
  sourceOrder: string[]; fallbackEnabled: boolean; cooldownMs: number;
};
type ProviderState = {
  key: string; label: string; hosts: string[]; caps: string[]; rank: number; enabled: boolean;
  failStreak: number; coolingFor: number; lastError: string | null; lastOkAt: string | null; lastMs: number | null;
};
type CoverageRow = { cap: string; label: string; ok: boolean; providers: string[]; failures: string[] };
type QuoteHealth = {
  market: string; ok: boolean; fresh: boolean; rows: number; note: string | null; partial: string;
  ageMs: number | null; ttlMs: number; day: string; today: string; dataTs: number | null;
  dataAgeMinutes: number | null; staleWarn: boolean; host: string;
  source: string | null; sourceLabel: string | null; fellBack: boolean;
};
type QuoteStatus = {
  source: QuoteSource; defaults: QuoteSource; hosts: string[];
  probes: { key: string; label: string; note: string; provider: string; providerLabel: string; cap: string }[];
  providers: ProviderState[];
  health: { cn: QuoteHealth; us: QuoteHealth }; fx: number;
  fxSource: { provider: string | null; label: string | null; fallback: boolean };
  lastCheck: LastCheck | null;
  proxy?: {
    settings: ProxyPolicy; defaults: ProxyPolicy; status: ProxyStatus; runtime: string; lastCheck: LastCheck | null;
    presets?: { key: string; label: string; url: string; docs: string; note: string }[];
  };
};
type ProbeRow = {
  key: string; label?: string; host?: string; ok: boolean; ms: number;
  provider?: string; providerLabel?: string; cap?: string; note?: string;
  rows?: number; sample?: string; ts?: number | null; error?: string;
};
type LastCheck = { at: string; verdict: string; okCount: number; total: number; slowest: number; activeSource?: string | null };
type QuoteCheck = {
  results: ProbeRow[]; verdict: 'ok' | 'partial' | 'down'; okCount: number; total: number;
  coverage: CoverageRow[]; dead: string[]; providers: ProviderState[];
  health: { cn: QuoteHealth; us: QuoteHealth }; advice: string[]; source: QuoteSource; checkedAt: string;
};

type UsageRow = { key: string; label: string; calls: number; ok: number; fail: number; avgMs: number };
type UsageLayer = { layer: string; label: string; hit: number; miss: number; merged: number; rate: number };
type UsageMinute = { at: string; calls: number; fail: number };
type QuoteUsage = {
  since: string; uptimeMs: number; windowMinutes: number;
  total: { calls: number; ok: number; fail: number; probe: number };
  byCap: UsageRow[]; byProvider: UsageRow[]; cache: UsageLayer[]; perMinute: UsageMinute[];
};

type ProxyPolicy = {
  enabled: boolean; mode: string; apiUrl: string; protocol: string; count: number;
  ttlMs: number; minPullMs: number; maxFails: number; connectMs: number; totalMs: number;
  directCoolMs: number; manual: string[];
};
type ProxyPoolRow = {
  addr: string; source: string; pinned: boolean; fails: number; ok: number; probes: number;
  blocked: boolean; usable: boolean; lastError: string | null; lastMs: number | null;
  lastOkAt: string | null; ageMs: number | null;
};
type ProxyStatus = {
  policy: ProxyPolicy; pool: ProxyPoolRow[]; alive: number;
  counters: {
    pulls: number; lastPullAt: string | null; lastPullError: string | null; served: number;
    lastVia: string | null; directOk: number; proxyOk: number; proxyFail: number; poolAgeMs: number | null;
  };
  direct: { fails: number; lastError: string | null; okAt: string | null; coolingMs: number };
};
type ProxyRow = { addr: string; ok: boolean; ms: number; rows?: number; error?: string; blocked?: boolean };
type ProxyCheckResult = {
  verdict: 'ok' | 'partial' | 'down'; okCount: number; total: number; results: ProxyRow[];
  pulled: { added?: number; error?: string | null; skipped?: boolean };
  advice: string[]; lastCheck: LastCheck | null; status: ProxyStatus;
  policy: { enabled: boolean; mode: string }; source: { apiUrl: string; mode: string; enabled: boolean };
};
type ProxyPull = { added?: number; pool?: number; error?: string | null; skipped?: boolean; status: ProxyStatus };

type BackupCounts = Record<string, number>;
type BackupDocument = {
  format: string; version: number; created_at: string; rows: number; bytes: number; checksum: string;
  counts: BackupCounts; meta: { driver: string | null; scopes: string[]; by: string | null };
  tables: Record<string, unknown[]>;
};
type PlanRow = { table: string; current: number | null; incoming: number; action: string };
type BackupPlan = { mode: string; rows: PlanRow[]; notes: string[]; checksum: string; rows_to_write: number };
type BackupPreview = {
  rows: number; counts: BackupCounts; checksum: string; warnings: string[]; admins: number;
  modes: { replace: boolean; config: boolean }; created_at: string;
  meta: { driver: string | null; scopes: string[]; by: string | null };
  plans: Partial<Record<'replace' | 'config', BackupPlan>>;
};
type BackupApplied = {
  mode: string; applied: BackupCounts; cleared: BackupCounts; rows: number; took_ms: number;
  checksum: string; reauth_required: boolean; regranted: string[];
  snapshot: { path: string; bytes: number; kept: number; removed: number } | null;
};
type BackupProblem = { table: string | null; message: string };
const TABLE_LABEL: Record<string, string> = {
  users: '账户', sessions: '会话', orders: '委托', trades: '成交', events: '事件',
  snapshots: '日结快照', watchlists: '自选', settings: '配置', audit: '审计', api_keys: 'API 密钥',
};
const SCOPE_HINT: Record<string, [string, string]> = {
  data: ['全站业务数据', '账户、委托、成交、快照、自选、API 密钥'],
  config: ['全站配置', '挂牌参数、行情源、注册开关、熔断'],
  audit: ['审计流水', '后台操作留痕，导入时永远只追加'],
  sessions: ['会话摘要', '勾上后旧实例已登录的浏览器在新实例继续有效'],
};

// 代理这一堆数值：边界值同样由服务端校验，这里只解释每一项在管什么
const PROXY_FIELDS: { key: keyof ProxyPolicy; label: string; hint: string }[] = [
  { key: 'count', label: '一次取几个', hint: '向列表 API 要多少条' },
  { key: 'maxFails', label: '连挂几个剔除', hint: '连续失败次数上限' },
  { key: 'connectMs', label: '建连上限', hint: '毫秒，与代理握手的最长等待' },
  { key: 'totalMs', label: '单次请求上限', hint: '毫秒，含隧道与正文' },
  { key: 'ttlMs', label: '列表有效期', hint: '毫秒，过期就重新取' },
  { key: 'minPullMs', label: '取列表最小间隔', hint: '毫秒，防把配额烧光' },
  { key: 'directCoolMs', label: '直连冷却', hint: '毫秒，直连失败后这段时间只用代理' },
];

// 数值项的展示顺序与说明；边界值由服务端校验，这里只负责写清楚每一项在管什么
const SOURCE_FIELDS: { key: keyof QuoteSource; label: string; hint: string }[] = [
  { key: 'timeoutMs', label: '上游超时', hint: '毫秒，单次请求最长等待' },
  { key: 'cnTtlMs', label: '沪深快照间隔', hint: '毫秒，越小越新但越吃上游' },
  { key: 'usTtlMs', label: '美股快照间隔', hint: '毫秒' },
  { key: 'fxTtlMs', label: '汇率缓存', hint: '毫秒，只影响折算展示' },
  { key: 'trendsTtlMs', label: '分时缓存', hint: '毫秒' },
  { key: 'klineTtlMs', label: 'K 线缓存', hint: '毫秒；日 K 与周 K 同档各存各的' },
  { key: 'cnPoolSize', label: '沪深个股池', hint: '按成交额取前 N 只' },
  { key: 'usPoolSize', label:  '美股池', hint: '三个交易所合起来取前 N 只' },
  { key: 'indexPoolSize', label: '指数池', hint: '条数' },
  { key: 'staleWarnMinutes', label: '数据落后告警', hint: '分钟，只影响检测结论' },
  { key: 'cooldownMs', label: '失败源冷却', hint: '毫秒，这段时间内不再打它' },
];
// 域名按源分组：换源不是改一个 URL，而是整家换，分组才不会配出「东财的域名 + 腾讯的路径」这种组合
const PROVIDER_HOST_FIELDS: { key: string; label: string; fields: { key: keyof QuoteSource; label: string; hint: string }[] }[] = [
  {
    key: 'eastmoney',
    label: '东方财富',
    fields: [
      { key: 'listHost', label: '板块接口域名', hint: '沪深与美股池、美股指数都走它' },
      { key: 'singleHost', label: '单标的域名', hint: '池外标的补价与汇率' },
      { key: 'histHost', label: '历史接口域名', hint: '分时与 K 线' },
      { key: 'searchHost', label: '检索接口域名', hint: '代码联想' },
    ],
  },
  {
    key: 'tencent',
    label: '腾讯财经',
    fields: [
      { key: 'txQuoteHost', label: '快照域名（GBK）', hint: '个股/ETF/指数/美股批量报价' },
      { key: 'txListHost', label: '排行域名', hint: 'A 股成交额榜，降级时的池子来源' },
      { key: 'txHistHost', label: '分时域名', hint: '当日分钟线' },
      { key: 'txKlineHost', label: 'K 线域名', hint: '蜡烛图；美股必须带交易所后缀' },
    ],
  },
  {
    key: 'sina',
    label: '新浪财经',
    fields: [
      { key: 'sinaQuoteHost', label: '快照域名（GBK）', hint: '个股/ETF/指数批量报价' },
      { key: 'sinaListHost', label: '排行域名', hint: '每页 80 条，分页取' },
      { key: 'sinaHistHost', label: 'K 线域名', hint: '只有日线，周 K 由本地合并' },
    ],
  },
];
const CAP_LABEL: Record<string, string> = {
  cnStocks: '沪深个股池', cnIndexes: '沪深指数', cnEtfs: 'ETF 补价', usStocks: '美股池', usIndexes: '美股指数',
  one: '单标的', fx: '汇率', trends: '分时', kline: '日/周 K', suggest: '检索',
};

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
  const [proxyDraft, setProxyDraft] = useState<ProxyPolicy | null>(null);
  const [proxyCheck, setProxyCheck] = useState<ProxyCheckResult | null>(null);
  const [proxyBusy, setProxyBusy] = useState('');
  const [usage, setUsage] = useState<QuoteUsage | null>(null);
  const [usageBusy, setUsageBusy] = useState(false);
  const [scopes, setScopes] = useState({ data: true, config: true, audit: true, sessions: false });
  const [doc, setDoc] = useState<BackupDocument | null>(null);
  const [picked, setPicked] = useState<{ name: string; bytes: number; document: BackupDocument } | null>(null);
  const [preview, setPreview] = useState<BackupPreview | null>(null);
  const [problems, setProblems] = useState<BackupProblem[] | null>(null);
  const [ack, setAck] = useState('');
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [busy, setBusy] = useState('');
  const [applied, setApplied] = useState<BackupApplied | null>(null);
  const [loading, setLoading] = useState(false);
  const timer = useRef(0);

  // 危险动作的二次确认只维持 5 秒，超时自动收回，避免留下「点了就会执行」的悬空状态
  useEffect(() => {
    if (!pending) return undefined;
    const at = window.setTimeout(() => setPending(''), 5_000);
    return () => window.clearTimeout(at);
  }, [pending]);

  // 用量卡自己每 2 秒拉一次：「我点这一下有没有打上游」要的是马上看到数字动，而不是等切页
  useEffect(() => {
    if (tab !== 'quote') return undefined;
    let live = true;
    const pull = () => api<QuoteUsage>('admin_quote_usage')
      .then((result) => { if (live) setUsage(result); })
      .catch(() => undefined);
    void pull();
    const poll = window.setInterval(pull, 2_000);
    return () => { live = false; window.clearInterval(poll); };
  }, [tab]);

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
        setProxyDraft(result.proxy?.settings ?? null);
        setProxyCheck(null);
      }
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : '后台数据读取失败');
    } finally {
      setLoading(false);
    }
  }, []);

  // 归零只是清进程内的计数，不动任何数据；先归零再立刻回读，页面显示的就是归零后的那一格
  const resetUsageCount = async () => {
    setUsageBusy(true);
    try {
      setUsage(await api<QuoteUsage>('admin_quote_usage_reset'));
      toast.success('上游用量已归零');
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : '归零未成功');
    } finally {
      setUsageBusy(false);
    }
  };

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

  // ---- 备份页 ----
  const fileName = () => `mirror-backup-${(doc?.created_at ?? new Date().toISOString()).replace(/[:.]/g, '-').slice(0, 19)}.json`;

  async function makeExport() {
    setBusy('export');
    try {
      const result = await api<{ document: BackupDocument }>('admin_backup_export', { include: scopes });
      setDoc(result.document);
      setApplied(null);
      toast.success(`已导出 ${result.document.rows} 行`);
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : '导出失败');
    } finally {
      setBusy('');
    }
  }

  function download() {
    if (!doc) return;
    const blob = new Blob([JSON.stringify(doc)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName();
    link.click();
    // Blob 会挂在页面上直到手动释放，否则切几次页就攒出几份整库副本
    window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
    toast.success(`已保存 ${fileName()}`);
  }

  async function pickFile(file: File | undefined) {
    if (!file) return;
    setBusy('read');
    setPreview(null);
    setPreviewError(null);
    try {
      const parsed = JSON.parse(await file.text()) as BackupDocument;
      setPicked({ name: file.name, bytes: file.size, document: parsed });
      toast.success(`已读取 ${file.name}`);
    } catch (error) {
      setPicked(null);
      setPreviewError(`这个文件读不出来：${error instanceof Error ? error.message : '不是合法 JSON'}`);
      toast.error('文件无法解析');
    } finally {
      setBusy('');
    }
  }

  async function runPreview() {
    if (!picked) return;
    setBusy('preview');
    setPreviewError(null);
    try {
      const result = await api<BackupPreview>('admin_backup_preview', { document: picked.document });
      setPreview(result);
      setAck('');
      setApplied(null);
    } catch (error) {
      setPreview(null);
      setPreviewError(error instanceof ApiError ? error.message : '预检失败');
      toast.error('预检未通过，未做任何改动');
    } finally {
      setBusy('');
    }
  }

  async function runImport(mode: 'replace' | 'config') {
    if (!picked || !preview) return;
    setBusy(`apply:${mode}`);
    setPreviewError(null);
    try {
      const result = await api<BackupApplied>('admin_backup_apply', {
        document: picked.document, mode, ack: ack.trim(), confirm: true,
      });
      setApplied(result);
      toast.success(result.mode === 'replace' ? '整库已按文件恢复' : '配置已并回');
    } catch (error) {
      setPreviewError(error instanceof ApiError ? error.message : '导入失败');
      toast.error('导入未完成');
    } finally {
      setBusy('');
    }
  }

  function relogin() {
    writeToken(null);
    window.location.hash = '';
    window.location.reload();
  }

  // 覆盖整库要「打字确认 + 二次点击」两道闸：前者证明看过预检，后者防手滑
  function confirmThen(key: string, note: string, run: () => void) {
    if (pending !== key) { setPending(key); toast('再点一次以确认', { description: note }); return; }
    setPending('');
    run();
  }

  // 源序只改草稿，保存后才生效；换序会清掉缓存与冷却，下一次同步立刻按新序走
  function moveSource(index: number, delta: number) {
    const next = [...quoteDraft?.sourceOrder ?? []];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    setQuoteDraft({ ...quoteDraft!, sourceOrder: next });
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

            {usage && <UsageCard usage={usage} busy={usageBusy} onReset={() => void resetUsageCount()} />}

            <section className="rounded border border-hairline bg-raised p-3">
              <div className="flex flex-wrap items-center gap-2">
                <MiniButton armedKey="" pending="" text={checking ? '检测中…' : `立即检测 ${quote.probes.length} 项`} kind="primary"
                  disabled={checking}
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
                {checking && <span className="text-[0.75rem] text-ink-dim">逐源逐能力实测中…</span>}
                {check && (
                  <span className={`chip num ${check.verdict === 'ok' ? 'border-down/40 bg-down/12 text-down'
                    : check.verdict === 'partial' ? 'border-warn/50 bg-warn/12 text-warn' : 'border-up/45 bg-up/12 text-up'}`}>
                    {check.verdict === 'ok' ? '能力齐全' : check.verdict === 'partial' ? `缺 ${check.dead.length} 项能力` : '全部不可用'}
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
                  <table className="w-full min-w-[52rem] border-collapse text-[0.8125rem]">
                    <thead>
                      <tr className="border-b border-hairline text-left text-[0.6875rem] text-ink-dim">
                        {['源', '能力', '结果', '耗时', '条数', '样本', '说明'].map((head) => <th key={head} className="px-2 py-1 font-normal">{head}</th>)}
                      </tr>
                    </thead>
                    <tbody>
                      {check.results.map((row) => (
                        <tr key={row.key} className="border-b border-hairline/40">
                          <td className="px-2 py-1.5 text-[0.75rem] text-ink-dim">{row.providerLabel ?? row.provider}</td>
                          <td className="px-2">{row.label ?? row.cap}</td>
                          <td className="px-2"><Badge text={row.ok ? '可用' : '不可用'} kind={row.ok ? 'down' : 'up'} /></td>
                          <td className={`num px-2 text-right ${row.ms > 1500 ? 'text-warn' : ''}`}>{row.ms}ms</td>
                          <td className="num px-2 text-right">{row.rows ?? '—'}</td>
                          <td className="num max-w-[15rem] truncate px-2 text-[0.75rem] text-ink-dim" title={row.sample ?? ''}>{row.sample || '—'}</td>
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

            <section>
              <h3 className="mb-1.5 text-[0.6875rem] tracking-[0.08em] text-primary">源序与降级</h3>
              <div className="flex flex-col gap-1.5">
                {quoteDraft.sourceOrder.map((key, index) => {
                  const info = quote.providers.find((item) => item.key === key);
                  return (
                    <div key={key} className="flex flex-wrap items-center gap-2 rounded border border-hairline bg-raised px-3 py-2 text-xs">
                      <span className="num w-5 text-[0.6875rem] text-ink-dim">{index + 1}</span>
                      <span className="min-w-[6rem] font-medium">{info?.label ?? key}</span>
                      {index === 0 && <Badge text="首选" kind="primary" />}
                      {(quote.health.cn.source === key || quote.health.us.source === key) && <Badge text="当前在用" kind="down" />}
                      {info?.coolingFor ? <Badge text={`冷却 ${info.coolingFor}s`} kind="muted" /> : null}
                      <span className="num text-[0.6875rem] text-ink-dim">
                        {info?.lastOkAt ? `最近可用 ${clockTime(info.lastOkAt)}${info.lastMs != null ? ` · ${info.lastMs}ms` : ''}` : '还没成功过'}
                        {info?.failStreak ? ` · 连续失败 ${info.failStreak}` : ''}
                      </span>
                      <span className="num max-w-[18rem] truncate text-[0.6875rem] text-up" title={info?.lastError ?? ''}>{info?.lastError ?? ''}</span>
                      <span className="ml-auto flex gap-1">
                        <MiniButton armedKey="" pending="" text="↑" disabled={index === 0}
                          onFire={() => moveSource(index, -1)} />
                        <MiniButton armedKey="" pending="" text="↓" disabled={index === quoteDraft.sourceOrder.length - 1}
                          onFire={() => moveSource(index, 1)} />
                      </span>
                    </div>
                  );
                })}
              </div>
              <label className="mt-2 flex items-start gap-2 rounded border border-hairline bg-panel px-3 py-2 text-xs">
                <input type="checkbox" className="mt-1 accent-[var(--primary)]" checked={quoteDraft.fallbackEnabled}
                  onChange={(event) => setQuoteDraft({ ...quoteDraft, fallbackEnabled: event.target.checked })} aria-label="允许自动降级" />
                <span>允许自动降级<span className="block text-[0.6875rem] text-ink-dim">
                  关掉后只用首选源，它挂了就不刷新行情（宁可用上次快照，也不换一家口径不同的源）
                </span></span>
              </label>
            </section>

            <p className="text-[0.75rem] leading-6 text-ink-dim">
              每家源的字段口径都逐项实测过（价格、昨收、涨跌停、成交额、市值、时间戳），横向对照同一标的三家价格一致才接进链里。
              编码按接口不同：东财 UTF-8，腾讯 / 新浪的快照是 GBK，自建 Node 用 TextDecoder 解；边缘运行时若不带 GBK 解码器，
              那两家会整片报 gbk_unsupported 并自动跳过，撮合仍走东财。域名只能从清单里选——填任意主机等于给服务端开一个内网探测口。
              保存后缓存与冷却立即清空，下一次同步就用新配置，不用重启。
            </p>

            <section>
              <h3 className="mb-1.5 text-[0.6875rem] tracking-[0.08em] text-primary">各家域名</h3>
              <div className="flex flex-col gap-2.5">
                {PROVIDER_HOST_FIELDS.map((group) => (
                  <div key={group.key}>
                    <div className="mb-1 flex items-center gap-2 text-[0.6875rem] text-ink-dim">
                      <span className="text-primary">{group.label}</span>
                      <span className="num">{quote.providers.find((item) => item.key === group.key)?.hosts.join(' · ')}</span>
                    </div>
                    <div className="grid gap-2 sm:grid-cols-2">
                      {group.fields.map((field) => (
                        <label key={field.key} className="flex items-center justify-between gap-3 rounded border border-hairline bg-raised px-3 py-2 text-xs">
                          <span>{field.label}<span className="block text-[0.6875rem] text-ink-dim">{field.hint}</span></span>
                          <select value={String(quoteDraft[field.key])} aria-label={`${group.label} ${field.label}`}
                            onChange={(event) => setQuoteDraft({ ...quoteDraft, [field.key]: event.target.value })}
                            className="num h-8 max-w-[15rem] rounded border border-hairline bg-panel px-1 text-[0.75rem] outline-none focus:border-input">
                            {quote.hosts.map((host) => <option key={host} value={host}>{host}</option>)}
                          </select>
                        </label>
                      ))}
                    </div>
                  </div>
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

            {proxyDraft && quote.proxy ? (
              <section className="flex flex-col gap-2 rounded border border-hairline bg-raised p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="text-[0.6875rem] tracking-[0.08em] text-primary">代理出口（防限流）</h3>
                  <span className={`chip num ${proxyDraft.enabled ? 'border-down/40 bg-down/12 text-down' : 'border-hairline text-ink-dim'}`}>
                    {proxyDraft.enabled ? '已启用' : '未启用'} · {proxyDraft.mode === 'proxy_only' ? '一律走代理' : '直连优先'}
                  </span>
                  <span className="chip num border-hairline text-ink-dim">
                    池子 {quote.proxy.status.alive}/{quote.proxy.status.pool.length} 可用
                    {quote.proxy.status.counters.lastVia ? ` · 最近出口 ${quote.proxy.status.counters.lastVia}` : ''}
                  </span>
                  {quote.proxy.status.direct.coolingMs > 0 && (
                    <span className="chip num border-warn/50 bg-warn/12 text-warn">直连冷却中 {Math.round(quote.proxy.status.direct.coolingMs / 1000)}s</span>
                  )}
                  {quote.proxy.lastCheck && !proxyCheck && (
                    <span className="num text-[0.6875rem] text-ink-dim">上次检测 {clockTime(quote.proxy.lastCheck.at)} · {quote.proxy.lastCheck.okCount}/{quote.proxy.lastCheck.total} 可用</span>
                  )}
                </div>

                {quote.proxy.runtime !== 'node' && (
                  <p className="rounded border border-warn/50 bg-warn/10 px-2 py-1.5 text-[0.75rem] leading-5 text-warn">
                    当前运行时不支持代理：CONNECT 隧道要原始套接字，只有自建部署（<span className="num">node server/index.mjs</span>）能装。
                    配置照样能存，换成自建实例后直接生效。
                  </p>
                )}

                <label className="flex items-center gap-2 text-xs">
                  <input type="checkbox" className="mt-1 accent-[var(--primary)]" checked={proxyDraft.enabled}
                    onChange={(event) => setProxyDraft({ ...proxyDraft, enabled: event.target.checked })} aria-label="启用代理" />
                    <span>启用代理<span className="ml-1 text-[0.6875rem] text-ink-dim">关掉就是现在的行为：只走直连，一个代理包都不发</span></span>
                </label>

                <div className="grid gap-2 sm:grid-cols-2">
                  <label className="flex flex-col gap-1.5 rounded border border-hairline bg-panel px-3 py-2 text-xs">
                    <span>出口策略<span className="ml-1 text-[0.6875rem] text-ink-dim">直连优先：只在直连失败或被限流时换出口</span></span>
                    <select value={proxyDraft.mode} aria-label="出口策略"
                      onChange={(event) => setProxyDraft({ ...proxyDraft, mode: event.target.value })}
                      className="num h-8 rounded border border-hairline bg-panel px-1 text-[0.75rem] outline-none focus:border-input">
                      <option value="direct_first">直连优先，失败才用代理</option>
                      <option value="proxy_only">一律走代理</option>
                    </select>
                  </label>
                  <label className="flex flex-col gap-1.5 rounded border border-hairline bg-panel px-3 py-2 text-xs">
                    <span>代理类型<span className="ml-1 text-[0.6875rem] text-ink-dim">向列表 API 要哪一种；手动填的地址也按这个握手</span></span>
                    <select value={proxyDraft.protocol} aria-label="代理类型"
                      onChange={(event) => setProxyDraft({ ...proxyDraft, protocol: event.target.value })}
                      className="num h-8 rounded border border-hairline bg-panel px-1 text-[0.75rem] outline-none focus:border-input">
                      <option value="http">http（明文 CONNECT 隧道）</option>
                      <option value="https">https（对代理再套一层 TLS）</option>
                    </select>
                  </label>
                </div>

                <label className="flex flex-col gap-1.5 rounded border border-hairline bg-panel px-3 py-2 text-xs">
                  <span>代理列表 API<span className="ml-1 text-[0.6875rem] text-ink-dim">只收 https，不能带账号口令；请求时会自动补 count 与 protocol</span></span>
                  <input value={proxyDraft.apiUrl} aria-label="代理列表 API" placeholder={quote.proxy.defaults.apiUrl}
                    onChange={(event) => setProxyDraft({ ...proxyDraft, apiUrl: event.target.value })}
                    className="num h-8 rounded border border-hairline bg-panel px-2 text-[0.75rem] outline-none focus:border-input" />
                  <span className="num text-[0.6875rem] text-ink-dim">
                    备份与审计里记的是 {quote.proxy.status.policy.apiUrl || '（未填）'}
                    {quote.proxy.status.counters.lastPullAt ? ` · 上次取列表 ${clockTime(quote.proxy.status.counters.lastPullAt)}` : ' · 还没取过列表'}
                    {quote.proxy.status.counters.lastPullError ? ` · ${quote.proxy.status.counters.lastPullError}` : ''}
                  </span>
                </label>

                {(quote.proxy.presets ?? []).length > 0 && (
                  <div className="flex flex-wrap items-center gap-1.5 text-[0.6875rem]">
                    <span className="text-ink-dim">内置接口</span>
                    {(quote.proxy.presets ?? []).map((preset) => (
                      <button key={preset.key} type="button" title={`${preset.note} · ${preset.docs}`}
                        onClick={() => setProxyDraft({ ...proxyDraft, apiUrl: preset.url })}
                        className={`chip num border px-1.5 py-0.5 transition-colors duration-75 active:translate-y-px ${proxyDraft.apiUrl === preset.url
                          ? 'border-primary/55 bg-primary/12 text-primary' : 'border-hairline text-ink-dim hover:bg-surface-2 hover:text-foreground'}`}>
                        {preset.label}
                      </button>
                    ))}
                    <span className="text-ink-dim">免注册免凭据，返回 <span className="num">data.proxies</span> 里的 ip:port；点一下就填进上面</span>
                  </div>
                )}

                <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                  {PROXY_FIELDS.map((field) => (
                    <Field key={field.key} label={field.label} hint={field.hint}
                      value={Number(proxyDraft[field.key] ?? 0)}
                      onChange={(value) => setProxyDraft({ ...proxyDraft, [field.key]: Math.round(value) })} />
                  ))}
                </div>

                <label className="flex flex-col gap-1.5 rounded border border-hairline bg-panel px-3 py-2 text-xs">
                  <span>手动代理<span className="ml-1 text-[0.6875rem] text-ink-dim">逗号或空格分隔的 host:port，最多 20 个；这些地址永远排在最前面用</span></span>
                  <input value={proxyDraft.manual.join(', ')} aria-label="手动代理" placeholder="203.0.113.9:8080, 198.51.100.7:3128"
                    onChange={(event) => setProxyDraft({ ...proxyDraft, manual: event.target.value.split(/[,，\s]+/).filter(Boolean) })}
                    className="num h-8 rounded border border-hairline bg-panel px-2 text-[0.75rem] outline-none focus:border-input" />
                  <span className="num text-[0.6875rem] text-ink-dim">当前 {proxyDraft.manual.length} 条 · 带账号口令或指向内网的地址会被逐项拒绝</span>
                </label>

                <div className="flex flex-wrap items-center gap-2">
                  <MiniButton armedKey="proxy-save" pending={pending} text="保存代理配置" armed="确认保存" kind="primary"
                    onFire={() => act('proxy-save', () => api('admin_settings', { patch: { proxy: proxyDraft }, confirm: true }), '代理配置已保存并立即生效')} />
                  <MiniButton armedKey="" pending="" text="立即获取新代理" disabled={Boolean(proxyBusy) || !proxyDraft.apiUrl}
                    onFire={async () => {
                      setProxyBusy('pull');
                      try {
                        const result = await api<ProxyPull>('admin_proxy_pull', { force: true });
                        setProxyCheck(null);
                        toast.success(result.added ? `已取回 ${result.added} 个代理，池子 ${result.pool} 个` : `没取到新代理：${result.error ?? '列表为空'}`);
                        void load('quote', query);
                      } catch (error) {
                        toast.error(error instanceof ApiError ? error.message : '获取代理失败');
                      } finally { setProxyBusy(''); }
                    }} />
                  <MiniButton armedKey="" pending="" text="逐代理活性检测" disabled={Boolean(proxyBusy)}
                    onFire={async () => {
                      setProxyBusy('check');
                      try {
                        setProxyCheck(await api<ProxyCheckResult>('admin_proxy_check'));
                        toast.success('代理检测完成');
                      } catch (error) {
                        toast.error(error instanceof ApiError ? error.message : '代理检测失败');
                      } finally { setProxyBusy(''); }
                    }} />
                  {proxyBusy && <span className="text-[0.75rem] text-ink-dim">{proxyBusy === 'pull' ? '正在取列表…' : '正在逐个试出口…'}</span>}
                  <MiniButton armedKey="proxy-reset" pending={pending} text="恢复默认代理配置" armed="确认恢复"
                    onFire={() => act('proxy-reset', () => api('admin_settings', { patch: { proxy: quote.proxy!.defaults }, confirm: true }), '已恢复默认代理配置')} />
                  <span className="text-[0.6875rem] text-ink-dim">取列表每分钟最多 6 次，检测最多 12 次</span>
                </div>

                {proxyCheck && (
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[42rem] border-collapse text-[0.8125rem]">
                      <thead>
                        <tr className="border-b border-hairline text-left text-[0.6875rem] text-ink-dim">
                          {['代理地址', '结果', '耗时', '条数', '说明'].map((head) => <th key={head} className="px-2 py-1 font-normal">{head}</th>)}
                        </tr>
                      </thead>
                      <tbody>
                        {proxyCheck.results.map((row) => (
                          <tr key={row.addr} className="border-b border-hairline/40">
                            <td className="num px-2 py-1.5">{row.addr}</td>
                            <td className="px-2"><Badge text={row.ok ? '可用' : row.blocked ? '已被封' : '不可用'} kind={row.ok ? 'down' : 'up'} /></td>
                            <td className={`num px-2 text-right ${row.ms > 1500 ? 'text-warn' : ''}`}>{row.ms}ms</td>
                            <td className="num px-2 text-right">{row.rows ?? '—'}</td>
                            <td className="num max-w-[20rem] truncate px-2 text-[0.75rem] text-up" title={row.error ?? ''}>{row.error || '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}

                {quote.proxy.status.pool.length > 0 ? (
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[46rem] border-collapse text-[0.8125rem]">
                      <thead>
                        <tr className="border-b border-hairline text-left text-[0.6875rem] text-ink-dim">
                          {['代理地址', '来源', '状态', '连挂', '成功', '最近耗时', '最近错误'].map((head) => <th key={head} className="px-2 py-1 font-normal">{head}</th>)}
                        </tr>
                      </thead>
                      <tbody>
                        {quote.proxy.status.pool.map((row) => (
                          <tr key={row.addr} className="border-b border-hairline/40">
                            <td className="num px-2 py-1.5">{row.addr}{row.pinned && <span className="ml-1 text-[0.6875rem] text-primary">钉住</span>}</td>
                            <td className="px-2 text-[0.75rem] text-ink-dim">{row.source === 'manual' ? '手动' : '列表 API'}</td>
                            <td className="px-2">
                              <Badge text={row.blocked ? '已被封' : row.usable ? '可用' : '待剔除'} kind={row.usable && !row.blocked ? 'down' : 'up'} />
                            </td>
                            <td className="num px-2 text-right">{row.fails}</td>
                            <td className="num px-2 text-right">{row.ok}</td>
                            <td className="num px-2 text-right">{row.lastMs === null ? '—' : `${row.lastMs}ms`}</td>
                            <td className="num max-w-[18rem] truncate px-2 text-[0.75rem] text-up" title={row.lastError ?? ''}>{row.lastError || '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <p className="text-[0.75rem] text-ink-dim">池子是空的：填好列表 API 或手动地址后，点「立即获取新代理」才会有出口。</p>
                )}

                {proxyCheck?.advice.length ? (
                  <ul className="space-y-1 text-[0.75rem] leading-5 text-ink-dim">
                    {proxyCheck.advice.map((line) => <li key={line} className="border-l border-warn/50 pl-2">{line}</li>)}
                  </ul>
                ) : null}

                <p className="text-[0.75rem] leading-6 text-ink-dim">
                  活性检测真打一次行情接口：连得上但取不到行情的代理判「不可用」，被上游回 403/407 的判「已被封」并立即剔除，
                  下一次请求会自动去取新列表。换出口只改「怎么出去」，域名白名单、当日判定与记账口径一概不变。
                </p>
              </section>
            ) : null}

            <div className="flex flex-wrap items-center gap-2">
              <MiniButton armedKey="quote-save" pending={pending} text="保存行情源配置" armed="确认保存" kind="primary"
                onFire={() => act('quote-save', () => api('admin_settings', { patch: { quote_source: quoteDraft }, confirm: true }), '行情源配置已保存并立即生效')} />
              <MiniButton armedKey="quote-reset" pending={pending} text="恢复默认配置" armed="确认恢复"
                onFire={() => act('quote-reset', () => api('admin_settings', { patch: { quote_source: quote.defaults }, confirm: true }), '已恢复默认行情源配置')} />
              <span className="text-[0.6875rem] text-ink-dim">保存与恢复都写入审计（含变更项对照）</span>
            </div>
          </div>
        ) : <Empty text="行情源加载中…" />)}

        {tab === 'backup' && (
          <div className="flex flex-col gap-3 text-sm">
            <p className="text-[0.75rem] leading-6 text-ink-dim">
              导出是一份自描述的 JSON：十张表按列白名单逐行校验，配置与账本同进同出。
              导入前必看预检对照表；覆盖整库之前，服务端会先把当前数据写成快照文件（默认 <span className="num">data/backups/</span>，保留最近 10 份），
              落不下去就不执行覆盖。审计流水永远只追加——导入不会抹掉「谁导入过」这条记录本身。
            </p>

            <section className="rounded border border-hairline bg-raised p-3">
              <h3 className="mb-2 text-[0.6875rem] tracking-[0.08em] text-primary">导出</h3>
              <div className="grid gap-1.5 sm:grid-cols-2">
                {(['data', 'config', 'audit', 'sessions'] as const).map((key) => (
                  <label key={key} className="flex items-start gap-2 rounded border border-hairline bg-panel px-2.5 py-1.5 text-xs">
                    <input type="checkbox" className="mt-1 accent-[var(--primary)]" checked={scopes[key]}
                      onChange={(event) => setScopes({ ...scopes, [key]: event.target.checked })} aria-label={SCOPE_HINT[key][0]} />
                    <span>{SCOPE_HINT[key][0]}<span className="block text-[0.6875rem] text-ink-dim">{SCOPE_HINT[key][1]}</span></span>
                  </label>
                ))}
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <MiniButton armedKey="" pending="" text={busy === 'export' ? '导出中…' : '生成导出'} kind="primary"
                  disabled={busy === 'export'} onFire={() => void makeExport()} />
                {doc && (
                  <MiniButton armedKey="" pending="" text="下载 JSON" onFire={download} />
                )}
                {doc && (
                  <span className="num text-[0.6875rem] text-ink-dim">
                    {doc.rows} 行 · {Math.max(1, Math.round(doc.bytes / 1024))}KB · checksum {doc.checksum.slice(0, 12)}
                  </span>
                )}
              </div>
              {doc && (
                <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[0.75rem]">
                  {Object.entries(doc.counts).map(([name, n]) => (
                    <span key={name} className="num text-ink-dim">{TABLE_LABEL[name] ?? name} <b className="text-foreground">{n}</b></span>
                  ))}
                </div>
              )}
              {doc && (
                <p className="mt-2 text-[0.6875rem] leading-5 text-warn">
                  文件里有口令散列（PBKDF2）与 API 密钥摘要（SHA-256），都不可逆，但仍要当凭据保管；带会话摘要的导出不例外。
                </p>
              )}
            </section>

            <section className="rounded border border-hairline bg-raised p-3">
              <h3 className="mb-2 text-[0.6875rem] tracking-[0.08em] text-primary">导入</h3>
              <div className="flex flex-wrap items-center gap-2">
                <label className="flex items-center gap-2 rounded border border-hairline bg-panel px-2.5 py-1.5 text-xs">
                  <span className="text-ink-dim">备份文件</span>
                  <input type="file" accept="application/json,.json" aria-label="备份文件"
                    onChange={(event) => void pickFile(event.target.files?.[0])}
                    className="num max-w-[18rem] text-[0.75rem] file:mr-2 file:rounded file:border-0 file:bg-surface-2 file:px-2 file:py-1 file:text-[0.6875rem]" />
                </label>
                {picked && (
                  <span className="num text-[0.6875rem] text-ink-dim">{Math.max(1, Math.round(picked.bytes / 1024))}KB</span>
                )}
                <MiniButton armedKey="" pending="" text={busy === 'preview' ? '预检中…' : '预检'} kind="primary"
                  disabled={!picked || busy === 'preview'} onFire={() => void runPreview()} />
              </div>
              {!picked && !previewError && (
                <p className="mt-2 text-[0.6875rem] text-ink-dim">
                  选择文件后先预检：逐表列出「当前 → 文件」的行数与动作，问题项在这里挡住，不会写进数据库。
                  大库建议用命令行：<span className="num">node scripts/backup.mjs import 文件 --mode replace --yes</span>
                </p>
              )}
              {previewError && (
                <p className="mt-2 rounded border border-up/40 bg-up/10 px-2 py-1.5 text-[0.75rem] leading-5 text-up">{previewError}</p>
              )}

              {preview && (
                <div className="mt-3 flex flex-col gap-3">
                  <div className="flex flex-wrap items-center gap-2 text-[0.75rem]">
                    <Badge text={`校验通过 · ${preview.rows} 行`} kind="down" />
                    <span className="num text-ink-dim">导出于 {preview.created_at ? clockTime(preview.created_at) : '未知'} · 源驱动 {preview.meta.driver ?? '未知'}</span>
                    <span className="num text-ink-dim">checksum <b className="text-foreground">{preview.checksum.slice(0, 12)}</b></span>
                  </div>

                  {(['replace', 'config'] as const).map((mode) => {
                    const plan = preview.plans[mode];
                    if (!plan) return null;
                    return (
                      <div key={mode} className="overflow-x-auto">
                        <h4 className="mb-1 text-[0.6875rem] text-ink-dim">
                          {mode === 'replace' ? '覆盖全站：清空范围内各表后按文件写入（审计只追加）' : '只并配置：仅按 key 并回 settings，业务数据一行不碰'}
                        </h4>
                        <table className="w-full min-w-[34rem] border-collapse text-[0.75rem]">
                          <thead>
                            <tr className="border-b border-hairline text-left text-[0.6875rem] text-ink-dim">
                              {['表', '当前', '文件', '动作'].map((head) => <th key={head} className="px-2 py-1 font-normal">{head}</th>)}
                            </tr>
                          </thead>
                          <tbody>
                            {plan.rows.map((row) => (
                              <tr key={row.table} className="border-b border-hairline/40">
                                <td className="px-2 py-1">{TABLE_LABEL[row.table] ?? row.table}</td>
                                <td className="num px-2 text-right">{row.current ?? '—'}</td>
                                <td className="num px-2 text-right">{row.incoming}</td>
                                <td className={`px-2 ${row.action.startsWith('清空') ? 'text-up' : 'text-ink-dim'}`}>{row.action}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                        {plan.notes.map((note) => <p key={note} className="mt-1 text-[0.6875rem] leading-5 text-warn">注意 {note}</p>)}
                      </div>
                    );
                  })}

                  {preview.warnings.length > 0 && (
                    <ul className="space-y-1 text-[0.6875rem] leading-5 text-ink-dim">
                      {preview.warnings.map((line) => <li key={line} className="border-l border-hairline pl-2">{line}</li>)}
                    </ul>
                  )}

                  <div className="flex flex-wrap items-center gap-2">
                    <input value={ack} onChange={(event) => setAck(event.target.value)} placeholder="输入校验和前 6 位"
                      aria-label="校验和前 6 位"
                      className="num h-8 w-32 rounded border border-hairline bg-panel px-2 text-xs outline-none focus:border-input" />
                    <span className="num text-[0.6875rem] text-ink-dim">{preview.checksum.slice(0, 6)}</span>
                    <MiniButton armedKey="import-replace" pending={pending} text="确认覆盖全站" armed="再点一次执行覆盖" kind="primary"
                      disabled={!preview.modes.replace || ack.trim().toLowerCase() !== preview.checksum.slice(0, 6)}
                      onFire={() => confirmThen('import-replace', '覆盖整库前请确认已看过上面的对照表', () => void runImport('replace'))} />
                    <MiniButton armedKey="import-config" pending={pending} text="只并配置" armed="再点一次并回配置"
                      disabled={!preview.modes.config || ack.trim().toLowerCase() !== preview.checksum.slice(0, 6)}
                      onFire={() => confirmThen('import-config', '只并 settings，业务数据不受影响', () => void runImport('config'))} />
                  </div>
                </div>
              )}

              {applied && (
                <div className="mt-3 rounded border border-down/40 bg-down/10 p-2.5 text-[0.75rem] leading-6">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge text={applied.mode === 'replace' ? '整库已恢复' : '配置已并回'} kind="down" />
                    <span className="num text-ink-dim">{applied.rows} 行 · {applied.took_ms}ms</span>
                  </div>
                  <p className="num mt-1 break-all text-ink-dim">导入前快照：{applied.snapshot?.path ?? '无'}</p>
                  {applied.regranted.length > 0 && <p className="text-ink-dim">按 ADMIN_USERNAMES 重新授予管理员：{applied.regranted.join('、')}</p>}
                  {applied.reauth_required ? (
                    <div className="mt-1.5 flex flex-wrap items-center gap-2">
                      <span className="text-warn">文件里没有会话：所有人的登录状态已失效，包括你自己。</span>
                      <MiniButton armedKey="" pending="" text="去重新登录" kind="primary" onFire={relogin} />
                    </div>
                  ) : (
                    <span className="text-ink-dim">当前登录状态仍然有效，参数缓存最多 2 秒后自动跟上。</span>
                  )}
                </div>
              )}
            </section>
          </div>
        )}

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
      const fellBack = Boolean(q.cn.fellBack || q.us.fellBack);
      const active = q.cn.sourceLabel || q.us.sourceLabel || null;
      return {
        label: down ? '取不到' : degraded ? '部分降级' : stale ? '非当日' : '正常',
        hint: `沪深 ${q.cn.rows} 条 · 美股 ${q.us.rows} 条`
          + (fellBack && active ? ` · 已换 ${active}` : '')
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
      {item.sourceLabel && (
        <p className="text-[0.6875rem] leading-5">
          当前源 {item.sourceLabel}{item.fellBack && <span className="text-warn"> · 已降级（首选源取不到）</span>}
        </p>
      )}
      {(item.note || item.partial) && (
        <p className="mt-1 text-[0.6875rem] leading-5">{item.note ? `上游错误：${item.note}` : ''}{item.partial ? ` · 降级：${item.partial}` : ''}</p>
      )}
      {item.market === 'us' && <p className="num text-[0.6875rem] text-ink-dim">折算 {(fx / 1e6).toFixed(4)} ¥/$</p>}
    </div>
  );
}

/** 上游用量：把「真出网几次」和「缓存挡下几次」放在同一张卡里，直接回答「我点这一下有没有打上游」 */
function UsageCard({ usage, busy, onReset }: { usage: QuoteUsage; busy: boolean; onReset: () => void }) {
  const peak = Math.max(...usage.perMinute.map((row) => row.calls), 0);
  const blocked = usage.cache.reduce((sum, row) => sum + row.hit, 0);
  const passed = usage.cache.reduce((sum, row) => sum + row.miss, 0);
  return (
    <section className="rounded border border-hairline bg-raised p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[0.8125rem] font-medium">上游用量</span>
        <span className="chip num border-hairline text-ink-dim">出网 {usage.total.calls} 次</span>
        {usage.total.fail > 0 && <span className="chip num border-up/45 bg-up/12 text-up">失败 {usage.total.fail}</span>}
        {usage.total.probe > 0 && <span className="chip num border-hairline text-ink-dim">其中主动检测 {usage.total.probe}</span>}
        <span className="chip num border-hairline text-ink-dim">缓存挡下 {blocked} · 放行 {passed}</span>
        <span className="num ml-auto text-[0.6875rem] text-ink-dim">自 {clockTime(usage.since)} 起 · 进程内计数，重启归零</span>
        <MiniButton armedKey="" pending="" text={busy ? '归零中…' : '归零计数'} disabled={busy} onFire={onReset} />
      </div>

      <div role="img" aria-label={`最近 ${usage.windowMinutes} 分钟每分钟出网次数，峰值 ${peak} 次`}
        className="mt-3 flex h-10 items-end gap-px">
        {usage.perMinute.map((row) => (
          <span key={row.at} title={`${clockTime(row.at)} · ${row.calls} 次${row.fail ? ` · 失败 ${row.fail}` : ''}`}
            className="flex h-full w-1.5 flex-col justify-end rounded-sm bg-primary/12">
            <span className={`w-full rounded-sm ${row.fail ? 'bg-up/70' : 'bg-primary/60'}`}
              style={{ height: row.calls ? `${Math.max(16, Math.round((row.calls / peak) * 100))}%` : '0%' }} />
          </span>
        ))}
      </div>
      <p className="num text-[0.6875rem] text-ink-dim">最近 {usage.windowMinutes} 分钟 · 每分钟一格 · 峰值 {peak} 次</p>

      <div className="mt-2 grid gap-3 sm:grid-cols-3">
        <UsageTable title="按能力" head={['能力', '次数', '均耗时']}
          rows={usage.byCap.map((row) => [row.label, `${row.calls}${row.fail ? `（败 ${row.fail}）` : ''}`, `${row.avgMs}ms`])} />
        <UsageTable title="按源" head={['源', '次数', '均耗时']}
          rows={usage.byProvider.map((row) => [row.label, `${row.calls}${row.fail ? `（败 ${row.fail}）` : ''}`, `${row.avgMs}ms`])} />
        <UsageTable title="缓存层" head={['层', '挡下', '命中率']}
          rows={usage.cache.map((row) => [row.label, `${row.hit}${row.merged ? `（合并 ${row.merged}）` : ''}`, `${row.rate}%`])} />
      </div>
    </section>
  );
}

function UsageTable({ title, head, rows }: { title: string; head: string[]; rows: string[][] }) {
  return (
    <div className="min-w-0">
      <p className="text-[0.75rem] text-ink-dim">{title}</p>
      {rows.length === 0 ? (
        <p className="num mt-1 text-[0.75rem] text-ink-dim">还没有出网记录</p>
      ) : (
        <table className="mt-1 w-full border-collapse text-[0.75rem]">
          <thead>
            <tr>{head.map((item) => <th key={item} className="border-b border-hairline/70 pb-0.5 text-left font-normal text-ink-dim">{item}</th>)}</tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row[0]}>
                <td className="max-w-[11rem] truncate py-0.5">{row[0]}</td>
                <td className="num py-0.5 text-right">{row[1]}</td>
                <td className="num py-0.5 text-right text-ink-dim">{row[2]}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function Badge({ text, kind }: { text: string; kind: 'up' | 'down' | 'primary' | 'muted' }) {
  const map = {
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
