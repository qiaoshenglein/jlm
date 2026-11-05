import { useState } from 'react';
import { MARKET_NAME } from '../format';
import { RULES_CN, RULES_SHARED, RULES_US } from './rulesText';
import type { Market } from '../format';

const SECTIONS: Record<Market, typeof RULES_CN> = { cn: RULES_CN, us: RULES_US };

export function Rules({ extra, market = 'cn', onClose }: {
  extra: Record<string, string> | null; market?: Market; onClose: () => void;
}) {
  // 面板默认停在当前市场，但允许对照另一边：两市规则差异（T+0、涨跌停、担保线）最容易记混
  const [tab, setTab] = useState<Market>(market);
  const sections = [...RULES_SHARED, ...SECTIONS[tab]];
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/60 p-0 sm:p-6" role="dialog" aria-modal="true" aria-label="交易规则说明">
      <button type="button" className="flex-1 cursor-default" aria-label="关闭规则说明" onClick={onClose} />
      <div className="scrollbar-thin w-full max-w-xl overflow-y-auto border-l border-hairline bg-panel p-5 text-sm">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base">交易规则与结算口径</h2>
          <button type="button" onClick={onClose} className="rounded border border-hairline px-2 py-1 text-xs text-muted-foreground hover:text-foreground">关闭</button>
        </div>
        <div role="tablist" aria-label="规则所属市场" className="mb-4 flex gap-1">
          {(['cn', 'us'] as Market[]).map((item) => (
            <button key={item} type="button" role="tab" aria-selected={tab === item} onClick={() => setTab(item)}
              className={`rounded px-2.5 py-1 text-[0.75rem] transition-colors duration-75 active:translate-y-px ${tab === item
                ? 'bg-surface-2 text-primary shadow-[inset_0_0_0_1px_var(--hairline)]' : 'text-muted-foreground hover:bg-surface-2/60'}`}>
              {MARKET_NAME[item]}
            </button>
          ))}
          <span className="self-center text-[0.6875rem] text-ink-dim">两市各一套规则与币种</span>
        </div>
        {sections.map((section) => (
          <section key={section.title} className="mb-5">
            <h3 className="mb-2 text-xs tracking-wide text-primary">{section.title}</h3>
            <ul className="space-y-1.5 text-xs leading-6 text-muted-foreground">
              {section.items.map((item) => (
                <li key={item} className="border-l border-hairline pl-3">{item}</li>
              ))}
            </ul>
          </section>
        ))}

        <section className="mb-5">
          <h3 className="mb-2 text-xs tracking-wide text-primary">键盘快捷键</h3>
          <ul className="grid gap-1.5 text-xs text-muted-foreground">
            {[['/', '聚焦搜索框（输入后回车直接选中第一条）'], ['J / K 或 ↑ ↓', '在列表里上下选标的'],
              ['滚轮 / PageUp Down', '左侧列表翻页（一页最多 10 条，选中项跨页会自动跟翻）'],
              ['Home / End', '跳到列表首页 / 末页'],
              ['M', '在沪深与美股之间切换（顶栏两个状态签同样可点）'],
              ['A', '打开 API 接口与密钥面板'],
              ['B / S', '切换买入与卖出方向（信用页内切换融资/融券）'],
              ['1 – 5', '切换杠杆倍数（仅融资买入、融券卖出有效）'], ['Enter', '提交委托（数量框内同样有效）'],
              ['1 / 2 / 3', '手机与窄屏：行情 / 交易 / 账户'], ['Esc', '关闭本说明、清空搜索或退出输入框']].map(([key, text]) => (
              <li key={key} className="flex items-baseline gap-2">
                <kbd className="num shrink-0 rounded border border-hairline bg-surface-2 px-1.5 py-0.5 text-[0.6875rem] text-foreground">{key}</kbd>
                <span>{text}</span>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-[0.6875rem] leading-5 text-ink-dim">快捷键在输入框内不生效（Enter 除外），也不会拦截带 Ctrl / Cmd / Alt 的组合键。</p>
        </section>

        <section className="mb-5">
          <h3 className="mb-2 text-xs tracking-wide text-primary">委托可能被拒绝的原因</h3>
          <ul className="grid gap-1 text-xs text-ink-dim">
            {Object.entries(extra ?? {}).map(([code, text]) => (
              <li key={code}><span className="num text-muted-foreground">{code}</span> — {text}</li>
            ))}
          </ul>
        </section>
        <p className="border-t border-hairline pt-3 text-[0.75rem] leading-6 text-ink-dim">
          本平台为 A 股与美股交易规则的双市场仿真器。行情由东方财富公开接口提供，可能存在数秒延迟；成交以最新价一次性全额撮合，
          不考虑盘口深度与排队。所有资金均为虚拟资金，强制平仓与排行榜只用于训练，不构成投资建议。
        </p>
      </div>
    </div>
  );
}
