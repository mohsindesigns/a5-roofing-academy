import { useState } from 'react';
import { Copy } from 'lucide-react';
import type { audit } from '@a5/contracts';
import {
  Button,
  DescriptionList,
  DialogRoot,
  ErrorState,
  SheetContent,
  Skeleton,
  Switch,
  Table,
  TBody,
  Td,
  Th,
  THead,
  Tr,
  toast,
} from '@/components/ui';
import { cn } from '@/lib/cn';
import { errorMessage } from '@/lib/api/errors';
import { describeUserAgent } from '@/lib/format';
import { useAuditEntry, useResourceHistory } from './api';
import { diffSnapshots, formatValue, summarizeDiff, type DiffKind } from './diff';
import { formatTimestamp } from './format';

const KIND: Record<DiffKind, { label: string; mark: string; text: string }> = {
  added: { label: 'Added', mark: '+', text: 'text-success' },
  removed: { label: 'Removed', mark: '−', text: 'text-danger' },
  changed: { label: 'Changed', mark: '~', text: 'text-warning' },
  unchanged: { label: 'Unchanged', mark: '', text: 'text-text-tertiary' },
};

/** Before / after comparison. Each row says what happened in words, not only in colour. */
export function ChangesTable({ before, after }: { before: unknown; after: unknown }) {
  const [showAll, setShowAll] = useState(false);
  const rows = diffSnapshots(before, after);
  const counts = summarizeDiff(rows);
  const visible = showAll ? rows : rows.filter((r) => r.kind !== 'unchanged');
  if (rows.length === 0) {
    return <p className="text-sm text-text-secondary">No before or after snapshot was recorded.</p>;
  }
  const unchanged = rows.length - counts.added - counts.removed - counts.changed;
  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-text-secondary">
          {counts.changed} changed · {counts.added} added · {counts.removed} removed
        </p>
        {unchanged > 0 && (
          <label className="flex items-center gap-2 text-sm text-text-secondary">
            <Switch
              checked={showAll}
              onCheckedChange={setShowAll}
              aria-label={`Show ${unchanged} unchanged fields`}
            />
            Show {unchanged} unchanged
          </label>
        )}
      </div>
      <Table caption="Changes recorded by this entry">
        <THead>
          <tr>
            <Th>Field</Th>
            <Th>Before</Th>
            <Th>After</Th>
          </tr>
        </THead>
        <TBody>
          {visible.map((r) => {
            const k = KIND[r.kind];
            return (
              <Tr key={r.path}>
                <Td className="align-top">
                  <span className="block font-mono text-xs break-all">{r.path}</span>
                  <span className={cn('text-xs font-medium', k.text)}>
                    {k.mark && <span aria-hidden>{k.mark} </span>}
                    {k.label}
                  </span>
                </Td>
                <Td
                  className={cn(
                    'align-top font-mono text-xs break-all',
                    r.kind === 'removed' || r.kind === 'changed'
                      ? 'text-text-primary'
                      : 'text-text-tertiary',
                  )}
                >
                  {r.kind === 'added' ? '—' : formatValue(r.before)}
                </Td>
                <Td
                  className={cn(
                    'align-top font-mono text-xs break-all',
                    r.kind === 'added' || r.kind === 'changed'
                      ? 'text-text-primary'
                      : 'text-text-tertiary',
                  )}
                >
                  {r.kind === 'removed' ? '—' : formatValue(r.after)}
                </Td>
              </Tr>
            );
          })}
        </TBody>
      </Table>
    </div>
  );
}

function CopyValue({ value, label }: { value: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="font-mono text-xs break-all">{value}</span>
      <Button
        size="sm"
        variant="ghost"
        className="-my-1 px-1.5"
        aria-label={`Copy ${label}`}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(value);
            toast.success(`${label} copied`);
          } catch {
            toast.error('Could not copy', 'Select the text and copy it manually.');
          }
        }}
      >
        <Copy className="size-3.5" />
      </Button>
    </span>
  );
}

