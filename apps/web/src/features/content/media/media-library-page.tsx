import { useEffect, useState } from 'react';
import { Search, Upload } from 'lucide-react';
import { media } from '@a5/contracts';
import {
  Button,
  EmptyState,
  ErrorState,
  FilterBar,
  Input,
  PageHeader,
  Pagination,
  Select,
  SortTh,
  Switch,
  Table,
  TableSkeleton,
  TBody,
  Td,
  Th,
  THead,
  Tr,
} from '@/components/ui';
import { RequirePermission } from '@/app/guards';
import { useCan } from '@/features/auth/session';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import { useSearchState } from '@/hooks/use-search-state';
import { errorMessage } from '@/lib/api/errors';
import { formatRelative } from '@/lib/format';
import { useMediaList } from './api';
import { MediaDetail } from './media-detail';
import { KIND_LABEL, MediaStatus, MediaThumb, STATUS, formatDuration } from './media-status';
import { formatFileSize } from './upload';
import { UploadDialog } from './upload-dialog';
import { UploadsPanel } from './uploads-panel';

const DEFAULTS = {
  q: '',
  kind: '',
  status: '',
  archived: '',
  sort: '-createdAt',
  page: '1',
  asset: '',
};

function Library() {
  const [state, setState] = useSearchState(DEFAULTS);
  const [search, setSearch] = useState(state.q);
  const q = useDebouncedValue(search, 300);
  useEffect(() => {
    if (q !== state.q) setState({ q });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);
  const canUpload = useCan('media.upload');
  const [uploadOpen, setUploadOpen] = useState(false);
  const [dropped, setDropped] = useState<File[]>([]);
  const [dragging, setDragging] = useState(false);

  const list = useMediaList({
    q: state.q.trim() || undefined,
    kind: state.kind || undefined,
    status: state.status || undefined,
    includeArchived: state.archived === 'true',
    sort: state.sort,
    page: Number.parseInt(state.page, 10) || 1,
    pageSize: 25,
  });
  const filtered = Boolean(state.q || state.kind || state.status || state.archived);
  const open = (id: string) => setState({ asset: id, page: state.page });

  return (
    <div
      onDragOver={(e) => {
        if (!canUpload || !e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragging(false);
      }}
      onDrop={(e) => {
        if (!canUpload || e.dataTransfer.files.length === 0) return;
        e.preventDefault();
        setDragging(false);
        setDropped(Array.from(e.dataTransfer.files));
        setUploadOpen(true);
      }}
      className={
        dragging ? 'rounded-lg outline outline-2 outline-offset-4 outline-information' : undefined
      }
    >
      <PageHeader
        title="Media library"
        description="Videos, documents and images used in lessons. Drop files anywhere on this page to upload."
        actions={
          canUpload && (
            <Button
              variant="primary"
              leading={<Upload className="size-4" />}
              onClick={() => {
                setDropped([]);
                setUploadOpen(true);
              }}
            >
              Upload
            </Button>
          )
        }
      />
      <UploadsPanel />
      <FilterBar
        activeCount={[state.kind, state.status, state.archived].filter(Boolean).length}
        search={
          <Input
            type="search"
            aria-label="Search the library"
            placeholder="Search by title or file name"
            leading={<Search className="size-4" />}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        }
      >
        <Select
          aria-label="Type"
          value={state.kind}
          onChange={(e) => setState({ kind: e.target.value })}
        >
          <option value="">All types</option>
          {(['video', 'document', 'image'] as const).map((k) => (
            <option key={k} value={k}>
              {KIND_LABEL[k]}s
            </option>
          ))}
        </Select>
        <Select
          aria-label="Status"
          value={state.status}
          onChange={(e) => setState({ status: e.target.value })}
        >
          <option value="">Any status</option>
          {media.MEDIA_STATUSES.filter((s) => s !== 'archived').map((s) => (
            <option key={s} value={s}>
              {STATUS[s].label}
            </option>
          ))}
        </Select>
        <label className="flex h-[var(--a5-control-height)] items-center gap-2 text-sm text-text-secondary">
          <Switch
            aria-label="Show archived"
            checked={state.archived === 'true'}
            onCheckedChange={(on) => setState({ archived: on ? 'true' : '' })}
          />
          Show archived
        </label>
      </FilterBar>

      {list.isPending ? (
        <TableSkeleton columns={5} />
      ) : list.isError ? (
        <ErrorState message={errorMessage(list.error)} onRetry={() => list.refetch()} />
      ) : list.data.items.length === 0 ? (
        <EmptyState
          title={filtered ? 'Nothing matches these filters' : 'The library is empty'}
          description={
            filtered
              ? 'Try a different search or clear the filters.'
              : canUpload
                ? 'Upload a video or document to use it in a lesson.'
                : 'Media appears here once someone uploads it.'
          }
          action={
            filtered ? (
              <Button
                onClick={() => {
                  setSearch('');
                  setState({ q: '', kind: '', status: '', archived: '' });
                }}
              >
                Clear filters
              </Button>
            ) : canUpload ? (
              <Button variant="primary" onClick={() => setUploadOpen(true)}>
                Upload
              </Button>
            ) : undefined
          }
        />
      ) : (
        <>
          <Table caption="Media library">
            <THead>
              <tr>
                <SortTh field="title" sort={state.sort} onSort={(sort) => setState({ sort })}>
                  Title
                </SortTh>
                <Th className="hidden sm:table-cell">Type</Th>
                <Th className="hidden sm:table-cell">Status</Th>
                <SortTh
                  field="sizeBytes"
                  sort={state.sort}
                  onSort={(sort) => setState({ sort })}
                  className="hidden md:table-cell"
                >
                  Size
                </SortTh>
                <SortTh
                  field="createdAt"
                  sort={state.sort}
                  onSort={(sort) => setState({ sort })}
                  className="hidden lg:table-cell"
                >
                  Added
                </SortTh>
              </tr>
            </THead>
            <TBody>
              {list.data.items.map((a) => (
                <Tr key={a.id} selected={state.asset === a.id} onClick={() => open(a.id)}>
                  <Td className="min-w-[220px]">
                    <button
                      type="button"
                      className="flex min-w-0 items-center gap-3 rounded text-left"
                      aria-haspopup="dialog"
                      aria-label={`${a.title}, open details`}
                      onClick={(e) => {
                        e.stopPropagation();
                        open(a.id);
                      }}
                    >
                      <MediaThumb asset={a} />
                      <span className="min-w-0">
                        <span className="block truncate font-medium">{a.title}</span>
                        <span className="block truncate text-xs text-text-tertiary">
                          {a.originalFilename}
                        </span>
                        <span className="mt-0.5 block sm:hidden">
                          <MediaStatus status={a.status} />
                        </span>
                      </span>
                    </button>
                  </Td>
                  <Td className="hidden text-sm text-text-secondary sm:table-cell">
                    {KIND_LABEL[a.kind]}
                    {a.durationSeconds !== null && (
                      <span className="tabular block text-xs text-text-tertiary">
                        {formatDuration(a.durationSeconds)}
                      </span>
                    )}
                  </Td>
                  <Td className="hidden sm:table-cell">
                    <MediaStatus status={a.status} />
                    {a.error && (a.status === 'failed' || a.status === 'rejected') && (
                      <span className="mt-0.5 block max-w-[36ch] text-xs text-text-secondary">
                        {a.error}
                      </span>
                    )}
                  </Td>
                  <Td className="tabular hidden text-sm text-text-secondary md:table-cell">
                    {formatFileSize(a.sizeBytes)}
                  </Td>
                  <Td className="hidden text-sm text-text-secondary lg:table-cell">
                    {formatRelative(a.createdAt)}
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
            noun="files"
          />
        </>
      )}

      {canUpload && (
        <UploadDialog open={uploadOpen} onOpenChange={setUploadOpen} initialFiles={dropped} />
      )}
      <MediaDetail
        assetId={state.asset || null}
        onClose={() => setState({ asset: '', page: state.page })}
      />
    </div>
  );
}

export function MediaLibraryPage() {
  return (
    <RequirePermission all={['media.view']}>
      <Library />
    </RequirePermission>
  );
}
