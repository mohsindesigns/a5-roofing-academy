import { type ReactNode } from 'react';
import { RotateCw } from 'lucide-react';
import { cn } from '@/lib/cn';
import { Button } from './button';

export function EmptyState({
  title,
  description,
  action,
  icon,
  className,
}: {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  icon?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex flex-col items-start gap-2 rounded-lg border border-dashed border-border-strong px-5 py-8 sm:items-center sm:text-center',
        className,
      )}
    >
      {icon && <span className="mb-1 text-text-tertiary">{icon}</span>}
      <p className="text-md font-semibold text-text-primary">{title}</p>
      {description && <p className="max-w-[46ch] text-sm text-text-secondary">{description}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

export function ErrorState({
  title = 'This section could not be loaded',
  message,
  onRetry,
  className,
}: {
  title?: string;
  message?: string;
  onRetry?: () => void;
  className?: string;
}) {
  return (
    <div
      role="alert"
      className={cn(
        'flex flex-wrap items-center justify-between gap-3 rounded-lg border border-danger/25 bg-danger-soft px-4 py-3',
        className,
      )}
    >
      <div className="min-w-0 text-sm">
        <p className="font-semibold text-danger">{title}</p>
        {message && <p className="text-text-primary/80">{message}</p>}
      </div>
      {onRetry && (
        <Button size="sm" onClick={onRetry} leading={<RotateCw className="size-3.5" />}>
          Retry
        </Button>
      )}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cn('animate-pulse rounded bg-surface-sunken', className)} />;
}

/** Table-shaped skeleton for list pages. */
export function TableSkeleton({ rows = 6, columns = 4 }: { rows?: number; columns?: number }) {
  return (
    <div
      className="rounded-lg border border-border bg-surface"
      aria-busy="true"
      aria-label="Loading"
    >
      <div className="h-9 border-b border-border bg-surface-sunken/60" />
      {Array.from({ length: rows }, (_, r) => (
        <div
          key={r}
          className="flex h-11 items-center gap-6 border-b border-divider px-4 last:border-0"
        >
          {Array.from({ length: columns }, (_, c) => (
            <Skeleton key={c} className={cn('h-3', c === 0 ? 'w-40' : 'w-20')} />
          ))}
        </div>
      ))}
    </div>
  );
}
