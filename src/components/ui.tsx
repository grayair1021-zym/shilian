import type { ReactNode } from 'react';
import { cn } from '../utils/cn';
import { audio } from '../audio';

export const C = {
  bg: '#0d1116',
  panel: '#12171e',
  panel2: '#171e26',
  line: '#2a333d',
  text: '#cdd5da',
  muted: '#8d99a2',
  amber: '#d99a35',
  amberHi: '#ecb154',
  remote: '#6f9cc4',
  remoteHi: '#9dc0da',
  danger: '#c05a4e',
};

export function Panel({
  title,
  right,
  children,
  className,
  bodyClass,
}: {
  title?: ReactNode;
  right?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClass?: string;
}) {
  return (
    <section className={cn('border border-[#2a333d] bg-[#12171e]/90 flex flex-col min-h-0', className)}>
      {title && (
        <header className="flex items-center justify-between gap-2 border-b border-[#2a333d] bg-[#171e26] px-3 py-1.5">
          <h2 className="text-[12px] tracking-[0.28em] text-[#93a3ac]">{title}</h2>
          <div className="flex items-center gap-2 text-[11px] text-[#8d99a2]">{right}</div>
        </header>
      )}
      <div className={cn('min-h-0 flex-1 p-3', bodyClass)}>{children}</div>
    </section>
  );
}

type BtnVariant = 'default' | 'primary' | 'danger' | 'ghost' | 'remote';

export function Btn({
  children,
  onClick,
  disabled,
  variant = 'default',
  className,
  title,
  sfx = 'click',
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  variant?: BtnVariant;
  className?: string;
  title?: string;
  sfx?: 'click' | 'door' | 'scan' | 'radio' | 'listen' | null;
}) {
  const styles: Record<BtnVariant, string> = {
    default: 'border-[#323d47] bg-[#1a2129] text-[#cdd5da] hover:border-[#4a5865] hover:bg-[#202932]',
    primary:
      'border-[#d99a35] bg-[#d99a35] text-[#1a130a] font-medium hover:bg-[#ecb154] hover:border-[#ecb154]',
    danger: 'border-[#6e3a35] bg-[#231416] text-[#d68a80] hover:border-[#c05a4e] hover:bg-[#2c1a18]',
    ghost: 'border-transparent bg-transparent text-[#8d99a2] hover:text-[#dde4e8]',
    remote: 'border-[#3d5a76] bg-[#15202b] text-[#9dc0da] hover:border-[#6f9cc4] hover:bg-[#1a2836]',
  };
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={() => {
        if (disabled) return;
        if (sfx) audio.play(sfx);
        onClick?.();
      }}
      className={cn(
        'border px-2.5 py-1.5 text-[12px] leading-tight tracking-wide transition-colors duration-150',
        'disabled:cursor-not-allowed disabled:opacity-35 disabled:hover:border-[#323d47] disabled:hover:bg-[#1a2129]',
        styles[variant],
        className,
      )}
    >
      {children}
    </button>
  );
}

export function Meter({
  label,
  value,
  max = 100,
  tone = 'accent',
  display,
}: {
  label: string;
  value: number;
  max?: number;
  tone?: 'accent' | 'amber' | 'danger' | 'remote';
  display?: string;
}) {
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  const color = tone === 'danger' ? C.danger : tone === 'amber' ? C.amber : tone === 'remote' ? C.remote : C.amber;
  return (
    <div className="min-w-[90px] flex-1">
      <div className="flex items-baseline justify-between text-[11px] text-[#8d99a2]">
        <span className="tracking-widest">{label}</span>
        <span style={{ color }}>{display ?? `${Math.round(value)}%`}</span>
      </div>
      <div className="mt-1 h-[3px] w-full bg-[#202932]">
        <div className="h-full transition-all duration-500" style={{ width: `${pct}%`, background: color }} />
      </div>
    </div>
  );
}

export function Tag({
  children,
  tone = 'muted',
}: {
  children: ReactNode;
  tone?: 'muted' | 'accent' | 'amber' | 'danger' | 'remote';
}) {
  const map = {
    muted: 'border-[#323d47] text-[#8d99a2]',
    accent: 'border-[#8a6a2a] text-[#ecb154]',
    amber: 'border-[#8a6a2a] text-[#ecb154]',
    danger: 'border-[#6e3a35] text-[#d68a80]',
    remote: 'border-[#3d5a76] text-[#9dc0da]',
  } as const;
  return (
    <span className={cn('border px-1.5 py-[1px] text-[10px] tracking-wider whitespace-nowrap', map[tone])}>
      {children}
    </span>
  );
}
