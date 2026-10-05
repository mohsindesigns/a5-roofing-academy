import { cn } from '@/lib/cn';

/** Thin, labelled progress bar. `value` is 0–100. */
export function ProgressBar({
  value,
  label,
  showValue = false,
  tone = 'accent',
  size = 'md',
  className,
}: {
  value: number;
  label: string;
  showValue?: boolean;
  tone?: 'accent' | 'success' | 'neutral';
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}) {
  const v = Math.max(0, Math.min(100, Math.round(value)));
  return (
    <div className={cn('flex items-center gap-3', className)}>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={v}
        className={cn(
          'relative flex-1 overflow-hidden rounded-full bg-surface-sunken',
          size === 'sm' ? 'h-1' : size === 'lg' ? 'h-2.5' : 'h-1.5',
        )}
      >
        <div
          className={cn(
            'h-full rounded-full transition-[width] duration-500',
            tone === 'success'
              ? 'bg-success'
              : tone === 'neutral'
                ? 'bg-text-tertiary'
                : 'bg-brand-secondary',
          )}
          style={{ width: `${v}%` }}
        />
      </div>
      {showValue && (
        <span className="tabular w-10 text-right text-sm text-text-secondary">{v}%</span>
      )}
    </div>
  );
}
