import { useEffect, useId, useState } from 'react';
import { Download, Search } from 'lucide-react';
import {
  Button,
  EmptyState,
  ErrorState,
  FilterBar,
  Input,
  PageHeader,
  Select,
  StatusText,
  Table,
  TableSkeleton,
  TBody,
  Td,
  Th,
  THead,
  Tr,
  toast,
} from '@/components/ui';
import { RequirePermission } from '@/app/guards';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import { useSearchState } from '@/hooks/use-search-state';
import { errorMessage } from '@/lib/api/errors';
import { formatRelative } from '@/lib/format';
import {
  AUDIT_DEFAULTS,
  auditFilterCount,
  auditRangeError,
  exportAuditCsv,
  useAuditFacets,
  useAuditLogs,
} from './api';
import { AuditDetailDrawer } from './audit-detail';
import { formatTimestamp } from './format';

function actorTone(type: string) {
  return type === 'user' ? 'neutral' : 'information';
}

function AuditLog() {
  const [state, setState] = useSearchState(AUDIT_DEFAULTS);
  const [search, setSearch] = useState(state.q);
  const q = useDebouncedValue(search, 300);
  useEffect(() => {
    if (q !== state.q) setState({ q });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  const rangeError = auditRangeError(state);
  const logs = useAuditLogs(state, !rangeError);
  const facets = useAuditFacets(state.from, state.to);
  const [exporting, setExporting] = useState(false);
  const actionListId = useId();
  const entries = logs.data?.pages.flatMap((p) => p.items) ?? [];
  const filterCount = auditFilterCount(state);

  const openEntry = (id: string) => setState({ entry: id });
  const clear = () => {
    setSearch('');
    setState({ ...AUDIT_DEFAULTS, entry: state.entry });
  };

  return (
    <>
      <PageHeader
        title="Audit log"
        description="A permanent record of administrative and sensitive actions. Entries cannot be edited or deleted."
        actions={
          <Button
            leading={<Download className="size-4" />}
            loading={exporting}
            disabled={Boolean(rangeError)}
            onClick={async () => {
              setExporting(true);
              try {
                const name = await exportAuditCsv(state);
                toast.success('Export downloaded', `${name} matches the filters on screen.`);
              } catch (err) {
                toast.error('Export failed', errorMessage(err));
              } finally {
                setExporting(false);
              }
            }}
          >
            Export CSV
          </Button>
        }
      />
      <FilterBar
        activeCount={filterCount - (state.q ? 1 : 0)}
        search={
          <Input
            type="search"
            aria-label="Search the audit log"
            placeholder="Search actor, action, resource or reason"
            leading={<Search className="size-4" />}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        }
      >
        <Input
          type="date"
          aria-label="From date"
          value={state.from}
          max={state.to || undefined}
          onChange={(e) => setState({ from: e.target.value })}
        />
        <Input
          type="date"
          aria-label="To date"
          value={state.to}
          min={state.from || undefined}
          onChange={(e) => setState({ to: e.target.value })}
        />
        <div>
          <Input
            aria-label="Action"
            placeholder="Action or prefix"
            list={actionListId}
            value={state.action}
            onChange={(e) => setState({ action: e.target.value.trim() })}
          />
          <datalist id={actionListId}>
            {facets.data?.actions.map((a) => (
              <option key={a.value} value={a.value}>
                {a.count.toLocaleString()} entries
              </option>
            ))}
          </datalist>
        </div>
        <Select
          aria-label="Resource type"
          value={state.resourceType}
          onChange={(e) => setState({ resourceType: e.target.value })}
        >
          <option value="">All resources</option>
          {facets.data?.resourceTypes.map((r) => (
            <option key={r.value} value={r.value}>
              {r.value.replace(/_/g, ' ')}
            </option>
          ))}
          {state.resourceType &&
            !facets.data?.resourceTypes.some((r) => r.value === state.resourceType) && (
              <option value={state.resourceType}>{state.resourceType.replace(/_/g, ' ')}</option>
            )}
        </Select>
        <Select
          aria-label="Service"
          value={state.service}
          onChange={(e) => setState({ service: e.target.value })}
        >
          <option value="">All services</option>
          {facets.data?.services.map((s) => (
            <option key={s.value} value={s.value}>
              {s.value}
            </option>
          ))}
        </Select>
        <Select
          aria-label="Actor type"
          value={state.actorType}
          onChange={(e) => setState({ actorType: e.target.value })}
        >
          <option value="">People and systems</option>
          <option value="user">People</option>
          <option value="service">Services</option>
          <option value="system">System</option>
        </Select>
      </FilterBar>
      <p className="mb-3 text-xs text-text-tertiary">
        From and To are whole days in UTC. Times in the table use your time zone.
        {state.resourceId && (
          <>
            {' '}
            Showing one {state.resourceType.replace(/_/g, ' ') || 'resource'} (
            <span className="font-mono">{state.resourceId}</span>).{' '}
            <button
              type="button"
              className="text-information underline underline-offset-2"
              onClick={() => setState({ resourceId: '', resourceType: '' })}
            >
              Show all
            </button>
          </>
        )}
      </p>

      {rangeError ? (
        <p role="alert" className="rounded bg-danger-soft px-3 py-2 text-sm text-danger">
          {rangeError}
        </p>
      ) : logs.isPending ? (
        <TableSkeleton columns={5} rows={8} />
      ) : logs.isError ? (
        <ErrorState message={errorMessage(logs.error)} onRetry={() => logs.refetch()} />
      ) : entries.length === 0 ? (
        <EmptyState
          title={
            filterCount > 0 ? 'No entries match these filters' : 'Nothing has been recorded yet'
          }
          description={
            filterCount > 0
              ? 'Widen the date range or clear a filter.'
              : 'Administrative actions appear here as they happen.'
          }
          action={filterCount > 0 ? <Button onClick={clear}>Clear filters</Button> : undefined}
        />
      ) : (
        <>
          <Table caption="Audit log entries, newest first">
            <THead>
              <tr>
                <Th>When</Th>
                <Th>Action</Th>
                <Th>Actor</Th>
                <Th className="hidden md:table-cell">Resource</Th>
                <Th className="hidden xl:table-cell">Service</Th>
              </tr>
            </THead>
            <TBody>
              {entries.map((e) => (
                <Tr key={e.id} selected={state.entry === e.id} onClick={() => openEntry(e.id)}>
                  <Td className="text-sm whitespace-nowrap text-text-secondary">
                    <time dateTime={e.occurredAt} title={formatRelative(e.occurredAt)}>
                      {formatTimestamp(e.occurredAt)}
                    </time>
                  </Td>
                  <Td>
                    <button
                      type="button"
                      className="rounded text-left"
                      aria-haspopup="dialog"
                      aria-label={`Open details: ${e.action}, ${e.actor.displayName ?? e.actor.type}`}
                      onClick={(ev) => {
                        ev.stopPropagation();
                        openEntry(e.id);
                      }}
                    >
                      <span className="block font-mono text-xs break-all">{e.action}</span>
                      {e.reason && (
                        <span className="block max-w-[44ch] truncate text-xs text-text-secondary">
                          {e.reason}
                        </span>
                      )}
                      {e.hasChanges && (
                        <span className="text-xs text-text-tertiary">Includes changes</span>
                      )}
                    </button>
                  </Td>
                  <Td className="text-sm">
                    {e.actor.displayName ?? (
                      <span className="text-text-secondary capitalize">{e.actor.type}</span>
                    )}
                    {e.actor.type !== 'user' && (
                      <span className="ml-1.5">
                        <StatusText tone={actorTone(e.actor.type)} className="text-xs font-normal">
                          {e.actor.type}
                        </StatusText>
                      </span>
                    )}
                  </Td>
                  <Td className="hidden text-sm md:table-cell">
                    <span className="capitalize">{e.resourceType.replace(/_/g, ' ')}</span>
                    {e.resourceId && (
                      <span className="block max-w-[24ch] truncate font-mono text-xs text-text-tertiary">
                        {e.resourceId}
                      </span>
                    )}
                  </Td>
                  <Td className="hidden text-sm text-text-secondary xl:table-cell">{e.service}</Td>
                </Tr>
              ))}
            </TBody>
          </Table>
          <div className="flex flex-wrap items-center justify-between gap-3 pt-3 text-sm text-text-secondary">
            <p className="tabular" aria-live="polite">
              {entries.length.toLocaleString()} {entries.length === 1 ? 'entry' : 'entries'} loaded
              {logs.hasNextPage ? '' : ' (all)'}
            </p>
            {logs.hasNextPage && (
              <Button loading={logs.isFetchingNextPage} onClick={() => logs.fetchNextPage()}>
                Load older entries
              </Button>
            )}
          </div>
        </>
      )}

      <AuditDetailDrawer
        entryId={state.entry || null}
        onClose={() => setState({ entry: '' })}
        onOpen={openEntry}
        onFilterResource={(type, id) => setState({ resourceType: type, resourceId: id, entry: '' })}
      />
    </>
  );
}

export function AuditPage() {
  return (
    <RequirePermission all={['audit_logs.view']}>
      <AuditLog />
    </RequirePermission>
  );
}
