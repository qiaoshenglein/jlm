import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ApiError } from '../api';
import { MiniBar, PriceCell } from './charts';
import { percent, priceText, tone, type Board, type Session } from '../format';

type Mode = 'login' | 'register';

export function Auth({ board, session, onSubmit }: {
  board: Board | null;
  session: Session | null;
  onSubmit: (action: 'login' | 'register', payload: Record<string, string>) => Promise<void>;
}) {
  const [mode, setMode] = useState<Mode>('login');
  const [username, setUsername] = useState('');
  const [display, setDisplay] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [ack, setAck] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const indexes = board?.indexes?.slice(0, 6) ?? [];
  const canSubmit = mode === 'login'
    ? username.length > 1 && password.length > 5 && !busy
    : username.length > 1 && password.length > 7 && confirm === password && ack && !busy;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setError('');
    try {
      await onSubmit(mode, mode === 'login'
        ? { username, password }
        : { username, password, display: display || username });
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : '提交失败，请稍后重试。');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="relative min-h-dvh overflow-hidden">
      <div className="grid-lines pointer-events-none absolute inset-0 opacity-40" />
      <div className="relative mx-auto grid min-h-dvh w-full max-w-6xl gap-10 px-5 py-8 lg:grid-cols-[1.15fr_0.85fr] lg:items-center lg:px-10">
        <section>
          <div className="flex items-baseline gap-3">
            <h1 className="text-[3.375rem] font-semibold leading-none tracking-[0.16em] text-foreground sm:text-6xl">镜盘</h1>
            <span className="num text-[0.6875rem] tracking-[0.32em] text-primary">MIRROR DESK</span>
          </div>
          <p className="mt-3 text-[0.8438rem] leading-[1.5] text-foreground/85">沪深与美股实时行情的两融仿真交易台</p>
          <p className="mt-3 max-w-xl text-[0.8125rem] leading-7 text-muted-foreground">
            一个账户两个子账户：沪深用人民币，美股用美元，随时一键切换。涨跌幅限制、T+1 与 T+0、
            佣金印花税与 SEC 监管费、维持担保比例与强制平仓，全部按各自市场的真实规则计算。
            开户即得 100 万元与 10 万美元虚拟本金，杠杆最高 5 倍，随时可能被强平。
          </p>

          <div className="mt-7 space-y-2">
            {indexes.length === 0 && (
              <p className="text-xs text-muted-foreground">正在拉取沪深实时行情…</p>
            )}
            {indexes.map((quote) => (
              <div key={quote.secid} className="grid grid-cols-[7.5rem_auto_auto_1fr] items-center gap-3 border-b border-hairline/60 py-1.5 text-[0.8438rem]">
                <span className="truncate text-muted-foreground">{quote.name}</span>
                <PriceCell value={quote.last} tick={quote.tick} className={tone(quote.pct)} />
                <span className={`num w-[4.6rem] text-right ${tone(quote.pct)}`}>{percent(quote.pct)}</span>
                <span className="justify-self-end"><MiniBar pct={quote.pct} /></span>
              </div>
            ))}
          </div>
          <p className="mt-5 text-xs text-ink-dim">
            {session ? `北京时间 ${session.stamp.slice(11)} · ${phaseLabel(session.phase)}` : '行情时间同步中'}
            <span className="mx-2">·</span>数据源：东方财富公开行情接口
            <span className="mx-2">·</span>虚拟资金，不构成任何投资建议
          </p>
        </section>

        <section className="panel p-6 backdrop-blur">
          <div className="mb-6 flex gap-1 rounded-md bg-muted/60 p-1 text-sm">
            {(['login', 'register'] as Mode[]).map((value) => (
              <button key={value} type="button" onClick={() => { setMode(value); setError(''); }}
                aria-pressed={mode === value}
                className={`flex-1 rounded px-3 py-2 transition-colors duration-75 active:translate-y-px ${mode === value ? 'bg-raised text-foreground shadow' : 'text-muted-foreground hover:text-foreground'}`}>
                {value === 'login' ? '登录交易' : '开立新账户'}
              </button>
            ))}
          </div>

          <form onSubmit={submit} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="username">用户名</Label>
              <Input id="username" value={username} autoComplete="username" maxLength={24}
                onInput={(event) => setUsername((event.target as HTMLInputElement).value)}
                placeholder="2-24 位，中文/字母/数字" />
            </div>

            {mode === 'register' && (
              <div className="space-y-1.5">
                <Label htmlFor="display">交易昵称</Label>
                <Input id="display" value={display} maxLength={20}
                  onInput={(event) => setDisplay((event.target as HTMLInputElement).value)}
                  placeholder="显示在盈亏排行榜上，可留空" />
              </div>
            )}

            <div className="space-y-1.5">
              <Label htmlFor="password">登录口令</Label>
              <Input id="password" type="password" value={password} autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                maxLength={64} onInput={(event) => setPassword((event.target as HTMLInputElement).value)}
                placeholder="至少 8 位，含字母与数字" />
            </div>

            {mode === 'register' && (
              <>
                <div className="space-y-1.5">
                  <Label htmlFor="confirm">确认口令</Label>
                  <Input id="confirm" type="password" value={confirm} autoComplete="new-password" maxLength={64}
                    onInput={(event) => setConfirm((event.target as HTMLInputElement).value)}
                    aria-invalid={confirm.length > 0 && confirm !== password}
                    placeholder="再次输入口令" />
                  {confirm.length > 0 && confirm !== password && (
                    <p className="text-xs text-up">两次输入的口令不一致。</p>
                  )}
                </div>
                <label className="flex cursor-pointer items-start gap-2 text-xs leading-5 text-muted-foreground">
                  <input type="checkbox" checked={ack} onChange={(event) => setAck(event.target.checked)}
                    className="mt-0.5 size-4 accent-[var(--primary)]" />
                  <span>我理解账户内为<strong className="text-foreground">虚拟资金</strong>，杠杆会触发强制平仓，本平台不提供投资建议。</span>
                </label>
              </>
            )}

            {error && (
              <p role="alert" className="rounded border border-up/40 bg-up/10 px-3 py-2 text-xs text-up">{error}</p>
            )}

            <Button type="submit" className="w-full" disabled={!canSubmit}>
              {busy ? '提交中…' : mode === 'login' ? '进入交易台' : '开户并注入 100 万虚拟本金'}
            </Button>
            <p className="text-center text-[0.75rem] leading-5 text-ink-dim">
              口令以 PBKDF2-SHA256 加盐存储，服务端只保留会话令牌摘要。
            </p>
          </form>
        </section>
      </div>
    </div>
  );
}

export function phaseLabel(phase: string) {
  return { open: '连续竞价中', auction: '集合竞价', lunch: '午间休市', closed: '已收盘' }[phase] ?? '非交易时间';
}
