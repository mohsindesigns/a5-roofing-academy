import { useState } from 'react';
import type { analytics } from '@a5/contracts';
import { Button, DialogContent, DialogRoot, Field, Select, toast } from '@/components/ui';
import { useCreateExport } from '@/features/analytics/api';
import { rangeError, toApiFilters, type AnalyticsFilterState } from '@/features/analytics/filters';
import { errorMessage } from '@/lib/api/errors';

const FORMATS: Array<{ value: analytics.ExportFormat; label: string; hint: string }> = [
  { value: 'xlsx', label: 'Excel workbook (.xlsx)', hint: 'Formatted columns for sharing.' },
  { value: 'csv', label: 'CSV (.csv)', hint: 'Plain values for other tools.' },
  { value: 'pdf', label: 'PDF (.pdf)', hint: 'A printable copy.' },
];

/**
 * Queues an export of the report as currently filtered. The file is prepared in the background;
 * progress and the download link are on the Exports tab.
 */
export function ExportDialog({
  open,
  onOpenChange,
  report,
  filters,
  q,
  sort,
  onQueued,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  report: analytics.ReportDefinitionDto;
  filters: AnalyticsFilterState;
  q: string;
  sort: string;
  onQueued: () => void;
}) {
  const create = useCreateExport();
  const [format, setFormat] = useState<analytics.ExportFormat>('xlsx');
  const [error, setError] = useState<string | null>(null);
  const invalidRange = rangeError(filters);
  const hint = FORMATS.find((f) => f.value === format)?.hint;
  return (
    <DialogRoot
      open={open}
      onOpenChange={(o) => {
        setError(null);
        onOpenChange(o);
      }}
    >
      <DialogContent
        size="sm"
        title="Export report"
        description={`${report.title}, with the filters and search you have applied.`}
        footer={
          <>
            <Button onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button
              variant="primary"
              loading={create.isPending}
              disabled={Boolean(invalidRange)}
              onClick={async () => {
                setError(null);
                try {
                  await create.mutateAsync({
                    report: report.key,
                    format,
                    filters: toApiFilters(filters),
                    sort: sort || undefined,
                    q: q.trim() || undefined,
                  });
                  toast.success(
                    'Export started',
                    'It will be ready to download on the Exports tab.',
                  );
                  onQueued();
                } catch (err) {
                  setError(errorMessage(err));
                }
              }}
            >
              Start export
            </Button>
          </>
        }
      >
        <Field label="Format" hint={hint} error={invalidRange ?? error ?? undefined}>
          <Select
            value={format}
            onChange={(e) => setFormat(e.target.value as analytics.ExportFormat)}
          >
            {FORMATS.map((f) => (
              <option key={f.value} value={f.value}>
                {f.label}
              </option>
            ))}
          </Select>
        </Field>
        <p className="mt-3 text-sm text-text-secondary">
          Exports cover every matching row, not just the page on screen. Very large exports stop at
          a row limit and say so in the file. You only get people you are allowed to see, and each
          download is recorded in the audit log.
        </p>
      </DialogContent>
    </DialogRoot>
  );
}
