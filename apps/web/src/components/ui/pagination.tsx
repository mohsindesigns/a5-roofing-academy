import { ChevronLeft, ChevronRight } from 'lucide-react';
import { IconButton } from './button';

export function Pagination({
  page,
  pageCount,
  total,
  pageSize,
  onPage,
  noun = 'results',
}: {
  page: number;
  pageCount: number;
  total: number;
  pageSize: number;
  onPage: (page: number) => void;
  noun?: string;
}) {
  if (total === 0) return null;
  const from = (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
  return (
    <nav
      aria-label="Pagination"
      className="flex items-center justify-between gap-3 pt-3 text-sm text-text-secondary"
    >
      <p className="tabular">
        {from.toLocaleString()}–{to.toLocaleString()} of {total.toLocaleString()} {noun}
      </p>
      <div className="flex items-center gap-1">
        <IconButton
          label="Previous page"
          size="sm"
          variant="secondary"
          disabled={page <= 1}
          onClick={() => onPage(page - 1)}
        >
          <ChevronLeft className="size-4" />
        </IconButton>
        <span className="tabular px-2">
          {page} / {pageCount}
        </span>
        <IconButton
          label="Next page"
          size="sm"
          variant="secondary"
          disabled={page >= pageCount}
          onClick={() => onPage(page + 1)}
        >
          <ChevronRight className="size-4" />
        </IconButton>
      </div>
    </nav>
  );
}
