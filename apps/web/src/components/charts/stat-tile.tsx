import { type ReactNode } from 'react';
import { ArrowDownRight, ArrowUpRight } from 'lucide-react';
import { cn } from '@/lib/cn';

export function compactNumber(n: number): string {
  return new Intl.NumberFormat('en-US', { notation: n >= 10_000 ? 'compact' : 'standard', maximumFractionDigits: 1 }).format(n);
}

/**
 * Figure for a single headline value: label · value · optional delta and context.
 * Delta colour follows direction × whether up is good, and always carries an icon + text.
 */
export function StatTile({
  label,
  value,
  context,
  delta,
  upIsGood = true,
  className,
}: {
  label: string;
  value: ReactNode;
  context?: ReactNode;
  delta?: { value: number; label: string; format?: (n: number) => string } | null;
  upIsGood?: boolean;
  className?: string;
}) {
  const good = delta ? (delta.value >= 0) === upIsGood : true;
  return (
    <div className={cn('min-w-0', className)}>
      <p className="text-sm text-text-secondary">{label}</p>
      <p className="tabular mt-1 text-2xl font-semibold tracking-[-0.01em] text-text-primary">{value}</p>
      {(delta || context) && (
        <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-text-tertiary">
          {delta && delta.value !== 0 && (
            <span className={cn('inline-flex items-center gap-0.5 font-medium', good ? 'text-success' : 'text-danger')}>
              {delta.value > 0 ? <ArrowUpRight aria-hidden className="size-3.5" /> : <ArrowDownRight aria-hidden className="size-3.5" />}
              {(delta.format ?? ((n: number) => `${Math.abs(n)}`))(Math.abs(delta.value))}
              <span className="sr-only">{delta.value > 0 ? 'up' : 'down'}</span>
            </span>
          )}
          {delta && <span>{delta.label}</span>}
          {context}
        </p>
      )}
    </div>
  );
}

/** Row of headline figures separated by hairlines rather than boxed into cards. */
export function StatRow({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn('grid grid-cols-2 gap-x-6 gap-y-5 border-y border-border py-5 sm:grid-cols-3 lg:flex lg:divide-x lg:divide-border', className)}>
      {children}
    </div>
  );
}

export function StatCell({ children }: { children: ReactNode }) {
  return <div className="min-w-0 lg:flex-1 lg:px-6 lg:first:pl-0 lg:last:pr-0">{children}</div>;
}
