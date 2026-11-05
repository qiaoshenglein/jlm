// 与同源 Function 通信的唯一入口：只走 POST + JSON，令牌随请求体发送。
// 站点网关会剥离 cookie 与 authorization，因此不能依赖它们承载应用会话。
import type { Market } from './format';

export class ApiError extends Error {
  constructor(message: string, readonly code: string, readonly status = 0) {
    super(message);
    this.name = 'ApiError';
  }
}

const BASE = '/functions/v1/app';
const TOKEN_KEY = 'mirror.desk.token';

export const MESSAGES: Record<string, string> = {
  network_error: '网络未送达，请先确认委托是否已受理，不要重复提交。',
  invalid_response: '服务返回了非预期内容，请稍后重试。',
  login_required: '登录状态已失效，请重新登录。',
  access_denied: '没有访问权限，请重新登录。',
  credential_invalid: '用户名或口令不正确。',
  account_locked: '连续失败过多，该账户已临时锁定 15 分钟。',
  username_taken: '该用户名已被占用，请换一个。',
  username_invalid: '用户名需为 2-24 位中文、字母、数字或 _ . -。',
  password_invalid: '口令至少 8 位，且需同时包含字母与数字。',
  too_many_requests: '操作过于频繁，请稍候几秒再试。',
  quote_unavailable: '行情源暂不可用，无法校验委托价格与可用保证金。',
  chart_unavailable: '该标的的分时/K 线暂时取不到。',
  symbol_invalid: '标的代码格式不正确。',
  duplicate_order: '15 秒内已提交过完全相同的委托。若确实要再来一笔，请点“确认重复下单”。',
  order_invalid: '委托编号不正确。',
  cancel_failed: '该委托已成交或已撤销，无法再次撤单。',
  read_failed: '账户数据读取失败，请稍后重试。',
  write_failed: '写入失败，委托未落库，请重试。',
  duplicate: '该操作已处理过，无需重复提交。',
  server_error: '服务内部错误，请稍后重试。',
  database_runtime_unavailable: '后端数据服务未就绪，请联系站点管理员。',
  request_failed: '请求未完成，请检查当前状态后重试。',
};

// 拒单原因由后端规则表定义，启动时注入一次，前后端永远共用同一份文案
let serverReasons: Record<string, string> = {};
export function setServerReasons(reasons: Record<string, string>) {
  serverReasons = reasons;
}

export function messageFor(code: string): string {
  return MESSAGES[code] ?? serverReasons[code] ?? '操作未成功，请检查当前状态后重试。';
}

export function readToken(): string {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? '';
  } catch {
    return '';
  }
}

export function writeToken(token: string | null) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* 浏览器禁用存储时退化为单次会话 */
  }
}

type Payload = Record<string, unknown>;

// 当前市场是「一次切换、全站跟随」的上下文：让它走请求体，
// 调用点就不必在每个 action 上重复传 market，也不会漏传成另一个池子
const MARKET_KEY = 'mirror.desk.market';
let activeMarket: Market = readMarket();
export function readMarket(): Market {
  try {
    return localStorage.getItem(MARKET_KEY) === 'us' ? 'us' : 'cn';
  } catch {
    return 'cn';
  }
}
export function setMarket(market: Market) {
  activeMarket = market;
  try { localStorage.setItem(MARKET_KEY, market); } catch { /* 隐私模式下仅本次生效 */ }
}
export const currentMarket = () => activeMarket;

export async function api<T>(action: string, payload: Payload = {}, quiet = false): Promise<T> {
  const token = readToken();
  const headers = new Headers({ 'Content-Type': 'application/json', Accept: 'application/json' });
  let response: Response;
  try {
    response = await fetch(`${BASE}?action=${action}`, {
      method: 'POST',
      headers,
      credentials: 'same-origin',
      body: JSON.stringify(token
        ? { market: activeMarket, ...payload, token }
        : { market: activeMarket, ...payload }),
    });
  } catch {
    if (!quiet) throw new ApiError(MESSAGES.network_error, 'network_error');
    throw new ApiError(MESSAGES.network_error, 'network_error');
  }
  let data: unknown = null;
  const text = await response.text();
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    throw new ApiError(MESSAGES.invalid_response, 'invalid_response', response.status);
  }
  const body = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;
  const code = typeof body.code === 'string' ? body.code : null;
  if (!response.ok || body.ok === false) {
    const resolved = code ?? 'request_failed';
    if (resolved === 'login_required') writeToken(null);
    throw new ApiError(messageFor(resolved), resolved, response.status);
  }
  return data as T;
}
