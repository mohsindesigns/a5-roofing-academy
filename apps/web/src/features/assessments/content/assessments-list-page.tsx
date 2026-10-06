import { useEffect, useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router';
import { Plus, Search } from 'lucide-react';
import { assessment } from '@a5/contracts';
import {
  Button,
  DialogContent,
  DialogRoot,
  EmptyState,
  ErrorState,
  Field,
  FilterBar,
  Input,
  PageHeader,
  Pagination,
  Select,
  SortTh,
  StatusText,
  Table,
  TableSkeleton,
  TBody,
  Td,
  Textarea,
  Th,
  THead,
  Tr,
  toast,
} from '@/components/ui';
import { RequirePermission } from '@/app/guards';
import { useCan, usePermissions } from '@/features/auth/session';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import { useSearchState } from '@/hooks/use-search-state';
import { applyServerErrors } from '@/lib/forms';
import { errorMessage } from '@/lib/api/errors';
import { formatRelative } from '@/lib/format';
import { useForm } from 'react-hook-form';
import { useAssessments, useCreateAssessment } from '../api';
import { ASSESSMENT_STATUS, KIND_LABELS } from '../labels';
import { ContentNav } from './content-nav';

const DEFAULTS = { q: '', status: 'draft,published', kind: '', sort: '-updatedAt', page: '1' };

interface NewValues {
  title: string;
  kind: string;
  description: string;
}

function NewAssessmentDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const navigate = useNavigate();
  const create = useCreateAssessment();
  const [formError, setFormError] = useState<string | null>(null);
  const { register, handleSubmit, setError, reset, formState } = useForm<NewValues>({
    defaultValues: { title: '', kind: 'quiz', description: '' },
  });
  return (
    <DialogRoot
      open={open}
      onOpenChange={(o) => {
        if (!o) {
          reset();
          setFormError(null);
        }
        onOpenChange(o);
      }}
    >
      <DialogContent
        title="New assessment"
        description="Start with the basics. You add questions and set the pass mark and attempt rules next, and nothing reaches learners until you publish."
      >
        <form
          className="grid gap-4"
          noValidate
          onSubmit={handleSubmit(async (v) => {
            setFormError(null);
            const title = v.title.trim();
            if (!title) return setError('title', { message: 'Give the assessment a title' });
            try {
              const created = await create.mutateAsync({
                title,
                kind: v.kind as assessment.AssessmentKind,
                description: v.description.trim() || null,
              });
              toast.success('Draft created');
              onOpenChange(false);
              navigate(`/content/assessments/${created.id}`);
            } catch (err) {
              setFormError(applyServerErrors(err, setError, ['title', 'kind', 'description']));
            }
          })}
        >
          <Field label="Title" required error={formState.errors.title?.message}>
            <Input autoFocus maxLength={200} {...register('title')} />
          </Field>
          <Field
            label="Type"
            hint="The kind of assessment learners see, such as quiz or final assessment."
          >
            <Select {...register('kind')}>
              {assessment.ASSESSMENT_KINDS.map((k) => (
                <option key={k} value={k}>
                  {KIND_LABELS[k]}
                </option>
              ))}
            </Select>
          </Field>
          <Field
            label="Description"
            optional
            hint="Learners read this before they start."
            error={formState.errors.description?.message}
          >
            <Textarea rows={3} maxLength={5000} {...register('description')} />
          </Field>
          {formError && (
            <p role="alert" className="rounded bg-danger-soft px-3 py-2 text-sm text-danger">
              {formError}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" variant="primary" loading={formState.isSubmitting}>
              Create draft
            </Button>
          </div>
        </form>
      </DialogContent>
    </DialogRoot>
  );
}

function AssessmentsList() {
  const navigate = useNavigate();
  const canCreate = useCan('assessments.create');
  const [state, setState] = useSearchState(DEFAULTS);
  const [search, setSearch] = useState(state.q ?? '');
  const [creating, setCreating] = useState(false);
  const q = useDebouncedValue(search, 300);
  useEffect(() => {
    if (q !== (state.q ?? '')) setState({ q });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  const list = useAssessments({
    q: state.q || undefined,
    status: state.status === 'all' ? undefined : state.status,
    kind: state.kind || undefined,
    sort: state.sort,
    page: Number(state.page),
    pageSize: 25,
  });
  const filtered = Boolean(state.q || state.kind || state.status !== DEFAULTS.status);

  return (
    <>
      <PageHeader
        title="Assessments"
        description="Quizzes and exams that lessons link to. Each one draws on the question bank and carries its own pass mark and attempt rules."
        actions={
          canCreate && (
            <Button
              variant="primary"
              leading={<Plus className="size-4" />}
              onClick={() => setCreating(true)}
            >
              New assessment
            </Button>
          )
        }
      />
      <ContentNav />
      <FilterBar
        activeCount={
          [state.kind, state.status !== DEFAULTS.status ? 'status' : ''].filter(Boolean).length
        }
        search={
          <Input
            type="search"
            aria-label="Search assessments"
            placeholder="Search by title or description"
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
          <option value="draft,published">Draft and published</option>
          <option value="draft">Draft</option>
          <option value="published">Published</option>
          <option value="archived">Archived</option>
          <option value="all">All statuses</option>
        </Select>
        <Select
          aria-label="Type"
          value={state.kind}
          onChange={(e) => setState({ kind: e.target.value })}
        >
          <option value="">All types</option>
          {assessment.ASSESSMENT_KINDS.map((k) => (
            <option key={k} value={k}>
              {KIND_LABELS[k]}
            </option>
          ))}
        </Select>
      </FilterBar>

      {list.isPending ? (
        <TableSkeleton columns={6} />
      ) : list.isError ? (
        <ErrorState message={errorMessage(list.error)} onRetry={() => list.refetch()} />
      ) : list.data.items.length === 0 ? (
        <EmptyState
          title={filtered ? 'No assessments match these filters' : 'No assessments yet'}
          description={
            filtered
              ? 'Try a different search or clear the filters.'
              : canCreate
                ? 'Create the first one, then add questions from the question bank.'
                : 'Ask a training administrator to create one.'
          }
          action={
            filtered ? (
              <Button
                onClick={() => {
                  setSearch('');
                  setState({ q: '', kind: '', status: DEFAULTS.status });
                }}
              >
                Clear filters
              </Button>
            ) : canCreate ? (
              <Button variant="primary" onClick={() => setCreating(true)}>
                New assessment
              </Button>
            ) : undefined
          }
        />
      ) : (
        <>
          <Table caption="Assessments">
            <THead>
              <tr>
                <SortTh field="title" sort={state.sort} onSort={(sort) => setState({ sort })}>
                  Title
                </SortTh>
                <SortTh
                  field="kind"
                  sort={state.sort}
                  onSort={(sort) => setState({ sort })}
                  className="hidden sm:table-cell"
                >
                  Type
                </SortTh>
                <SortTh field="status" sort={state.sort} onSort={(sort) => setState({ sort })}>
                  Status
                </SortTh>
                <Th className="hidden text-right md:table-cell">Pass mark</Th>
                <Th className="hidden text-right md:table-cell">Questions</Th>
                <Th className="hidden text-right lg:table-cell">Attempts</Th>
                <SortTh
                  field="updatedAt"
                  sort={state.sort}
                  onSort={(sort) => setState({ sort })}
                  className="hidden lg:table-cell"
                >
                  Updated
                </SortTh>
              </tr>
            </THead>
            <TBody>
              {list.data.items.map((a) => {
                const status = ASSESSMENT_STATUS[a.status];
                return (
                  <Tr key={a.id} onClick={() => navigate(`/content/assessments/${a.id}`)}>
                    <Td>
                      <Link
                        to={`/content/assessments/${a.id}`}
                        className="block min-w-0"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <span className="block truncate font-medium">{a.title}</span>
                        {a.description && (
                          <span className="block max-w-[52ch] truncate text-sm text-text-tertiary">
                            {a.description}
                          </span>
                        )}
                      </Link>
                    </Td>
                    <Td className="hidden text-text-secondary sm:table-cell">
                      {KIND_LABELS[a.kind]}
                    </Td>
                    <Td>
                      <StatusText tone={status.tone}>{status.label}</StatusText>
                    </Td>
                    <Td className="tabular hidden text-right md:table-cell">{a.passingPercent}%</Td>
                    <Td className="tabular hidden text-right md:table-cell">{a.questionCount}</Td>
                    <Td className="tabular hidden text-right lg:table-cell">{a.attemptCount}</Td>
                    <Td className="hidden text-sm text-text-secondary lg:table-cell">
                      {formatRelative(a.updatedAt)}
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
            noun="assessments"
          />
        </>
      )}
      <NewAssessmentDialog open={creating} onOpenChange={setCreating} />
    </>
  );
}

export function AssessmentsListPage() {
  const can = usePermissions();
  // Managers can follow attempts without being able to build assessments.
  if (!can.has('assessments.view') && can.has('assessment_attempts.view')) {
    return <Navigate to="/content/assessments/attempts" replace />;
  }
  return (
    <RequirePermission all={['assessments.view']}>
      <AssessmentsList />
    </RequirePermission>
  );
}
