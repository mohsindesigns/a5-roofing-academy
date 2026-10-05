import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { Search } from 'lucide-react';
import type { ai } from '@a5/contracts';
import {
  Button,
  DialogContent,
  DialogRoot,
  EmptyState,
  ErrorState,
  FilterBar,
  Input,
  Notice,
  PageHeader,
  Pagination,
  Select,
  Skeleton,
  StatusText,
  Table,
  TableSkeleton,
  TabsContent,
  TabsList,
  TabsRoot,
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
import { formatDateTime, formatRelative, pluralize } from '@/lib/format';
import {
  useActiveSessions,
  useMySessions,
  usePracticeBrief,
  usePracticeScenarios,
  useScenarioCategories,
  useStartSession,
} from './api';
import { DIFFICULTY_LABEL, Difficulty, SessionStatus } from './ui';

const DEFAULTS = { tab: 'scenarios', q: '', difficulty: '', category: '', page: '1', scenario: '' };
const PAGE_SIZE = 12;

function BestScore({
  stats,
  passMark,
}: {
  stats: ai.PracticeScenario['myStats'];
  passMark: number;
}) {
  if (stats.attempts === 0)
    return <span className="text-sm text-text-secondary">Not tried yet</span>;
  if (stats.bestScore === null)
    return (
      <span className="text-sm text-text-secondary">
        {pluralize(stats.attempts, 'attempt')}, none scored yet
      </span>
    );
  return (
    <span className="grid justify-items-start gap-0.5 sm:justify-items-end">
      <span className="tabular text-sm">
        Best <strong className="text-base font-semibold">{stats.bestScore}</strong>
        <span className="text-text-secondary"> / pass {passMark}</span>
      </span>
      <StatusText tone={stats.passed ? 'success' : 'warning'}>
        {stats.passed ? 'Passed' : 'Not passed yet'}
      </StatusText>
    </span>
  );
}

function ScenarioRow({ s, onOpen }: { s: ai.PracticeScenario; onOpen: () => void }) {
  return (
    <li className="grid gap-3 px-4 py-4 sm:grid-cols-[1fr_auto] sm:items-center sm:gap-6 sm:px-5">
      <div className="min-w-0">
        <h3 className="text-md font-semibold">
          <button
            type="button"
            onClick={onOpen}
            className="rounded text-left hover:underline focus-visible:underline"
          >
            {s.title}
          </button>
        </h3>
        <p className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-sm text-text-secondary">
          <Difficulty level={s.difficulty} />
          <span>{s.category}</span>
          <span>With {s.persona.name}</span>
          <span className="tabular">Up to {pluralize(s.maxTurns, 'turn')}</span>
        </p>
        <p className="mt-1.5 line-clamp-2 max-w-[70ch] text-base text-text-primary">
          &ldquo;{s.objection}&rdquo;
        </p>
        {s.myStats.lastPracticedAt && (
          <p className="mt-1 text-xs text-text-secondary">
            Last practiced {formatRelative(s.myStats.lastPracticedAt)}
          </p>
        )}
      </div>
      <div className="flex items-center justify-between gap-4 sm:flex-col sm:items-end sm:justify-center">
        <BestScore stats={s.myStats} passMark={s.passingScore} />
        <Button variant={s.myStats.attempts === 0 ? 'primary' : 'secondary'} onClick={onOpen}>
          {s.myStats.attempts === 0 ? 'Start' : 'Practice again'}
        </Button>
      </div>
    </li>
  );
}

function BriefDialog({ scenarioId, onClose }: { scenarioId: string; onClose: () => void }) {
  const navigate = useNavigate();
  const brief = usePracticeBrief(scenarioId);
  const start = useStartSession();
  const b = brief.data;
  return (
    <DialogRoot open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        size="md"
        title={b?.title ?? 'Scenario'}
        description={b ? `${DIFFICULTY_LABEL[b.difficulty]} · ${b.category}` : undefined}
        dismissible={!start.isPending}
        footer={
          <>
            <Button onClick={onClose} disabled={start.isPending}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={!b}
              loading={start.isPending}
              onClick={() =>
                start.mutate(
                  { scenarioId },
                  { onSuccess: (session) => navigate(`/ai-coach/sessions/${session.id}`) },
                )
              }
            >
              Start conversation
            </Button>
          </>
        }
      >
        {brief.isPending ? (
          <div className="grid gap-2" aria-busy="true" aria-label="Loading scenario">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-5/6" />
            <Skeleton className="h-4 w-2/3" />
          </div>
        ) : brief.isError || !b ? (
          <ErrorState
            title="This scenario could not be loaded"
            message={errorMessage(brief.error)}
            onRetry={() => brief.refetch()}
          />
        ) : (
          <div className="grid gap-4">
            <div>
              <h3 className="text-sm font-semibold">The situation</h3>
              <p className="mt-1 text-base whitespace-pre-wrap">{b.repBrief}</p>
            </div>
            <div>
              <h3 className="text-sm font-semibold">Who you will meet</h3>
              <p className="mt-1 text-base text-text-secondary">
                <span className="font-medium text-text-primary">{b.persona.name}. </span>
                {b.persona.description}
              </p>
            </div>
            <div>
              <h3 className="text-sm font-semibold">How it works</h3>
              <p className="mt-1 text-sm text-text-secondary">
                You have up to {pluralize(b.maxTurns, 'turn')}. The conversation ends when you end
                it, when the homeowner does, or when the turns run out. You pass with a score of{' '}
                {b.passingScore} or more.
              </p>
            </div>
            {b.scoredOn.length > 0 && (
              <div>
                <h3 className="text-sm font-semibold">You are scored on</h3>
                <p className="mt-1 text-sm text-text-secondary">
                  {b.scoredOn.map((c) => c.label).join(', ')}.
                </p>
              </div>
            )}
            {start.isError && (
              <Notice tone="danger" title="Could not start the conversation">
                {errorMessage(start.error)}
              </Notice>
            )}
          </div>
        )}
      </DialogContent>
    </DialogRoot>
  );
}

function ResumeBanner() {
  const active = useActiveSessions();
  const items = active.data?.items ?? [];
  if (items.length === 0) return null;
  return (
    <div className="mb-6 grid gap-2">
      {items.map((s) => (
        <Notice
          key={s.id}
          tone="information"
          title={`Conversation in progress: ${s.scenario.title}`}
          action={
            <Button asChild size="sm">
              <Link to={`/ai-coach/sessions/${s.id}`}>Continue</Link>
            </Button>
          }
        >
          Started {formatRelative(s.startedAt)}, {pluralize(s.turnCount, 'turn')} so far.
        </Notice>
      ))}
    </div>
  );
}

function ScenarioList() {
  const [state, setState] = useSearchState(DEFAULTS);
  const [search, setSearch] = useState(state.q ?? '');
  const q = useDebouncedValue(search, 300);
  useEffect(() => {
    if (q !== (state.q ?? '')) setState({ q });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);
  const page = Number(state.page) || 1;
  const scenarios = usePracticeScenarios({
    q: state.q || undefined,
    difficulty: state.difficulty || undefined,
    category: state.category || undefined,
    page,
    pageSize: PAGE_SIZE,
  });
  const categories = useScenarioCategories();
  const filtered = Boolean(state.q || state.difficulty || state.category);
  const open = (id: string) => setState({ scenario: id, page: state.page });
  const close = () => setState({ scenario: '', page: state.page });

  return (
    <>
      <FilterBar
        activeCount={[state.difficulty, state.category].filter(Boolean).length}
        search={
          <Input
            type="search"
            aria-label="Search scenarios"
            placeholder="Search by title, objection or category"
            leading={<Search className="size-4" />}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        }
      >
        <Select
          aria-label="Difficulty"
          value={state.difficulty}
          onChange={(e) => setState({ difficulty: e.target.value })}
        >
          <option value="">All difficulties</option>
          {Object.entries(DIFFICULTY_LABEL).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </Select>
        <Select
          aria-label="Category"
          value={state.category}
          onChange={(e) => setState({ category: e.target.value })}
        >
          <option value="">All categories</option>
          {categories.data?.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </Select>
      </FilterBar>

      {scenarios.isPending ? (
        <Skeleton className="h-72 w-full" />
      ) : scenarios.isError ? (
        <ErrorState message={errorMessage(scenarios.error)} onRetry={() => scenarios.refetch()} />
      ) : scenarios.data.items.length === 0 ? (
        <EmptyState
          title={filtered ? 'No scenarios match these filters' : 'No scenarios to practice yet'}
          description={
            filtered
              ? 'Try a different search or clear the filters.'
              : 'Your trainers publish scenarios here. Check back soon.'
          }
        />
      ) : (
        <>
          <ul
            aria-label="Practice scenarios"
            className="divide-y divide-divider overflow-hidden rounded-lg border border-border bg-surface"
          >
            {scenarios.data.items.map((s) => (
              <ScenarioRow key={s.id} s={s} onOpen={() => open(s.id)} />
            ))}
          </ul>
          <Pagination
            page={scenarios.data.page}
            pageCount={scenarios.data.pageCount}
            total={scenarios.data.total}
            pageSize={scenarios.data.pageSize}
            noun="scenarios"
            onPage={(p) => setState({ page: String(p) })}
          />
        </>
      )}
      {state.scenario && <BriefDialog scenarioId={state.scenario} onClose={close} />}
    </>
  );
}

function History() {
  const [state, setState] = useSearchState(DEFAULTS);
  const page = Number(state.page) || 1;
  const history = useMySessions(page);

  if (history.isPending) return <TableSkeleton columns={5} rows={5} />;
  if (history.isError)
    return <ErrorState message={errorMessage(history.error)} onRetry={() => history.refetch()} />;
  if (history.data.items.length === 0)
    return (
      <EmptyState
        title="No conversations yet"
        description="Your practice history, scores and scorecards will appear here."
        action={<Button onClick={() => setState({ tab: 'scenarios' })}>Choose a scenario</Button>}
      />
    );
  return (
    <>
      <Table caption="Your practice conversations, newest first">
        <THead>
          <tr>
            <Th>Scenario</Th>
            <Th>Started</Th>
            <Th>Result</Th>
            <Th className="text-right">Score</Th>
            <Th className="text-right">Turns</Th>
            <Th>
              <span className="sr-only">Open</span>
            </Th>
          </tr>
        </THead>
        <TBody>
          {history.data.items.map((s) => (
            <Tr key={s.id}>
              <Td>
                <span className="block font-medium">{s.scenario.title}</span>
                <span className="block text-xs text-text-secondary">
                  {s.scenario.category}
                  {s.mode === 'assigned' && ' · Lesson attempt'}
                </span>
              </Td>
              <Td className="whitespace-nowrap text-text-secondary">
                {formatDateTime(s.startedAt)}
              </Td>
              <Td>
                <SessionStatus status={s.status} passed={s.passed} />
              </Td>
              <Td className="tabular text-right">{s.overallScore ?? '—'}</Td>
              <Td className="tabular text-right">{s.turnCount}</Td>
              <Td className="text-right whitespace-nowrap">
                <Link
                  to={
                    s.status === 'active'
                      ? `/ai-coach/sessions/${s.id}`
                      : `/ai-coach/sessions/${s.id}/scorecard`
                  }
                  className="font-medium text-information hover:underline"
                >
                  {s.status === 'active' ? 'Continue' : 'View'}{' '}
                  <span className="sr-only">{s.scenario.title}</span>
                </Link>
              </Td>
            </Tr>
          ))}
        </TBody>
      </Table>
      <Pagination
        page={history.data.page}
        pageCount={history.data.pageCount}
        total={history.data.total}
        pageSize={history.data.pageSize}
        noun="conversations"
        onPage={(p) => setState({ page: String(p) })}
      />
    </>
  );
}

function CoachHome() {
  const [state, setState] = useSearchState(DEFAULTS);
  const tab = state.tab === 'history' ? 'history' : 'scenarios';
  return (
    <>
      <PageHeader
        title="AI Coach"
        description="Practice real objections with an AI homeowner, then see how you did against the A5 rubric."
      />
      <ResumeBanner />
      <TabsRoot value={tab} onValueChange={(v) => setState({ tab: v })}>
        <TabsList
          className="mb-5"
          items={[
            { value: 'scenarios', label: 'Scenarios' },
            { value: 'history', label: 'History' },
          ]}
        />
        <TabsContent value="scenarios">
          <ScenarioList />
        </TabsContent>
        <TabsContent value="history">
          <History />
        </TabsContent>
      </TabsRoot>
    </>
  );
}

export function CoachPage() {
  return (
    <RequirePermission all={['ai_practice.use']}>
      <CoachHome />
    </RequirePermission>
  );
}
