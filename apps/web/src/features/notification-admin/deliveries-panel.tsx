import { useEffect, useState } from 'react';
import { Search } from 'lucide-react';
import { notification } from '@a5/contracts';
import {
  DescriptionList,
  DialogRoot,
  EmptyState,
  ErrorState,
  FilterBar,
  Input,
  Pagination,
  Select,
  SheetContent,
  Skeleton,
  StatusText,
  Table,
  TableSkeleton,
  TBody,
  Td,
  Th,
  THead,
  Tr,
  type Tone,
} from '@/components/ui';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import { useSearchState } from '@/hooks/use-search-state';
import { errorMessage } from '@/lib/api/errors';
import { formatDateTime, formatRelative } from '@/lib/format';
import { useDelivery, useDeliveries } from './api';

const STATUS: Record<notification.EmailDeliveryStatus, { label: string; tone: Tone }> = {
  queued: { label: 'Waiting to send', tone: 'information' },
  sent: { label: 'Sent', tone: 'success' },
  failed: { label: 'Failed', tone: 'danger' },
};

const DEFAULTS = { dq: '', status: '', type: '', dpage: '1', delivery: '' };

function DeliveryDetail({ id }: { id: string }) {
  const detail = useDelivery(id);
  if (detail.isPending) return <Skeleton className="h-64 w-full" />;
  if (detail.isError)
    return <ErrorState message={errorMessage(detail.error)} onRetry={() => detail.refetch()} />;
  const d = detail.data;
  const s = STATUS[d.status];
  return (
    <div className="flex flex-col gap-6">
      <DescriptionList
        columns={1}
        items={[
          { label: 'Status', value: <StatusText tone={s.tone}>{s.label}</StatusText> },
          { label: 'To', value: d.toName ? `${d.toName} <${d.to}>` : d.to },
          { label: 'Subject', value: d.subject },
          { label: 'Attempts', value: String(d.attempts) },
          { label: 'Scheduled', value: formatDateTime(d.scheduledAt) },
          {
            label: 'Last attempt',
            value: d.lastAttemptAt ? formatDateTime(d.lastAttemptAt) : null,
          },
          { label: 'Sent', value: d.sentAt ? formatDateTime(d.sentAt) : null },
          { label: 'Failed', value: d.failedAt ? formatDateTime(d.failedAt) : null },
          { label: 'Provider message ID', value: d.providerMessageId },
        ]}
      />
      {d.error && (
        <p role="alert" className="rounded bg-danger-soft px-3 py-2 text-sm text-danger">
          {d.error}
        </p>
      )}
      <section aria-labelledby="delivery-content">
        <h3 id="delivery-content" className="mb-2 text-md font-semibold">
          Message
        </h3>
        {d.sensitive ? (
          <p className="text-sm text-text-secondary">
            This is a security email. Its content contains a one-time link and is never stored.
          </p>
        ) : d.text ? (
          <pre className="max-h-[360px] overflow-auto rounded border border-border bg-surface-sunken p-3 font-sans text-sm break-words whitespace-pre-wrap">
            {d.text}
          </pre>
        ) : (
          <p className="text-sm text-text-secondary">No message content was kept.</p>
        )}
      </section>
    </div>
  );
}

