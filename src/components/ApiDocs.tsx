import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { ApiError, api } from '../api';
import { clockTime, dayTime } from '../format';

type KeyRow = {
  id: string; name: string; hint: string; created_at: string;
  last_used_at: string | null; calls: number; revoked: boolean; revoked_at: string | null;
};

type Tab = 'keys' | 'endpoints' | 'errors';

// 端点表与 docs/API.md 一一对应；改接口时两边要一起改，否则用户照着说明写出来的请求会失败。
const ENDPOINTS: { group: string; items: { method: string; path: string; note: string }[] }[] = [
  {
    group: '行情查询（无需密钥也能取公开行情，带上密钥口径一致）',
    items: [
      { method: 'GET', path: '/api/v1/markets', note: '两市时段、熔断状态、当日汇率' },
      { method: 'GET', path: '/api/v1/quote?symbol=…', note: '单标的实时行情。symbol 接受 AAPL / 600519 / 105.AAPL / 1.510300' },
      { method: 'GET', path: '/api/v1/quotes?market=cn', note: '行情池快照：指数、ETF、个股、涨跌榜（美股无涨跌家数）' },
      { method: 'GET', path: '/api/v1/search?q=英伟达&market=us', note: '代码与名称检索，结果不跨市场' },
      { method: 'GET', path: '/api/v1/chart?symbol=…&kind=trends|kline&period=day|week', note: '分时与日 K / 周 K，count 上限 320；周 K 一根的日期取该周最后一个交易日' },
      { method: 'GET', path: '/api/v1/rules', note: '两市规则与当前挂牌参数' },
      { method: 'GET', path: '/api/v1/leaderboard', note: '当日盈亏榜（合并人民币口径）' },
    ],
  },
  {
    group: '账户查询（需要密钥）',
    items: [
      { method: 'GET', path: '/api/v1/account', note: '两个现金池的完整账目 + 折人民币合并值' },
      { method: 'GET', path: '/api/v1/positions', note: '持仓与负债，默认两市一起返回，?market=cn|us 只看一边' },
      { method: 'GET', path: '/api/v1/orders?status=open', note: '委托。status 可选 open/filling/filled/canceled/rejected' },
      { method: 'GET', path: '/api/v1/trades?limit=50', note: '成交流水，倒序' },
      { method: 'POST', path: '/api/v1/sync', note: '手动推进一轮撮合（等价网页端每 3 秒一轮）' },
    ],
  },
  {
    group: '交易（需要密钥）',
    items: [
      { method: 'POST', path: '/api/v1/order', note: '下单并立即撮合，响应直接带成交结果。字段见下' },
      { method: 'POST', path: '/api/v1/order/preview', note: '只试算不落库，不改变账户' },
      { method: 'POST', path: '/api/v1/cancel', note: '撤单 {orderId}' },
    ],
  },
  {
    group: '密钥管理（只认网页会话，API 密钥本身不能签发密钥）',
    items: [
      { method: 'GET', path: '/api/v1/keys', note: '我的密钥列表（只有摘要与首尾片段）' },
      { method: 'POST', path: '/api/v1/keys', note: '生成 {name}，明文只在这一次返回' },
      { method: 'POST', path: '/api/v1/keys/revoke', note: '撤销 {id}，立即失效' },
    ],
  },
];

const ORDER_FIELDS = [
  ['symbol', '必填', 'AAPL / 600519 / 105.AAPL / 1.510300 任一写法，市场归属由标的决定'],
  ['side', '必填', 'buy 担保品买入 · sell 担保品卖出 · margin_buy 融资买入 · sell_repay 卖券还款 · short_sell 融券卖出 · cover_buy 买券还券'],
  ['qty', '必填', 'A 股须为 100 的整数倍，美股 1 股起，上限 100 万'],
  ['type', '选填', 'market（默认）或 limit'],
  ['price', '限价必填', '元或美元，需对齐最小报价单位：A 股股票 0.01、ETF 0.001，美股 0.01'],
  ['leverage', '信用方向必填', '2–5；现货方向留空或 1'],
  ['immediate', '选填', '默认 true：下单后立刻为该市场跑一轮撮合并在响应里给成交结果。传 false 则只受理，等下一轮'],
];

