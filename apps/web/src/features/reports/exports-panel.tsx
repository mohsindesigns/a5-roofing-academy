import { useState } from 'react';
import { Download, RotateCw } from 'lucide-react';
import type { analytics } from '@a5/contracts';
import {
  Button,
  EmptyState,
  ErrorState,
  Pagination,
  Spinner,
  StatusText,
  Table,
  TableSkeleton,
  TBody,
  Td,
  Th,
  THead,
  Tr,
  toast,
  type Tone,
} from '@/components/ui';
import {
  startDownload,
  useCreateExport,
  useExportDownload,
  useExports,
} from '@/features/analytics/api';
import { errorMessage } from '@/lib/api/errors';
import { formatDate, formatDateTime, formatRelative } from '@/lib/format';

const STATUS: Record<analytics.ExportJob['status'], { label: string; tone: Tone }> = {
  queued: { label: 'Queued', tone: 'information' },
  running: { label: 'Preparing', tone: 'information' },
  completed: { label: 'Ready', tone: 'success' },
  failed: { label: 'Failed', tone: 'danger' },
  expired: { label: 'Expired', tone: 'neutral' },
};

export function formatBytes(bytes: number | null): string {
  if (bytes === null) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** One-line description of the filters stored on an export, for the history table. */
export function describeJobFilters(
  filters: analytics.AnalyticsFilters,
  names: {
    programs?: Map<string, string>;
    teams?: Map<string, string>;
    locations?: Map<string, string>;
  } = {},
): string {
  const parts: string[] = [];
  if (filters.from || filters.to) {
    parts.push(
      `${filters.from ? formatDate(filters.from) : 'Start'} – ${filters.to ? formatDate(filters.to) : 'today'}`,
    );
  }
  if (filters.programId) parts.push(names.programs?.get(filters.programId) ?? 'One program');
  if (filters.teamId) parts.push(names.teams?.get(filters.teamId) ?? 'One team');
  if (filters.locationId) parts.push(names.locations?.get(filters.locationId) ?? 'One location');
  if (filters.certificationId) parts.push('One certification');
  if (filters.managerId) parts.push('One manager');
  if (filters.departmentId) parts.push('One department');
  if (filters.userId) parts.push('One person');
  return parts.length ? parts.join(' · ') : 'No filters';
}

function JobActions({ job }: { job: analytics.ExportJob }) {
  const download = useExportDownload();
  const rerun = useCreateExport();
  if (job.status === 'completed') {
    return (
      <Button
        size="sm"
        loading={download.isPending}
        leading={<Download className="size-3.5" />}
        onClick={async () => {
          try {
            const file = await download.mutateAsync(job.id);
            startDownload(file.url, file.fileName);
          } catch (err) {
            toast.error('Download unavailable', errorMessage(err));
          }
        }}
      >
        Download
        <span className="sr-only"> {job.reportTitle}</span>
      </Button>
    );
  }
  if (job.status === 'failed' || job.status === 'expired') {
    return (
      <Button
        size="sm"
        loading={rerun.isPending}
        leading={<RotateCw className="size-3.5" />}
        onClick={async () => {
          try {
            await rerun.mutateAsync({
              report: job.report,
              format: job.format,
              filters: job.filters,
              sort: job.sort ?? undefined,
            });
            toast.success('Export started');
          } catch (err) {
            toast.error('Could not start the export', errorMessage(err));
          }
        }}
      >
        Run again
        <span className="sr-only"> {job.reportTitle}</span>
      </Button>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-sm text-text-secondary">
      <Spinner size={14} />
      Working…
    </span>
  );
}

/** Export history with live status. The list refreshes every few seconds while a job is active. */
export function ExportsPanel({ names }: { names?: Parameters<typeof describeJobFilters>[1] }) {
  const [page, setPage] = useState(1);
  const exports = useExports(page);
  if (exports.isPending) return <TableSkeleton columns={5} rows={4} />;
  if (exports.isError)
    return <ErrorState message={errorMessage(exports.error)} onRetry={() => exports.refetch()} />;
  if (exports.data.total === 0)
    return (
      <EmptyState
        title="No exports yet"
        description="Export a report from the Reports tab. Files stay available for a limited time, then you can run the export again."
      />
    );
  return (
    <>
      <Table caption="Your report exports">
        <THead>
          <tr>
            <Th>Report</Th>
            <Th>Status</Th>
            <Th className="hidden md:table-cell">Filters</Th>
            <Th className="hidden sm:table-cell">Requested</Th>
            <Th className="sr-only">Actions</Th>
          </tr>
        </THead>
        <TBody>
          {exports.data.items.map((job) => {
            const s = STATUS[job.status];
            return (
              <Tr key={job.id}>
                <Td>
                  <span className="block font-medium">{job.reportTitle}</span>
                  <span className="text-xs text-text-tertiary uppercase">
                    {job.format}
                    {job.fileSize !== null && ` · ${formatBytes(job.fileSize)}`}
                    {job.rowCount !== null && ` · ${job.rowCount.toLocaleString()} rows`}
                  </span>
                </Td>
                <Td>
                  <StatusText tone={s.tone}>{s.label}</StatusText>
                  {job.status === 'failed' && job.error && (
                    <span className="mt-0.5 block max-w-[34ch] text-xs text-text-secondary">
                      {job.error}
                    </span>
                  )}
                  {job.status === 'completed' && job.expiresAt && (
                    <span className="mt-0.5 block text-xs text-text-tertiary">
                      Available until {formatDateTime(job.expiresAt)}
                    </span>
                  )}
                </Td>
                <Td className="hidden max-w-[260px] text-sm text-text-secondary md:table-cell">
                  {describeJobFilters(job.filters, names)}
                </Td>
                <Td className="hidden text-sm text-text-secondary sm:table-cell">
                  {formatRelative(job.createdAt)}
                </Td>
                <Td className="text-right">
                  <JobActions job={job} />
                </Td>
              </Tr>
            );
          })}
        </TBody>
      </Table>
      <Pagination
        page={exports.data.page}
        pageCount={exports.data.pageCount}
        total={exports.data.total}
        pageSize={exports.data.pageSize}
        onPage={setPage}
        noun="exports"
      />
    </>
  );
}
