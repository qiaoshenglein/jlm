// 行情出网的唯一接缝：默认走 globalThis.fetch，自建入口可以换成「带代理」的实现。
// 之所以做成注入而不是在行情层直接连 socket：边缘运行时没有原始套接字，
// 而代理恰恰只在自建部署上有意义（要 CONNECT 隧道、要 DNS 后二次校验私网地址）。
let impl = null;

export function setQuoteFetch(fn) {
  impl = typeof fn === 'function' ? fn : null;
}

export const quoteFetchMode = () => (impl ? 'injected' : 'direct');

/** 行情层唯一的 fetch 入口：opts.ms 是超时毫秒，opts.gbk 只影响调用方怎么解正文 */
export async function quoteFetch(url, opts = {}) {
  if (impl) return impl(url, opts);
  const response = await fetch(url, {
    headers: { 'user-agent': 'Mozilla/5.0', accept: '*/*', ...(opts.headers ?? {}) },
    signal: AbortSignal.timeout(opts.ms ?? 5_000),
  });
  if (!response.ok) throw new Error(`upstream_${response.status}`);
  return response;
}