const ERRORS = [
  ['400', 'symbol_invalid', '标的代码格式不正确，或无法在沪深/美股中定位该代码'],
  ['400', 'qty_invalid', '数量不合法（A 股需 100 的整数倍）或超过 100 万股'],
  ['400', 'price_invalid', '限价未对齐最小报价单位，或越出当日涨跌停区间（A 股）'],
  ['400', 'insufficient_cash', '该市场的现金不足。两个池子互不挪用，美元不足不会动用人民币'],
  ['400', 'insufficient_avail', '可用数量不足：A 股当日买入需下一交易日才可卖（T+1）'],
  ['400', 'ratio_too_low', '成交后维持担保比例低于该市场开仓线（A 股 150%，美股 200%）'],
  ['400', 'liquidation_breach', '成交后维持担保比例将低于平仓线 130%，委托被拒绝'],
  ['400', 'limit_up / limit_down', '涨停封板不可买入，跌停封板不可卖出（仅 A 股）'],
  ['400', 'suspended', '行情非当日数据（休市、停牌或上游异常），不撮合'],
  ['400', 'duplicate_order', '15 秒内完全相同的委托，需带 confirmDuplicate=true 再提交'],
  ['401', 'login_required', '未提供凭证'],
  ['401', 'key_invalid', 'API 密钥无效或已被撤销，需要重新生成'],
  ['403', 'account_frozen', '账户已被后台冻结，不能开新仓；撤单与查询仍可用'],
  ['403', 'match_paused', '该市场的撮合已被后台熔断（另一市场不受影响）'],
  ['403', 'key_management_requires_session', '密钥的生成与撤销只能用网页登录后的会话令牌'],
  ['409', 'cancel_failed', '该委托已成交或已撤销，无法再次撤单'],
  ['429', 'too_many_requests', '超过频率上限：每把密钥 240 次/分钟，下单另有 30 次/分钟'],
  ['503', 'quote_unavailable', '行情源暂不可用，无法校验委托'],
];

