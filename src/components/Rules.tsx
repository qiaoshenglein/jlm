import { MICRO_LABEL } from './rulesText';

export function Rules({ extra, onClose }: { extra: Record<string, string> | null; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/60 p-0 sm:p-6" role="dialog" aria-modal="true" aria-label="交易规则说明">
      <button type="button" className="flex-1 cursor-default" aria-label="关闭规则说明" onClick={onClose} />
      <div className="scrollbar-thin w-full max-w-xl overflow-y-auto border-l border-hairline bg-panel p-5 text-sm">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base">交易规则与结算口径</h2>
          <button type="button" onClick={onClose} className="rounded border border-hairline px-2 py-1 text-xs text-muted-foreground hover:text-foreground">关闭</button>
        </div>
        {MICRO_LABEL.map((section) => (
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
          <h3 className="mb-2 text-xs tracking-wide text-primary">委托可能被拒绝的原因</h3>
          <ul className="grid gap-1 text-xs text-ink-dim">
            {Object.entries(extra ?? {}).map(([code, text]) => (
              <li key={code}><span className="num text-muted-foreground">{code}</span> — {text}</li>
            ))}
          </ul>
        </section>
        <p className="border-t border-hairline pt-3 text-[11px] leading-6 text-ink-dim">
          本平台为 A 股交易规则仿真器。行情由东方财富公开接口提供，可能存在数秒延迟；成交以最新价一次性全额撮合，
          不考虑盘口深度与排队。所有资金均为虚拟资金，强制平仓与排行榜只用于训练，不构成投资建议。
        </p>
      </div>
    </div>
  );
}
