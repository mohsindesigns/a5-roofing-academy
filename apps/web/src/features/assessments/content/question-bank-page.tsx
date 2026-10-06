import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { FolderTree, Plus, Search } from 'lucide-react';
import { assessment } from '@a5/contracts';
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
  Table,
  TableSkeleton,
  TBody,
  Td,
  Tag,
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
import { useBank, useBanks, useQuestions } from '../api';
import { DIFFICULTY_LABELS, formatPoints } from '../labels';
import { ContentNav } from './content-nav';
import { TaxonomySheet } from './taxonomy-sheet';

const DEFAULTS = {
  q: '',
  bankId: '',
  type: '',
  categoryId: '',
  difficulty: '',
  status: 'active',
  sort: '-updatedAt',
  page: '1',
};

function QuestionBank() {
  const navigate = useNavigate();
  const canCreate = useCan('assessments.create');
  const [state, setState] = useSearchState(DEFAULTS);
  const [search, setSearch] = useState(state.q ?? '');
  const [managing, setManaging] = useState(false);
  const q = useDebouncedValue(search, 300);
  useEffect(() => {
    if (q !== (state.q ?? '')) setState({ q });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  const banks = useBanks();
  const bank = useBank(state.bankId || undefined);
  const list = useQuestions({
    q: state.q || undefined,
    bankId: state.bankId || undefined,
    type: state.type || undefined,
    categoryId: state.categoryId || undefined,
    difficulty: state.difficulty || undefined,
    status: state.status,
    sort: state.sort,
    page: Number(state.page),
    pageSize: 25,
  });
  const filtered = Boolean(
    state.q ||
    state.bankId ||
    state.type ||
    state.categoryId ||
    state.difficulty ||
    state.status !== DEFAULTS.status,
  );
  const noBanks = banks.isSuccess && banks.data.items.length === 0;
  const defaultBank = state.bankId || banks.data?.items.find((b) => !b.archived)?.id || '';

  return (
    <>
      <PageHeader
        title="Question bank"
        description="Every question lives here once and can be used by many assessments. Editing a question saves a new version; attempts already taken keep the version they were given."
        actions={
          <>
            <Button leading={<FolderTree className="size-4" />} onClick={() => setManaging(true)}>
              Banks and categories
            </Button>
            {canCreate && !noBanks && (
              <Button asChild variant="primary" leading={<Plus className="size-4" />}>
                <Link to={`/content/questions/new${defaultBank ? `?bankId=${defaultBank}` : ''}`}>
                  New question
                </Link>
              </Button>
            )}
          </>
        }
      />
      <ContentNav />
      <FilterBar
        activeCount={
          [
            state.bankId,
            state.type,
            state.categoryId,
            state.difficulty,
            state.status !== DEFAULTS.status ? 'status' : '',
          ].filter(Boolean).length
        }
        search={
          <Input
            type="search"
            aria-label="Search questions"
            placeholder="Search question text, answers or tags"
            leading={<Search className="size-4" />}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        }
      >
        <Select
          aria-label="Question bank"
          value={state.bankId}
          onChange={(e) => setState({ bankId: e.target.value, categoryId: '' })}
        >
          <option value="">All banks</option>
          {banks.data?.items.map((b) => (
            <option key={b.id} value={b.id}>
              {b.title}
            </option>
          ))}
        </Select>
        <Select
          aria-label="Category"
          title={state.bankId ? undefined : 'Pick a bank to filter by category'}
          value={state.categoryId}
          disabled={!state.bankId}
          onChange={(e) => setState({ categoryId: e.target.value })}
        >
          <option value="">All categories</option>
          {bank.data?.categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
        <Select
          aria-label="Question type"
          value={state.type}
          onChange={(e) => setState({ type: e.target.value })}
        >
          <option value="">All types</option>
          {assessment.QUESTION_TYPES.map((t) => (
            <option key={t} value={t}>
              {assessment.QUESTION_TYPE_LABELS[t]}
            </option>
          ))}
        </Select>
        <Select
          aria-label="Difficulty"
          value={state.difficulty}
          onChange={(e) => setState({ difficulty: e.target.value })}
        >
          <option value="">Any difficulty</option>
          {assessment.DIFFICULTIES.map((d) => (
            <option key={d} value={d}>
              {DIFFICULTY_LABELS[d]}
            </option>
          ))}
        </Select>
        <Select
          aria-label="Status"
          value={state.status}
          onChange={(e) => setState({ status: e.target.value })}
        >
          <option value="active">Active</option>
          <option value="archived">Archived</option>
          <option value="all">Active and archived</option>
        </Select>
      </FilterBar>

      {list.isPending ? (
        <TableSkeleton columns={6} />
      ) : list.isError ? (
        <ErrorState message={errorMessage(list.error)} onRetry={() => list.refetch()} />
      ) : list.data.items.length === 0 ? (
        <EmptyState
          title={
            filtered
              ? 'No questions match these filters'
              : noBanks
                ? 'Create a question bank first'
                : 'No questions yet'
          }
          description={
            filtered
              ? 'Try a different search or clear the filters.'
              : noBanks
                ? 'Questions belong to a bank. Create one, then add questions to it.'
                : canCreate
                  ? 'Add the first question to start building assessments.'
                  : 'Ask a training administrator to add questions.'
          }
          action={
            filtered ? (
              <Button
                onClick={() => {
                  setSearch('');
                  setState({
                    q: '',
                    bankId: '',
                    type: '',
                    categoryId: '',
                    difficulty: '',
                    status: DEFAULTS.status,
                  });
                }}
              >
                Clear filters
              </Button>
            ) : noBanks ? (
              <Button variant="primary" onClick={() => setManaging(true)}>
                Create a question bank
              </Button>
            ) : canCreate ? (
              <Button asChild variant="primary">
                <Link to={`/content/questions/new${defaultBank ? `?bankId=${defaultBank}` : ''}`}>
                  New question
                </Link>
              </Button>
            ) : undefined
          }
        />
      ) : (
        <>
          <Table caption="Questions">
            <THead>
              <tr>
                <SortTh field="prompt" sort={state.sort} onSort={(sort) => setState({ sort })}>
                  Question
                </SortTh>
                <SortTh
                  field="type"
                  sort={state.sort}
                  onSort={(sort) => setState({ sort })}
                  className="hidden md:table-cell"
                >
                  Type
                </SortTh>
                <Th className="hidden lg:table-cell">Category</Th>
                <SortTh
                  field="difficulty"
                  sort={state.sort}
                  onSort={(sort) => setState({ sort })}
                  className="hidden sm:table-cell"
                >
                  Difficulty
                </SortTh>
                <Th className="hidden text-right lg:table-cell">Points</Th>
                <Th className="hidden text-right xl:table-cell">Used in</Th>
                <SortTh
                  field="updatedAt"
                  sort={state.sort}
                  onSort={(sort) => setState({ sort })}
                  className="hidden xl:table-cell"
                >
                  Updated
                </SortTh>
              </tr>
            </THead>
            <TBody>
              {list.data.items.map((row) => (
                <Tr key={row.id} onClick={() => navigate(`/content/questions/${row.id}`)}>
                  <Td>
                    <Link
                      to={`/content/questions/${row.id}`}
                      className="block min-w-0"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <span className="line-clamp-2 max-w-[60ch] font-medium">{row.prompt}</span>
                      <span className="mt-0.5 flex flex-wrap items-center gap-x-2 text-sm text-text-tertiary">
                        <span>v{row.version}</span>
                        {row.manualReview && <span>Reviewed by a trainer</span>}
                        {row.status === 'archived' && <Tag tone="warning">Archived</Tag>}
                        <span className="md:hidden">
                          {assessment.QUESTION_TYPE_LABELS[row.type]}
                        </span>
                      </span>
                    </Link>
                  </Td>
                  <Td className="hidden text-text-secondary md:table-cell">
                    {assessment.QUESTION_TYPE_LABELS[row.type]}
                  </Td>
                  <Td className="hidden whitespace-nowrap text-text-secondary lg:table-cell">
                    {row.category?.name ?? '—'}
                  </Td>
                  <Td className="hidden text-text-secondary sm:table-cell">
                    {DIFFICULTY_LABELS[row.difficulty]}
                  </Td>
                  <Td className="tabular hidden text-right lg:table-cell">
                    {formatPoints(row.points)}
                  </Td>
                  <Td className="tabular hidden text-right xl:table-cell">
                    {row.usedInAssessments === 0 ? (
                      <span className="text-text-tertiary">Not used</span>
                    ) : (
                      row.usedInAssessments
                    )}
                  </Td>
                  <Td className="hidden text-sm text-text-secondary xl:table-cell">
                    {formatRelative(row.updatedAt)}
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
            noun="questions"
          />
        </>
      )}
      <TaxonomySheet
        open={managing}
        onOpenChange={setManaging}
        initialBankId={state.bankId || undefined}
      />
    </>
  );
}

export function QuestionBankPage() {
  return (
    <RequirePermission all={['assessments.view']}>
      <QuestionBank />
    </RequirePermission>
  );
}
