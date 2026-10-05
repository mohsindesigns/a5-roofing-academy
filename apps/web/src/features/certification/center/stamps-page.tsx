import { useEffect, useState } from 'react';
import { Plus, Search } from 'lucide-react';
import {
  Button,
  EmptyState,
  ErrorState,
  FilterBar,
  Input,
  PageHeader,
  Pagination,
  Select,
  StatusText,
  Table,
  TableSkeleton,
  TBody,
  Td,
  Th,
  THead,
  Tr,
} from '@/components/ui';
import { RequirePermission } from '@/app/guards';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import { useSearchState } from '@/hooks/use-search-state';
import { errorMessage } from '@/lib/api/errors';
import { useStamps } from '../api';
import type { Stamp } from '../types';
import { STAMP_KIND_LABEL, StampSheet } from './artwork-sheets';
import { usageWindow } from './signatories-page';

const DEFAULTS = { q: '', active: '', page: '1' };

function Stamps() {
  const [state, setState] = useSearchState(DEFAULTS);
  const [search, setSearch] = useState(state.q ?? '');
  const q = useDebouncedValue(search, 300);
  const [editing, setEditing] = useState<Stamp | 'new' | null>(null);
  useEffect(() => {
    if (q !== (state.q ?? '')) setState({ q });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);
  const list = useStamps({
    q: state.q || undefined,
    active: state.active === 'true' || state.active === 'false' ? state.active : undefined,
    page: Number(state.page) || 1,
    pageSize: 25,
  });
  const filtered = Boolean(state.q || state.active);

  return (
    <>
      <PageHeader
        title="Stamps"
        description="Company seals and department stamps that can be printed on certificates."
        actions={
          <Button
            variant="primary"
            leading={<Plus className="size-4" />}
            onClick={() => setEditing('new')}
          >
            Add stamp
          </Button>
        }
      />
      <FilterBar
        activeCount={state.active ? 1 : 0}
        search={
          <Input
            type="search"
            aria-label="Search stamps"
            placeholder="Search stamps"
            leading={<Search className="size-4" />}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        }
      >
        <Select
          aria-label="Status"
          value={state.active}
          onChange={(e) => setState({ active: e.target.value })}
        >
          <option value="">Active and inactive</option>
          <option value="true">Active</option>
          <option value="false">Inactive</option>
        </Select>
      </FilterBar>

      {list.isPending ? (
        <TableSkeleton columns={4} />
      ) : list.isError ? (
        <ErrorState message={errorMessage(list.error)} onRetry={() => list.refetch()} />
      ) : list.data.items.length === 0 ? (
        <EmptyState
          title={filtered ? 'No stamps match' : 'No stamps yet'}
          description={
            filtered ? 'Try a different search.' : 'Add the official seal, then upload its image.'
          }
          action={
            !filtered ? (
              <Button variant="primary" onClick={() => setEditing('new')}>
                Add stamp
              </Button>
            ) : undefined
          }
        />
      ) : (
        <>
          <Table caption="Stamps">
            <THead>
              <tr>
                <Th>Stamp</Th>
                <Th>Image</Th>
                <Th className="hidden md:table-cell">Status</Th>
                <Th className="hidden lg:table-cell">Usable</Th>
                <Th className="hidden text-right sm:table-cell">Certifications</Th>
              </tr>
            </THead>
            <TBody>
              {list.data.items.map((s) => (
                <Tr key={s.id} onClick={() => setEditing(s)}>
                  <Td>
                    <button
                      type="button"
                      className="block text-left font-medium hover:underline"
                      onClick={(e) => {
                        e.stopPropagation();
                        setEditing(s);
                      }}
                    >
                      {s.name}
                    </button>
                    <span className="block text-sm text-text-secondary">
                      {STAMP_KIND_LABEL[s.kind]}
                      {s.departmentName ? ` · ${s.departmentName}` : ''}
                    </span>
                  </Td>
                  <Td>
                    {s.currentImage?.previewUrl ? (
                      <img
                        src={s.currentImage.previewUrl}
                        alt={`${s.name} stamp`}
                        className="size-10 rounded border border-border bg-white object-contain"
                      />
                    ) : (
                      <StatusText tone="warning">Not uploaded</StatusText>
                    )}
                  </Td>
                  <Td className="hidden md:table-cell">
                    <StatusText tone={s.active ? 'success' : 'neutral'}>
                      {s.active ? 'Active' : 'Inactive'}
                    </StatusText>
                  </Td>
                  <Td className="hidden text-text-secondary lg:table-cell">{usageWindow(s)}</Td>
                  <Td className="hidden text-right text-text-secondary sm:table-cell">
                    {s.allowedCertificationIds.length === 0
                      ? 'All'
                      : s.allowedCertificationIds.length}
                  </Td>
                </Tr>
              ))}
            </TBody>
          </Table>
          <Pagination
            page={list.data.page}
            pageCount={list.data.pageCount}
            total={list.data.total}
            pageSize={list.data.pageSize}
            onPage={(page) => setState({ page: String(page) })}
            noun="stamps"
          />
        </>
      )}
      {editing && (
        <StampSheet
          key={editing === 'new' ? 'new' : editing.id}
          stamp={editing === 'new' ? null : editing}
          open
          onOpenChange={(open) => !open && setEditing(null)}
        />
      )}
    </>
  );
}

export function StampsPage() {
  return (
    <RequirePermission all={['stamps.manage']}>
      <Stamps />
    </RequirePermission>
  );
}
