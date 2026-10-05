import { type ReactNode } from 'react';
import { cn } from '@/lib/cn';

export type Tone = 'neutral' | 'success' | 'warning' | 'danger' | 'information' | 'accent';

const dot: Record<Tone, string> = {
  neutral: 'bg-text-tertiary',
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-danger',
  information: 'bg-information',
  accent: 'bg-brand-secondary',
};

const text: Record<Tone, string> = {
  neutral: 'text-text-secondary',
  success: 'text-success',
  warning: 'text-warning',
  danger: 'text-danger',
  information: 'text-information',
  accent: 'text-brand-secondary',
};

/** Status as coloured dot + text. Used in tables instead of pills. */
export function StatusText({
  tone = 'neutral',
  children,
  className,
}: {
  tone?: Tone;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 text-sm font-medium whitespace-nowrap',
        text[tone],
        className,
      )}
    >
      <span aria-hidden className={cn('size-1.5 shrink-0 rounded-full', dot[tone])} />
      {children}
    </span>
  );
}

const soft: Record<Tone, string> = {
  neutral: 'bg-surface-sunken text-text-secondary',
  success: 'bg-success-soft text-success',
  warning: 'bg-warning-soft text-warning',
  danger: 'bg-danger-soft text-danger',
  information: 'bg-information-soft text-information',
  accent: 'bg-brand-secondary-soft text-brand-secondary',
};

/** Compact label for counts and categories. Use sparingly. */
export function Tag({
  tone = 'neutral',
  children,
  className,
}: {
  tone?: Tone;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        'inline-flex h-5 items-center rounded-sm px-1.5 text-xs font-medium whitespace-nowrap',
        soft[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

/** Inline banner for page-level messages. */
export function Notice({
  tone = 'information',
  title,
  children,
  action,
  className,
}: {
  tone?: Exclude<Tone, 'neutral' | 'accent'>;
  title?: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      role={tone === 'danger' ? 'alert' : 'status'}
      className={cn(
        'flex flex-wrap items-start gap-x-4 gap-y-2 rounded-lg px-4 py-3',
        soft[tone],
        className,
      )}
    >
      <div className="min-w-0 flex-1 text-sm">
        {title && <p className="font-semibold">{title}</p>}
        {children && <div className="text-text-primary/80">{children}</div>}
      </div>
      {action}
    </div>
  );
}
