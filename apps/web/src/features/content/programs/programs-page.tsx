import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { Copy, MoreHorizontal, Plus, Search } from 'lucide-react';
import { learning } from '@a5/contracts';
import {
  Button,
  ConfirmDialog,
  DialogContent,
  DialogRoot,
  EmptyState,
  ErrorState,
  Field,
  FilterBar,
  IconButton,
  Input,
  MenuContent,
  MenuItem,
  MenuRoot,
  MenuTrigger,
  PageHeader,
  Pagination,
  Select,
  SortTh,
  StatusText,
  Table,
  TableSkeleton,
  Tag,
  TBody,
  Td,
  Textarea,
  Th,
  THead,
  Tr,
  toast,
  type Tone,
} from '@/components/ui';
import { RequirePermission } from '@/app/guards';
import { useCan } from '@/features/auth/session';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import { useSearchState } from '@/hooks/use-search-state';
import { ApiError, errorMessage } from '@/lib/api/errors';
import { formatRelative, pluralize } from '@/lib/format';
import { useArchiveProgram, useCreateProgram, useDuplicateProgram, useProgramList } from './api';
import { boundsOf } from './schema-bounds';

const DEFAULTS = { q: '', status: 'draft,published', sort: 'title', page: '1', create: '' };

const STATUS_FILTERS = [
  { value: 'draft,published', label: 'Draft and published' },
  { value: 'published', label: 'Published' },
  { value: 'draft', label: 'Drafts' },
  { value: 'archived', label: 'Archived' },
  { value: 'draft,published,archived', label: 'All programs' },
];

const STATUS: Record<learning.ProgramStatus, { label: string; tone: Tone }> = {
  draft: { label: 'Draft', tone: 'neutral' },
  published: { label: 'Published', tone: 'success' },
  archived: { label: 'Archived', tone: 'neutral' },
};

/** Default phase label comes from the contract (`Week`), not from this file. */
const PHASE_LABEL_DEFAULT = String(
  boundsOf(learning.createProgramRequestSchema).phaseLabel?.default ?? '',
);

function CreateProgramDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const navigate = useNavigate();
  const create = useCreateProgram();
  const [title, setTitle] = useState('');
  const [phaseLabel, setPhaseLabel] = useState(PHASE_LABEL_DEFAULT);
  const [category, setCategory] = useState('');
  const [summary, setSummary] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  return (
    <DialogRoot
      open={open}
      onOpenChange={(o) => {
        if (!o) {
          setErrors({});
          setFormError(null);
        }
        onOpenChange(o);
      }}
    >
      <DialogContent
        title="New program"
        description="You can add phases, modules and lessons next. Nothing is visible to learners until you publish."
      >
        <form
          className="grid gap-4"
          onSubmit={async (e) => {
            e.preventDefault();
            setErrors({});
            setFormError(null);
            try {
              const created = await create.mutateAsync({
                title: title.trim(),
                phaseLabel: phaseLabel.trim() || undefined,
                category: category.trim() || undefined,
                summary: summary.trim() || undefined,
              });
              toast.success(`${created.title} created`);
              onOpenChange(false);
              navigate(`/content/programs/${created.id}`);
            } catch (err) {
              if (err instanceof ApiError && err.fields.length) {
                setErrors(
                  Object.fromEntries(err.fields.map((f) => [f.path.split('.')[0], f.message])),
                );
                if (
                  err.fields.some(
                    (f) =>
                      !['title', 'phaseLabel', 'category', 'summary'].includes(
                        f.path.split('.')[0]!,
                      ),
                  )
                )
                  setFormError(err.message);
              } else setFormError(errorMessage(err));
            }
          }}
        >
          <Field label="Title" required error={errors.title}>
            <Input
              autoFocus
              value={title}
              maxLength={160}
              onChange={(e) => setTitle(e.target.value)}
            />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Name for its phases"
              hint="Used for each phase, for example Week 1 or Phase 1."
              error={errors.phaseLabel}
            >
              <Input
                value={phaseLabel}
                maxLength={30}
                onChange={(e) => setPhaseLabel(e.target.value)}
              />
            </Field>
            <Field label="Category" optional error={errors.category}>
              <Input
                value={category}
                maxLength={80}
                onChange={(e) => setCategory(e.target.value)}
              />
            </Field>
          </div>
          <Field label="Summary" optional error={errors.summary}>
            <Textarea
              rows={3}
              value={summary}
              maxLength={1000}
              onChange={(e) => setSummary(e.target.value)}
            />
          </Field>
          {formError && (
            <p role="alert" className="rounded bg-danger-soft px-3 py-2 text-sm text-danger">
              {formError}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button
              type="submit"
              variant="primary"
              loading={create.isPending}
              disabled={!title.trim()}
            >
              Create program
            </Button>
          </div>
        </form>
      </DialogContent>
    </DialogRoot>
  );
}

function RowMenu({ program }: { program: learning.ProgramSummary }) {
  const navigate = useNavigate();
  const duplicate = useDuplicateProgram();
  const archiveProgram = useArchiveProgram();
  const canCreate = useCan('programs.create');
  const canArchive = useCan('programs.archive');
  const [confirm, setConfirm] = useState(false);
  const archived = program.status === 'archived';
  if (!canCreate && !canArchive) return null;
  return (
    <>
      <MenuRoot>
        <MenuTrigger asChild>
          <IconButton label={`Actions for ${program.title}`} size="sm">
            <MoreHorizontal className="size-4" />
          </IconButton>
        </MenuTrigger>
        <MenuContent>
          {canCreate && (
            <MenuItem
              icon={<Copy className="size-4" />}
              onSelect={async () => {
                try {
                  const copy = await duplicate.mutateAsync({ id: program.id });
                  toast.success('Copied as a draft', copy.title);
                  navigate(`/content/programs/${copy.id}`);
                } catch (err) {
                  toast.error('Could not copy the program', errorMessage(err));
                }
              }}
            >
              Duplicate as draft
            </MenuItem>
          )}
          {canArchive && (
            <MenuItem onSelect={() => setConfirm(true)} tone={archived ? undefined : 'danger'}>
              {archived ? 'Restore' : 'Archive'}
            </MenuItem>
          )}
        </MenuContent>
      </MenuRoot>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={archived ? `Restore ${program.title}?` : `Archive ${program.title}?`}
        description={
          archived
            ? 'It returns to your draft and published programs.'
            : 'Learners keep their progress, but nobody new can be enrolled while it is archived.'
        }
        confirmLabel={archived ? 'Restore' : 'Archive'}
        tone={archived ? 'primary' : 'danger'}
        loading={archiveProgram.isPending}
        onConfirm={async () => {
          try {
            await archiveProgram.mutateAsync({ id: program.id, archived: !archived });
            toast.success(archived ? 'Program restored' : 'Program archived');
            setConfirm(false);
          } catch (err) {
            toast.error('That did not work', errorMessage(err));
          }
        }}
      />
    </>
  );
}

function Programs() {
  const [state, setState] = useSearchState(DEFAULTS);
  const [search, setSearch] = useState(state.q);
  const q = useDebouncedValue(search, 300);
  useEffect(() => {
    if (q !== state.q) setState({ q });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);
  const canCreate = useCan('programs.create');
  const list = useProgramList({
    q: state.q.trim() || undefined,
    status: state.status,
    sort: state.sort,
    page: Number.parseInt(state.page, 10) || 1,
    pageSize: 25,
  });
  const filtered = Boolean(state.q) || state.status !== DEFAULTS.status;

  return (
    <>
      <PageHeader
        title="Programs"
        description="Build training programs, publish them to learners and keep a history of every version."
        actions={
          canCreate && (
            <Button
              variant="primary"
              leading={<Plus className="size-4" />}
              onClick={() => setState({ create: '1' })}
            >
              New program
            </Button>
          )
        }
      />
      <FilterBar
        activeCount={state.status !== DEFAULTS.status ? 1 : 0}
        search={
          <Input
            type="search"
            aria-label="Search programs"
            placeholder="Search by title, category or summary"
            leading={<Search className="size-4" />}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        }
      >
        <Select
          aria-label="Status"
          value={state.status}
          onChange={(e) => setState({ status: e.target.value })}
        >
          {STATUS_FILTERS.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </Select>
      </FilterBar>

      {list.isPending ? (
        <TableSkeleton columns={5} />
      ) : list.isError ? (
        <ErrorState message={errorMessage(list.error)} onRetry={() => list.refetch()} />
      ) : list.data.items.length === 0 ? (
        <EmptyState
          title={filtered ? 'No programs match these filters' : 'No programs yet'}
          description={
            filtered
              ? 'Try a different search or status.'
              : canCreate
                ? 'Create the first program to start building lessons.'
                : 'Programs appear here once someone creates them.'
          }
          action={
            filtered ? (
              <Button
                onClick={() => {
                  setSearch('');
                  setState({ q: '', status: DEFAULTS.status });
                }}
              >
                Clear filters
              </Button>
            ) : canCreate ? (
              <Button variant="primary" onClick={() => setState({ create: '1' })}>
                New program
              </Button>
            ) : undefined
          }
        />
      ) : (
        <>
          <Table caption="Programs">
            <THead>
              <tr>
                <SortTh field="title" sort={state.sort} onSort={(sort) => setState({ sort })}>
                  Program
                </SortTh>
                <SortTh
                  field="status"
                  sort={state.sort}
                  onSort={(sort) => setState({ sort })}
                  className="hidden sm:table-cell"
                >
                  Status
                </SortTh>
                <Th className="hidden md:table-cell">Contents</Th>
                <Th className="hidden lg:table-cell">Enrolled</Th>
                <SortTh
                  field="updatedAt"
                  sort={state.sort}
                  onSort={(sort) => setState({ sort })}
                  className="hidden sm:table-cell"
                >
                  Updated
                </SortTh>
                <Th className="sr-only">Actions</Th>
              </tr>
            </THead>
            <TBody>
              {list.data.items.map((p) => {
                const s = STATUS[p.status];
                return (
                  <Tr key={p.id}>
                    <Td className="min-w-[220px]">
                      <Link
                        to={`/content/programs/${p.id}`}
                        className="block rounded font-medium hover:underline"
                      >
                        {p.title}
                      </Link>
                      <span className="block max-w-[56ch] truncate text-sm text-text-tertiary">
                        {[p.category, p.summary].filter(Boolean).join(' · ') || 'No summary'}
                      </span>
                      <span className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 sm:hidden">
                        <StatusText tone={s.tone}>{s.label}</StatusText>
                        {p.hasUnpublishedChanges && p.status !== 'archived' && (
                          <Tag tone="warning">
                            {p.status === 'draft' ? 'Never published' : 'Unpublished changes'}
                          </Tag>
                        )}
                      </span>
                    </Td>
                    <Td className="hidden sm:table-cell">
                      <StatusText tone={s.tone}>{s.label}</StatusText>
                      {p.status === 'published' && (
                        <span className="block text-xs text-text-tertiary">
                          Version {p.publishedVersion}
                        </span>
                      )}
                      {p.hasUnpublishedChanges && p.status !== 'archived' && (
                        <Tag tone="warning" className="mt-1">
                          {p.status === 'draft' ? 'Never published' : 'Unpublished changes'}
                        </Tag>
                      )}
                    </Td>
                    <Td className="hidden text-sm text-text-secondary md:table-cell">
                      {pluralize(p.counts.phases, p.phaseLabel.toLowerCase())},{' '}
                      {pluralize(p.counts.lessons, 'lesson')}
                    </Td>
                    <Td className="tabular hidden text-sm text-text-secondary lg:table-cell">
                      {p.counts.activeEnrollments} active · {p.counts.completedEnrollments} done
                    </Td>
                    <Td className="hidden text-sm text-text-secondary sm:table-cell">
                      {formatRelative(p.updatedAt)}
                    </Td>
                    <Td className="text-right">
                      <RowMenu program={p} />
                    </Td>
                  </Tr>
                );
              })}
            </TBody>
          </Table>
          <Pagination
            page={list.data.page}
            pageCount={list.data.pageCount}
            total={list.data.total}
            pageSize={list.data.pageSize}
            onPage={(page) => setState({ page: String(page) })}
            noun="programs"
          />
        </>
      )}
      {canCreate && (
        <CreateProgramDialog
          open={state.create === '1'}
          onOpenChange={(o) => setState({ create: o ? '1' : '' })}
        />
      )}
    </>
  );
}

export function ProgramsPage() {
  return (
    <RequirePermission all={['programs.view']}>
      <Programs />
    </RequirePermission>
  );
}
