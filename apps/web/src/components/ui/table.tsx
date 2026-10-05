import { type ReactNode, type ThHTMLAttributes, type TdHTMLAttributes } from 'react';
import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react';
import { cn } from '@/lib/cn';

export function Table({
  children,
  className,
  caption,
}: {
  children: ReactNode;
  className?: string;
  caption?: string;
}) {
  return (
    <div className={cn('overflow-x-auto rounded-lg border border-border bg-surface', className)}>
      <table className="w-full border-collapse text-left text-base">
        {caption && <caption className="sr-only">{caption}</caption>}
        {children}
      </table>
    </div>
  );
}

export function THead({ children }: { children: ReactNode }) {
  return <thead className="border-b border-border bg-surface-sunken/60">{children}</thead>;
}

export function Th({ className, children, ...props }: ThHTMLAttributes<HTMLTableCellElement>) {
  return (
    <th
      scope="col"
      className={cn(
        'h-9 px-3 text-xs font-medium tracking-wide whitespace-nowrap text-text-secondary first:pl-4 last:pr-4',
        className,
      )}
      {...props}
    >
      {children}
    </th>
  );
}

/** Sortable column header. `sort` is the current sort param ("name" or "-name"). */
export function SortTh({
  field,
  sort,
  onSort,
  children,
  className,
  align,
}: {
  field: string;
  sort: string | undefined;
  onSort: (next: string) => void;
  children: ReactNode;
  className?: string;
  align?: 'right';
}) {
  const active = sort === field || sort === `-${field}`;
  const desc = sort === `-${field}`;
  return (
    <Th className={className} aria-sort={active ? (desc ? 'descending' : 'ascending') : 'none'}>
      <button
        type="button"
        onClick={() => onSort(active && !desc ? `-${field}` : field)}
        className={cn(
          '-mx-1 inline-flex items-center gap-1 rounded px-1 hover:text-text-primary',
          align === 'right' && 'flex-row-reverse',
          active && 'text-text-primary',
        )}
      >
        {children}
        {active ? (
          desc ? (
            <ArrowDown className="size-3" />
          ) : (
            <ArrowUp className="size-3" />
          )
        ) : (
          <ArrowUpDown className="size-3 opacity-40" />
        )}
      </button>
    </Th>
  );
}

export function TBody({ children }: { children: ReactNode }) {
  return <tbody className="divide-y divide-divider">{children}</tbody>;
}

export function Tr({
  children,
  className,
  onClick,
  selected,
}: {
  children: ReactNode;
  className?: string;
  onClick?: () => void;
  selected?: boolean;
}) {
  return (
    <tr
      onClick={onClick}
      className={cn(
        'transition-colors',
        onClick && 'cursor-pointer hover:bg-surface-hover',
        selected && 'bg-surface-selected',
        className,
      )}
    >
      {children}
    </tr>
  );
}

export function Td({ className, children, ...props }: TdHTMLAttributes<HTMLTableCellElement>) {
  return (
    <td className={cn('h-11 px-3 py-2 align-middle first:pl-4 last:pr-4', className)} {...props}>
      {children}
    </td>
  );
}
