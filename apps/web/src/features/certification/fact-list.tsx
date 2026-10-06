import { type ReactNode } from 'react';
import { cn } from '@/lib/cn';

/**
 * Label and value pairs. Same layout as the shared description list, with labels in the secondary
 * text colour so they meet WCAG AA contrast at this size.
 */
export function FactList({
  items,
  columns = 2,
  className,
}: {
  items: Array<{ label: string; value: ReactNode }>;
  columns?: 1 | 2 | 3;
  className?: string;
}) {
  return (
    <dl
      className={cn(
        'grid gap-x-8 gap-y-4',
        columns === 2 && 'sm:grid-cols-2',
        columns === 3 && 'sm:grid-cols-2 lg:grid-cols-3',
        className,
      )}
    >
      {items.map((item) => (
        <div key={item.label} className="min-w-0">
          <dt className="text-xs font-medium text-text-secondary">{item.label}</dt>
          <dd className="mt-0.5 text-base break-words text-text-primary">
            {item.value ?? <span className="text-text-secondary">—</span>}
          </dd>
        </div>
      ))}
    </dl>
  );
}
