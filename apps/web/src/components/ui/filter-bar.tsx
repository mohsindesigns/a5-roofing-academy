import { useState, type ReactNode } from 'react';
import { SlidersHorizontal } from 'lucide-react';
import { cn } from '@/lib/cn';
import { Button } from './button';

/**
 * Search plus filters. On phones the filters collapse behind a toggle so the list stays in view;
 * from the small breakpoint up they sit inline.
 */
export function FilterBar({
  search,
  children,
  activeCount = 0,
  className,
}: {
  search: ReactNode;
  children: ReactNode;
  activeCount?: number;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className={cn('mb-3 flex flex-col gap-2', className)}>
      <div className="flex gap-2">
        <div className="min-w-0 flex-1">{search}</div>
        <Button
          className="sm:hidden"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          leading={<SlidersHorizontal className="size-4" />}
        >
          Filters
          {activeCount > 0 && <span className="tabular text-text-tertiary">{activeCount}</span>}
        </Button>
      </div>
      <div
        className={cn(
          'grid gap-2 sm:grid sm:grid-cols-[repeat(auto-fit,minmax(160px,1fr))]',
          open ? 'grid' : 'hidden',
        )}
      >
        {children}
      </div>
    </div>
  );
}
