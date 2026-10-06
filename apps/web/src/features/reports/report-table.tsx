import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { Download, Search } from 'lucide-react';
import type { analytics } from '@a5/contracts';
import {
  Button,
  EmptyState,
  ErrorState,
  Input,
  Pagination,
  Select,
  SortTh,
  Table,
  TableSkeleton,
  TBody,
  Td,
  Th,
  THead,
  Tr,
} from '@/components/ui';
import { useReportList, useReportPage } from '@/features/analytics/api';
import { toApiFilters, type AnalyticsFilterState } from '@/features/analytics/filters';
import { useCan } from '@/features/auth/session';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import { errorMessage } from '@/lib/api/errors';
import { formatDate, formatDateTime } from '@/lib/format';
import { cn } from '@/lib/cn';
import { ExportDialog } from './export-dialog';

type Cell = string | number | boolean | null;

/** Display text for one report cell, driven by the column type from the API definition. */
export function formatCell(value: Cell | undefined, type: analytics.ReportColumn['type']): string {
  if (value === null || value === undefined || value === '') return '—';
  switch (type) {
    case 'percent':
      return typeof value === 'number' ? `${value}%` : String(value);
    case 'date':
      return formatDate(String(value));
    case 'datetime':
      return formatDateTime(String(value));
    case 'boolean':
      return value === true ? 'Yes' : value === false ? 'No' : String(value);
    case 'integer':
      return typeof value === 'number' ? value.toLocaleString() : String(value);
    case 'number':
      return typeof value === 'number'
        ? (Math.round(value * 10) / 10).toLocaleString()
        : String(value);
    default:
      return String(value);
  }
}

const NUMERIC = new Set<analytics.ReportColumn['type']>(['integer', 'number', 'percent']);

export function ReportTable({
  filters,
  reportKey,
  q,
  sort,
  page,
  onChange,
  onExported,
}: {
  filters: AnalyticsFilterState;
  reportKey: string;
  q: string;
  sort: string;
  page: number;
  onChange: (patch: { report?: string; q?: string; sort?: string; page?: string }) => void;
  onExported: () => void;
}) {
  const list = useReportList();
  const canExport = useCan('reports.export');
  const canOpenTeam = useCan('enrollments.view');
  const [exportOpen, setExportOpen] = useState(false);
  const [search, setSearch] = useState(q);
  const debounced = useDebouncedValue(search, 300);
  useEffect(() => {
    if (debounced !== q) onChange({ q: debounced });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced]);

  const definitions = list.data?.items ?? [];
  const def = definitions.find((d) => d.key === reportKey) ?? definitions[0];
  const key = def?.key ?? null;
  // A stale sort from another report would be rejected by the API; fall back to its default.
  const sortKey = sort.replace(/^-/, '');
  const effectiveSort = def?.columns.some((c) => c.key === sortKey && c.sortable) ? sort : '';
  const result = useReportPage(key, {
    ...toApiFilters(filters),
    q: q.trim() || undefined,
    sort: effectiveSort || undefined,
    page,
    pageSize: 25,
  });

  if (list.isPending) return <TableSkeleton columns={5} />;
  if (list.isError)
    return <ErrorState message={errorMessage(list.error)} onRetry={() => list.refetch()} />;
  if (!def) return <EmptyState title="No reports are available for your role." />;
  const activeSort = effectiveSort || def.defaultSort;

  return (
    <>
      <div className="mb-3 flex flex-wrap items-end gap-2">
        <div className="min-w-[220px] flex-1 sm:max-w-[320px]">
          <Select
            aria-label="Report"
            value={def.key}
            onChange={(e) => {
              setSearch('');
              onChange({ report: e.target.value, q: '', sort: '' });
            }}
          >
            {definitions.map((d) => (
              <option key={d.key} value={d.key}>
                {d.title}
              </option>
            ))}
          </Select>
        </div>
        <div className="min-w-[200px] flex-1 sm:max-w-[280px]">
          <Input
            type="search"
            aria-label="Search report"
            placeholder="Search by name"
            leading={<Search className="size-4" />}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        {canExport && (
          <Button
            className="ml-auto"
            leading={<Download className="size-4" />}
            onClick={() => setExportOpen(true)}
          >
            Export
          </Button>
        )}
      </div>
      <p className="mb-3 text-sm text-text-secondary">{def.description}</p>

      {result.isPending ? (
        <TableSkeleton columns={6} />
      ) : result.isError ? (
        <ErrorState message={errorMessage(result.error)} onRetry={() => result.refetch()} />
      ) : result.data.items.length === 0 ? (
        <EmptyState
          title="No rows for this selection"
          description="Widen the date range or clear a filter to see more."
        />
      ) : (
        <>
          <Table caption={def.title}>
            <THead>
              <tr>
                {def.columns.map((c) => {
                  const right = NUMERIC.has(c.type);
                  const cls = cn(right && 'text-right');
                  return c.sortable ? (
                    <SortTh
                      key={c.key}
                      field={c.key}
                      sort={activeSort}
                      onSort={(next) => onChange({ sort: next })}
                      className={cls}
                      align={right ? 'right' : undefined}
                    >
                      {c.label}
                    </SortTh>
                  ) : (
                    <Th key={c.key} className={cls}>
                      {c.label}
                    </Th>
                  );
                })}
              </tr>
            </THead>
            <TBody>
              {result.data.items.map((row, r) => (
                <Tr key={`${page}-${r}`}>
                  {def.columns.map((c, i) => {
                    const value = row[c.key];
                    const userId = typeof row.userId === 'string' ? row.userId : null;
                    return (
                      <Td
                        key={c.key}
                        className={cn(
                          'text-sm whitespace-nowrap',
                          NUMERIC.has(c.type) && 'tabular text-right',
                          i === 0 ? 'font-medium' : 'text-text-secondary',
                        )}
                      >
                        {c.key === 'employee' && userId && canOpenTeam ? (
                          <Link
                            to={`/team?learner=${userId}`}
                            className="underline-offset-2 hover:underline"
                          >
                            {formatCell(value, c.type)}
                          </Link>
                        ) : (
                          formatCell(value, c.type)
                        )}
                      </Td>
                    );
                  })}
                </Tr>
              ))}
            </TBody>
          </Table>
          <Pagination
            page={result.data.page}
            pageCount={result.data.pageCount}
            total={result.data.total}
            pageSize={result.data.pageSize}
            onPage={(p) => onChange({ page: String(p) })}
            noun="rows"
          />
        </>
      )}
      {canExport && (
        <ExportDialog
          open={exportOpen}
          onOpenChange={setExportOpen}
          report={def}
          filters={filters}
          q={q}
          sort={effectiveSort}
          onQueued={() => {
            setExportOpen(false);
            onExported();
          }}
        />
      )}
    </>
  );
}