export function ApiDocs({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<Tab>('keys');
  const [rows, setRows] = useState<KeyRow[] | null>(null);
  const [name, setName] = useState('');
  const [fresh, setFresh] = useState('');
  const [pending, setPending] = useState('');
  const [busy, setBusy] = useState(false);
  const origin = typeof window === 'undefined' ? '' : window.location.origin;

  const refresh = useCallback(async () => {
    try {
      const result = await api<{ keys: KeyRow[] }>('key_list');
      setRows(result.keys);
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : '密钥列表读取失败');
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  // 撤销确认只维持 5 秒，超时自动收回，避免留下「点了就会执行」的悬空状态
  useEffect(() => {
    if (!pending) return undefined;
    const at = window.setTimeout(() => setPending(''), 5_000);
    return () => window.clearTimeout(at);
  }, [pending]);

  async function create() {
    setBusy(true);
    try {
      const result = await api<{ apiKey: string }>('key_create', { name });
      setFresh(result.apiKey);
      setName('');
      toast.success('密钥已生成', { description: '完整密钥只显示这一次，请立即保存' });
      await refresh();
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : '生成失败');
    } finally {
      setBusy(false);
    }
  }

  async function revoke(row: KeyRow) {
    if (pending !== row.id) { setPending(row.id); toast('再点一次以确认撤销', { description: `${row.name} · ${row.hint}` }); return; }
    setPending('');
    try {
      await api('key_revoke', { id: row.id });
      toast.success('密钥已撤销', { description: '该密钥的后续请求会返回 key_invalid' });
      if (fresh) setFresh('');
      await refresh();
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : '撤销失败');
    }
  }

  async function copy(text: string, label = '已复制') {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(label);
    } catch {
      toast.error('浏览器拒绝了剪贴板访问，请手动选中复制');
    }
  }

  const keyForExample = fresh ?? 'mk_live_你的密钥';

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/60 p-0 sm:p-6" role="dialog" aria-modal="true" aria-label="API 与密钥">
      <button type="button" className="flex-1 cursor-default" aria-label="关闭 API 说明" onClick={onClose} />
      <div className="scrollbar-thin w-full max-w-3xl overflow-y-auto border-l border-hairline bg-panel p-5 text-sm">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div>
            <h2 className="text-base">API 接口与密钥</h2>
            <p className="mt-1 text-[0.75rem] leading-5 text-ink-dim">
              一个账户可以生成多把密钥，程序用 <span className="num">x-api-key</span> 直接下单与查询；
              撮合、风控、账本与网页端共用同一套实现，不存在两套口径。
            </p>
          </div>
          <button type="button" onClick={onClose} className="shrink-0 rounded border border-hairline px-2 py-1 text-xs text-muted-foreground hover:text-foreground">关闭</button>
        </div>

        <div role="tablist" aria-label="API 说明分区" className="mb-4 flex gap-1">
          {([['keys', '我的密钥'], ['endpoints', '接口与示例'], ['errors', '错误码']] as [Tab, string][]).map(([key, label]) => (
            <button key={key} type="button" role="tab" aria-selected={tab === key} onClick={() => setTab(key)}
              className={`rounded px-2.5 py-1 text-[0.8125rem] transition-colors duration-75 active:translate-y-px ${tab === key
                ? 'bg-surface-2 text-primary shadow-[inset_0_0_0_1px_var(--hairline)]' : 'text-muted-foreground hover:bg-surface-2/60 hover:text-foreground'}`}>
              {label}
            </button>
          ))}
        </div>

        {tab === 'keys' && (
          <div className="space-y-3">
            <div className="rounded border border-hairline bg-raised p-3">
              <p className="mb-2 text-[0.75rem] tracking-[0.06em] text-ink-dim">生成新密钥</p>
              <div className="flex flex-wrap items-center gap-2">
                <input value={name} onChange={(event) => setName(event.target.value)} aria-label="密钥备注名"
                  placeholder="用途，如「本机轮询脚本」" maxLength={24}
                  className="h-8 w-56 rounded border border-hairline bg-panel px-2 text-xs outline-none focus:border-input" />
                <button type="button" disabled={busy} onClick={() => void create()}
                  className="rounded border border-primary/50 px-3 py-1.5 text-xs text-primary transition hover:bg-primary/12 active:translate-y-px disabled:opacity-40">
                  {busy ? '生成中…' : '生成密钥'}
                </button>
                <span className="text-[0.6875rem] text-ink-dim">每账户最多 10 把有效密钥</span>
              </div>
              {fresh && (
                <div className="mt-3 rounded border border-warn/50 bg-warn/10 p-3">
                  <p className="text-[0.75rem] text-warn">完整密钥只显示这一次，服务端只保存它的 SHA-256 摘要，丢了只能撤销后重新生成。</p>
                  <div className="mt-2 flex items-center gap-2">
                    <code className="num min-w-0 flex-1 truncate rounded bg-panel px-2 py-1.5 text-[0.8125rem]">{fresh}</code>
                    <button type="button" onClick={() => void copy(fresh, '密钥已复制到剪贴板')}
                      className="shrink-0 rounded border border-hairline px-2 py-1 text-[0.75rem] hover:border-input">复制</button>
                  </div>
                </div>
              )}
            </div>

            {rows === null ? <p className="px-2 py-8 text-center text-xs text-ink-dim">密钥列表加载中…</p>
              : rows.length === 0 ? <p className="px-2 py-8 text-center text-xs text-ink-dim">还没有密钥，先生成一把再让程序调用。</p>
                : (
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[36rem] border-collapse text-[0.8125rem]">
                      <thead>
                        <tr className="border-b border-hairline text-left text-[0.6875rem] text-ink-dim">
                          {['备注', '密钥片段', '生成时间', '最近使用', '调用次数', '状态', '操作'].map((head) => (
                            <th key={head} className="px-2 py-1 font-normal">{head}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((row) => (
                          <tr key={row.id} className="border-b border-hairline/40">
                            <td className="px-2 py-1.5">{row.name || '未命名'}</td>
                            <td className="num px-2 text-[0.75rem] text-ink-dim">{row.hint}</td>
                            <td className="num px-2 text-[0.75rem] text-ink-dim">{dayTime(row.created_at)}</td>
                            <td className="num px-2 text-[0.75rem] text-ink-dim">{row.last_used_at ? clockTime(row.last_used_at) : '未使用'}</td>
                            <td className="num px-2">{row.calls}</td>
                            <td className="px-2">
                              <span className={`chip ${row.revoked ? 'border-hairline text-ink-dim' : 'border-down/40 bg-down/12 text-down'}`}>
                                {row.revoked ? '已撤销' : '有效'}
                              </span>
                            </td>
                            <td className="px-1 py-1">
                              {!row.revoked && (
                                <button type="button" onClick={() => void revoke(row)}
                                  className={`rounded border px-1.5 py-0.5 text-[0.75rem] transition active:translate-y-px ${pending === row.id
                                    ? 'border-warn/60 bg-warn/15 text-warn' : 'border-hairline text-muted-foreground hover:bg-surface-2 hover:text-foreground'}`}>
                                  {pending === row.id ? '确认撤销' : '撤销'}
                                </button>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}

            <p className="text-[0.6875rem] leading-5 text-ink-dim">
              密钥等同账户权限：能下单、能撤单、能看清全部账目，但不能改本金，也不能再生成新的密钥。
              泄露后请到本页撤销它，历史委托与成交不受影响。
            </p>
          </div>
        )}

        {tab === 'endpoints' && (
          <div className="space-y-4">
            <div className="rounded border border-hairline bg-raised px-3 py-2 text-xs">
              <span className="text-ink-dim">Base URL</span>
              <div className="mt-1 flex items-center gap-2">
                <code className="num min-w-0 flex-1 truncate">{origin}</code>
                <button type="button" onClick={() => void copy(origin, '地址已复制')}
                  className="shrink-0 rounded border border-hairline px-2 py-0.5 text-[0.75rem] hover:border-input">复制</button>
              </div>
              <p className="mt-2 text-[0.6875rem] leading-5 text-ink-dim">
                鉴权：请求头 <span className="num">x-api-key: mk_live_…</span>（也接受 <span className="num">Authorization: Bearer mk_live_…</span>）。
                密钥不放 query 参数——那会被访问日志原样记下来。
              </p>
            </div>

            {ENDPOINTS.map((group) => (
              <section key={group.group}>
                <h3 className="mb-1.5 text-[0.6875rem] tracking-[0.08em] text-primary">{group.group}</h3>
                <ul className="divide-y divide-hairline/40 rounded border border-hairline bg-raised">
                  {group.items.map((item) => (
                    <li key={`${item.method} ${item.path}`} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 px-3 py-1.5 text-xs">
                      <span className={`num w-11 shrink-0 ${item.method === 'GET' ? 'text-info' : 'text-up'}`}>{item.method}</span>
                      <code className="num shrink-0">{item.path}</code>
                      <span className="min-w-0 flex-1 text-ink-dim">{item.note}</span>
                    </li>
                  ))}
                </ul>
              </section>
            ))}

            <section>
              <h3 className="mb-1.5 text-[0.6875rem] tracking-[0.08em] text-primary">POST /api/v1/order 的字段</h3>
              <ul className="divide-y divide-hairline/40 rounded border border-hairline bg-raised text-xs">
                {ORDER_FIELDS.map(([field, need, note]) => (
                  <li key={field} className="flex flex-wrap gap-x-2 gap-y-0.5 px-3 py-1.5">
                    <code className="num w-24 shrink-0">{field}</code>
                    <span className="w-20 shrink-0 text-ink-dim">{need}</span>
                    <span className="min-w-0 flex-1">{note}</span>
                  </li>
                ))}
              </ul>
            </section>

            <section>
              <h3 className="mb-1.5 text-[0.6875rem] tracking-[0.08em] text-primary">示例（已带上你的密钥）</h3>
              <div className="space-y-2">
                {[
                  [`curl -H "x-api-key: ${keyForExample}" ${origin}/api/v1/account`],
                  [`curl -X POST ${origin}/api/v1/order -H "content-type: application/json" \\`,
                    `     -H "x-api-key: ${keyForExample}" \\`,
                    `     -d '{"symbol":"600519","side":"buy","qty":100,"type":"market"}'`],
                  [`curl -X POST ${origin}/api/v1/order -H "content-type: application/json" \\`,
                    `     -H "x-api-key: ${keyForExample}" \\`,
                    `     -d '{"symbol":"AAPL","side":"margin_buy","qty":20,"type":"limit","price":200,"leverage":2}'`],
                  [`curl "${origin}/api/v1/quote?symbol=AAPL"`],
                ].map((lines, index) => {
                  const text = lines.join('\n');
                  return (
                    <div key={index} className="group relative rounded border border-hairline bg-raised">
                      <pre className="scrollbar-thin overflow-x-auto px-3 py-2 pr-16 text-[0.75rem] leading-6"><code>{text}</code></pre>
                      <button type="button" onClick={() => void copy(text, '命令已复制')}
                        className="absolute right-2 top-2 rounded border border-hairline bg-panel px-2 py-0.5 text-[0.6875rem] text-ink-dim opacity-0 transition group-hover:opacity-100 focus:opacity-100">复制</button>
                    </div>
                  );
                })}
              </div>
              <p className="mt-2 text-[0.6875rem] leading-5 text-ink-dim">
                成交响应示例：<span className="num">{'{"ok":true,"status":"filled","fill":{"price":1459800000,"qty":100,"fee":37954800,"amount":145980000000},"account":{…}}'}</span>。
                金额单位是微元/微美元（除以 1e6 即元/美元），限价单未穿越时 <span className="num">status</span> 为 <span className="num">open</span>，非交易时段挂单会带 <span className="num">queued:true</span>。
              </p>
            </section>
          </div>
        )}

        {tab === 'errors' && (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[38rem] border-collapse text-xs">
              <thead>
                <tr className="border-b border-hairline text-left text-[0.6875rem] text-ink-dim">
                  {['HTTP', 'code', '含义'].map((head) => <th key={head} className="px-2 py-1 font-normal">{head}</th>)}
                </tr>
              </thead>
              <tbody>
                {ERRORS.map(([status, code, note]) => (
                  <tr key={code} className="border-b border-hairline/40">
                    <td className="num px-2 py-1.5 text-ink-dim">{status}</td>
                    <td className="num px-2 text-primary">{code}</td>
                    <td className="px-2 text-muted-foreground">{note}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-3 text-[0.6875rem] leading-6 text-ink-dim">
              每个错误响应都带 <span className="num">message</span> 字段（中文说明），不必在前端硬编码对照表。
              完整的字段表与更多示例见仓库里的 <span className="num">docs/API.md</span>。
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