/** Email delivery log: every email the academy tried to send, with its outcome. */
export function DeliveriesPanel() {
  const [state, setState] = useSearchState(DEFAULTS);
  const [search, setSearch] = useState(state.dq);
  const q = useDebouncedValue(search, 300);
  useEffect(() => {
    if (q !== state.dq) setState({ dq: q, dpage: '1' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);
  const page = Number.parseInt(state.dpage, 10) || 1;
  const deliveries = useDeliveries({
    page,
    pageSize: 25,
    q: state.dq.trim() || undefined,
    status: state.status || undefined,
    type: state.type || undefined,
  });
  const filtered = Boolean(state.dq || state.status || state.type);

  return (
    <>
      <FilterBar
        activeCount={[state.status, state.type].filter(Boolean).length}
        search={
          <Input
            type="search"
            aria-label="Search recipients"
            placeholder="Search recipient name or address"
            leading={<Search className="size-4" />}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        }
      >
        <Select
          aria-label="Status"
          value={state.status}
          onChange={(e) => setState({ status: e.target.value, dpage: '1' })}
        >
          <option value="">Any status</option>
          {notification.EMAIL_DELIVERY_STATUSES.map((s) => (
            <option key={s} value={s}>
              {STATUS[s].label}
            </option>
          ))}
        </Select>
        <Select
          aria-label="Notification type"
          value={state.type}
          onChange={(e) => setState({ type: e.target.value, dpage: '1' })}
        >
          <option value="">Any notification</option>
          {notification.NOTIFICATION_TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </Select>
      </FilterBar>

      {deliveries.isPending ? (
        <TableSkeleton columns={5} />
      ) : deliveries.isError ? (
        <ErrorState message={errorMessage(deliveries.error)} onRetry={() => deliveries.refetch()} />
      ) : deliveries.data.items.length === 0 ? (
        <EmptyState
          title={filtered ? 'No emails match these filters' : 'No emails have been sent yet'}
          description={
            filtered ? 'Try another status or clear the search.' : 'Sent emails are listed here.'
          }
        />
      ) : (
        <>
          <Table caption="Email deliveries">
            <THead>
              <tr>
                <Th>Recipient</Th>
                <Th className="hidden md:table-cell">Notification</Th>
                <Th>Status</Th>
                <Th className="hidden sm:table-cell">When</Th>
              </tr>
            </THead>
            <TBody>
              {deliveries.data.items.map((d) => {
                const s = STATUS[d.status];
                return (
                  <Tr
                    key={d.id}
                    selected={state.delivery === d.id}
                    onClick={() => setState({ delivery: d.id, dpage: state.dpage })}
                  >
                    <Td>
                      <button
                        type="button"
                        className="rounded text-left"
                        aria-haspopup="dialog"
                        aria-label={`Open delivery to ${d.toName ?? d.to}: ${d.subject}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          setState({ delivery: d.id, dpage: state.dpage });
                        }}
                      >
                        <span className="block font-medium">{d.toName ?? d.to}</span>
                        <span className="block max-w-[44ch] truncate text-xs text-text-secondary">
                          {d.subject}
                        </span>
                      </button>
                    </Td>
                    <Td className="hidden font-mono text-xs text-text-secondary md:table-cell">
                      {d.type}
                    </Td>
                    <Td>
                      <StatusText tone={s.tone}>{s.label}</StatusText>
                      {d.status === 'failed' && d.attempts > 0 && (
                        <span className="block text-xs text-text-tertiary">
                          after {d.attempts} {d.attempts === 1 ? 'attempt' : 'attempts'}
                        </span>
                      )}
                    </Td>
                    <Td className="hidden text-sm text-text-secondary sm:table-cell">
                      {formatRelative(d.sentAt ?? d.failedAt ?? d.createdAt)}
                    </Td>
                  </Tr>
                );
              })}
            </TBody>
          </Table>
          <Pagination
            page={deliveries.data.page}
            pageCount={deliveries.data.pageCount}
            total={deliveries.data.total}
            pageSize={deliveries.data.pageSize}
            onPage={(p) => setState({ dpage: String(p) })}
            noun="emails"
          />
        </>
      )}

      <DialogRoot
        open={Boolean(state.delivery)}
        onOpenChange={(o) => !o && setState({ delivery: '', dpage: state.dpage })}
      >
        <SheetContent title="Email delivery" description="What was sent and what happened.">
          {state.delivery && <DeliveryDetail id={state.delivery} />}
        </SheetContent>
      </DialogRoot>
    </>
  );
}
