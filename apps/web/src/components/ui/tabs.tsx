import { type ReactNode } from 'react';
import { Tabs as T } from 'radix-ui';
import { cn } from '@/lib/cn';

export const TabsRoot = T.Root;
export const TabsContent = T.Content;

/** Underline tabs for switching views within a page. */
export function TabsList({
  items,
  className,
}: {
  items: Array<{ value: string; label: ReactNode; count?: number }>;
  className?: string;
}) {
  return (
    <T.List className={cn('flex gap-5 overflow-x-auto border-b border-border', className)}>
      {items.map((item) => (
        <T.Trigger
          key={item.value}
          value={item.value}
          className="-mb-px flex h-10 shrink-0 items-center gap-1.5 border-b-2 border-transparent text-base font-medium text-text-secondary hover:text-text-primary data-[state=active]:border-brand-secondary data-[state=active]:text-text-primary"
        >
          {item.label}
          {item.count !== undefined && (
            <span className="tabular text-sm text-text-tertiary">{item.count}</span>
          )}
        </T.Trigger>
      ))}
    </T.List>
  );
}