function History({ entry, onOpen }: { entry: audit.AuditLog; onOpen: (id: string) => void }) {
  const history = useResourceHistory(entry.resourceType, entry.resourceId);
  if (!entry.resourceId) return null;
  const others = history.data?.items.filter((h) => h.id !== entry.id) ?? [];
  return (
    <section aria-labelledby="audit-history">
      <h3 id="audit-history" className="mb-2 text-md font-semibold">
        Other entries for this {entry.resourceType.replace(/_/g, ' ')}
      </h3>
      {history.isPending ? (
        <Skeleton className="h-16 w-full" />
      ) : history.isError ? (
        <ErrorState
          title="History could not be loaded"
          message={errorMessage(history.error)}
          onRetry={() => history.refetch()}
        />
      ) : others.length === 0 ? (
        <p className="text-sm text-text-secondary">This is the only recorded entry.</p>
      ) : (
        <ul className="divide-y divide-divider border-y border-divider">
          {others.map((h) => (
            <li key={h.id}>
              <button
                type="button"
                className="flex w-full items-baseline justify-between gap-3 py-2 text-left hover:bg-surface-hover"
                onClick={() => onOpen(h.id)}
              >
                <span className="min-w-0">
                  <span className="block truncate font-mono text-xs">{h.action}</span>
                  <span className="block truncate text-xs text-text-secondary">
                    {h.actor.displayName ?? h.actor.type}
                  </span>
                </span>
                <span className="shrink-0 text-xs text-text-tertiary">
                  {formatTimestamp(h.occurredAt)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Body({
  id,
  onOpen,
  onFilterResource,
}: {
  id: string;
  onOpen: (id: string) => void;
  onFilterResource: (type: string, id: string) => void;
}) {
  const entry = useAuditEntry(id);
  if (entry.isPending) return <Skeleton className="h-64 w-full" />;
  if (entry.isError)
    return <ErrorState message={errorMessage(entry.error)} onRetry={() => entry.refetch()} />;
  const e = entry.data;
  return (
    <div className="flex flex-col gap-7">
      <DescriptionList
        columns={2}
        items={[
          {
            label: 'Actor',
            value: (
              <>
                {e.actor.displayName ?? (e.actor.type === 'system' ? 'System' : 'Unknown')}
                <span className="ml-2 text-sm text-text-tertiary capitalize">{e.actor.type}</span>
              </>
            ),
          },
          {
            label: 'Resource',
            value: <span className="capitalize">{e.resourceType.replace(/_/g, ' ')}</span>,
          },
          { label: 'Service', value: e.service },
          { label: 'Reason', value: e.reason },
        ]}
      />

      <section aria-labelledby="audit-changes">
        <h3 id="audit-changes" className="mb-2 text-md font-semibold">
          Changes
        </h3>
        <ChangesTable before={e.before} after={e.after} />
      </section>

      <details className="group rounded border border-border">
        <summary className="cursor-pointer px-3 py-2 text-sm font-medium select-none">
          Technical details
        </summary>
        <div className="border-t border-divider px-3 py-3">
          <DescriptionList
            columns={1}
            items={[
              {
                label: 'Actor ID',
                value: e.actor.id && <CopyValue value={e.actor.id} label="Actor ID" />,
              },
              {
                label: 'Resource ID',
                value: e.resourceId && <CopyValue value={e.resourceId} label="Resource ID" />,
              },
              { label: 'IP address', value: e.ip },
              { label: 'Device', value: e.userAgent ? describeUserAgent(e.userAgent) : null },
              {
                label: 'Request ID',
                value: e.requestId && <CopyValue value={e.requestId} label="Request ID" />,
              },
              {
                label: 'Correlation ID',
                value: e.correlationId && (
                  <CopyValue value={e.correlationId} label="Correlation ID" />
                ),
              },
              { label: 'Happened', value: formatTimestamp(e.occurredAt, true) },
              { label: 'Recorded', value: formatTimestamp(e.recordedAt, true) },
            ]}
          />
        </div>
      </details>

      {Object.keys(e.metadata).length > 0 && (
        <section aria-labelledby="audit-metadata">
          <h3 id="audit-metadata" className="mb-2 text-md font-semibold">
            Details
          </h3>
          <pre className="max-h-64 overflow-auto rounded border border-border bg-surface-sunken p-3 font-mono text-xs break-words whitespace-pre-wrap">
            {JSON.stringify(e.metadata, null, 2)}
          </pre>
        </section>
      )}

      <History entry={e} onOpen={onOpen} />

      <div className="flex flex-wrap items-center gap-3 border-t border-divider pt-4">
        {e.resourceId && (
          <Button onClick={() => onFilterResource(e.resourceType, e.resourceId!)}>
            Show only this {e.resourceType.replace(/_/g, ' ')}
          </Button>
        )}
        <p className="text-xs text-text-tertiary">
          Audit entries are permanent and cannot be edited or deleted.
        </p>
      </div>
    </div>
  );
}

/** Read-only detail of one audit entry, opened from the list (`?entry=`). */
export function AuditDetailDrawer({
  entryId,
  onClose,
  onOpen,
  onFilterResource,
}: {
  entryId: string | null;
  onClose: () => void;
  onOpen: (id: string) => void;
  onFilterResource: (type: string, id: string) => void;
}) {
  const entry = useAuditEntry(entryId);
  return (
    <DialogRoot open={Boolean(entryId)} onOpenChange={(o) => !o && onClose()}>
      <SheetContent
        className="sm:w-[min(720px,94vw)]"
        title={<span className="font-mono text-base">{entry.data?.action ?? 'Audit entry'}</span>}
        description={entry.data ? formatTimestamp(entry.data.occurredAt, true) : undefined}
      >
        {entryId && <Body id={entryId} onOpen={onOpen} onFilterResource={onFilterResource} />}
      </SheetContent>
    </DialogRoot>
  );
}
