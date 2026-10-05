import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { Plus, Search } from 'lucide-react';
import type { ai } from '@a5/contracts';
import {
  Button,
  ConfirmDialog,
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
  StatusText,
  Table,
  TableSkeleton,
  TabsContent,
  TabsList,
  TabsRoot,
  TBody,
  Td,
  Textarea,
  Th,
  THead,
  Tr,
  toast,
} from '@/components/ui';
import { RequirePermission } from '@/app/guards';
import { useCan } from '@/features/auth/session';
import { DIFFICULTY_LABEL, Difficulty } from '@/features/ai-coach/ui';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import { useSearchState } from '@/hooks/use-search-state';
import { ApiError, errorMessage } from '@/lib/api/errors';
import { formatRelative, pluralize } from '@/lib/format';
import {
  useArchivePersona,
  useCreateRubric,
  usePersonas,
  useRubrics,
  useScenarios,
  type ScenarioSummary,
} from './api';
import { PersonaDialog } from './persona-dialog';

const DEFAULTS = { tab: 'scenarios', q: '', status: '', difficulty: '', page: '1' };

export function scenarioStatus(status: ai.ScenarioStatus) {
  return status === 'published'
    ? { label: 'Published', tone: 'success' as const }
    : status === 'draft'
      ? { label: 'Draft', tone: 'warning' as const }
      : { label: 'Archived', tone: 'neutral' as const };
}

// ------------------------------------------------------------------ scenarios

function ScenariosTab() {
  const navigate = useNavigate();
  const [state, setState] = useSearchState(DEFAULTS);
  const [search, setSearch] = useState(state.q ?? '');
  const q = useDebouncedValue(search, 300);
  useEffect(() => {
    if (q !== (state.q ?? '')) setState({ q });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);
  const scenarios = useScenarios({
    q: state.q || undefined,
    status: state.status || undefined,
    difficulty: state.difficulty || undefined,
    page: Number(state.page) || 1,
  });
  const filtered = Boolean(state.q || state.status || state.difficulty);
  const canCreate = useCan('ai_scenarios.create');

  return (
    <>
      <FilterBar
        activeCount={[state.status, state.difficulty].filter(Boolean).length}
        search={
          <Input
            type="search"
            aria-label="Search scenarios"
            placeholder="Search title, objection or category"
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
          <option value="">Draft and published</option>
          <option value="published">Published</option>
          <option value="draft">Draft</option>
          <option value="archived">Archived</option>
        </Select>
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
      </FilterBar>

      {scenarios.isPending ? (
        <TableSkeleton columns={6} />
      ) : scenarios.isError ? (
        <ErrorState message={errorMessage(scenarios.error)} onRetry={() => scenarios.refetch()} />
      ) : scenarios.data.items.length === 0 ? (
        <EmptyState
          title={filtered ? 'No scenarios match these filters' : 'No scenarios yet'}
          description={
            filtered
              ? 'Try a different search or clear the filters.'
              : 'Create the first objection scenario for learners to practice.'
          }
          action={
            canCreate && !filtered ? (
              <Button asChild variant="primary">
                <Link to="/content/ai-scenarios/new">New scenario</Link>
              </Button>
            ) : undefined
          }
        />
      ) : (
        <>
          <Table caption="AI scenarios">
            <THead>
              <tr>
                <Th>Scenario</Th>
                <Th>Difficulty</Th>
                <Th>Status</Th>
                <Th>Persona</Th>
                <Th className="text-right">Pass mark</Th>
                <Th className="text-right">Version</Th>
                <Th className="text-right">Sessions</Th>
                <Th>Updated</Th>
              </tr>
            </THead>
            <TBody>
              {scenarios.data.items.map((s: ScenarioSummary) => {
                const status = scenarioStatus(s.status);
                return (
                  <Tr key={s.id} onClick={() => navigate(`/content/ai-scenarios/${s.id}`)}>
                    <Td className="min-w-64">
                      <Link
                        to={`/content/ai-scenarios/${s.id}`}
                        className="font-medium hover:underline"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {s.title}
                      </Link>
                      <span className="block text-xs text-text-secondary">{s.category}</span>
                    </Td>
                    <Td>
                      <Difficulty level={s.difficulty} />
                    </Td>
                    <Td>
                      <StatusText tone={status.tone}>{status.label}</StatusText>
                    </Td>
                    <Td className="text-text-secondary">{s.persona.name}</Td>
                    <Td className="tabular text-right">{s.passingScore}</Td>
                    <Td className="tabular text-right">
                      {s.currentPromptVersion ? `v${s.currentPromptVersion.version}` : '—'}
                    </Td>
                    <Td className="tabular text-right">{s.sessionCount.toLocaleString()}</Td>
                    <Td className="whitespace-nowrap text-text-secondary">
                      {formatRelative(s.updatedAt)}
                    </Td>
                  </Tr>
                );
              })}
            </TBody>
          </Table>
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
    </>
  );
}

// ------------------------------------------------------------------ personas

function PersonasTab() {
  const personas = usePersonas(true);
  const canCreate = useCan('ai_scenarios.create');
  const canUpdate = useCan('ai_scenarios.update');
  const [editing, setEditing] = useState<ai.Persona | 'new' | null>(null);
  const [archiving, setArchiving] = useState<ai.Persona | null>(null);
  const archive = useArchivePersona(archiving?.id ?? '');

  return (
    <>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-[60ch] text-sm text-text-secondary">
          Homeowner characters. Editing one creates a new prompt version for every live scenario
          that uses it.
        </p>
        {canCreate && (
          <Button leading={<Plus className="size-4" />} onClick={() => setEditing('new')}>
            New persona
          </Button>
        )}
      </div>
      {personas.isPending ? (
        <TableSkeleton columns={4} rows={4} />
      ) : personas.isError ? (
        <ErrorState message={errorMessage(personas.error)} onRetry={() => personas.refetch()} />
      ) : personas.data.items.length === 0 ? (
        <EmptyState
          title="No personas yet"
          description="Scenarios need a homeowner persona. Create one to get started."
        />
      ) : (
        <Table caption="Personas">
          <THead>
            <tr>
              <Th>Persona</Th>
              <Th>Temperament</Th>
              <Th className="text-right">Scenarios</Th>
              <Th>Updated</Th>
              <Th>
                <span className="sr-only">Actions</span>
              </Th>
            </tr>
          </THead>
          <TBody>
            {personas.data.items.map((p) => (
              <Tr key={p.id}>
                <Td className="min-w-56">
                  <span className="font-medium">{p.name}</span>
                  {p.archived && <span className="ml-2 text-xs text-text-secondary">Archived</span>}
                  <span className="line-clamp-2 max-w-[60ch] text-xs text-text-secondary">
                    {p.description}
                  </span>
                </Td>
                <Td className="max-w-72 text-text-secondary">{p.temperament}</Td>
                <Td className="tabular text-right">{p.scenarioCount}</Td>
                <Td className="whitespace-nowrap text-text-secondary">
                  {formatRelative(p.updatedAt)}
                </Td>
                <Td className="text-right whitespace-nowrap">
                  {canUpdate && !p.archived && (
                    <span className="inline-flex gap-1">
                      <Button size="sm" variant="ghost" onClick={() => setEditing(p)}>
                        Edit <span className="sr-only">{p.name}</span>
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setArchiving(p)}>
                        Archive <span className="sr-only">{p.name}</span>
                      </Button>
                    </span>
                  )}
                </Td>
              </Tr>
            ))}
          </TBody>
        </Table>
      )}
      {editing && (
        <PersonaDialog
          key={editing === 'new' ? 'new' : editing.id}
          persona={editing === 'new' ? undefined : editing}
          onClose={() => setEditing(null)}
        />
      )}
      <ConfirmDialog
        open={archiving !== null}
        onOpenChange={(open) => !open && setArchiving(null)}
        title={`Archive ${archiving?.name ?? 'persona'}?`}
        description="Scenarios that already use this persona keep working. It will no longer be offered for new scenarios."
        confirmLabel="Archive persona"
        tone="danger"
        loading={archive.isPending}
        error={archive.isError ? errorMessage(archive.error) : null}
        onConfirm={() =>
          archive.mutate(undefined, {
            onSuccess: () => {
              toast.success('Persona archived');
              setArchiving(null);
            },
          })
        }
      />
    </>
  );
}

// ------------------------------------------------------------------ rubrics

function NewRubricDialog({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const create = useCreateRubric();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string | undefined>();
  return (
    <DialogRoot open onOpenChange={(open) => !open && !create.isPending && onClose()}>
      <DialogContent
        title="New rubric"
        description="Starts with the fourteen A5 objection-handling criteria. Adjust weights and wording on the next screen."
        dismissible={!create.isPending}
        footer={
          <>
            <Button onClick={onClose} disabled={create.isPending}>
              Cancel
            </Button>
            <Button type="submit" form="rubric-form" variant="primary" loading={create.isPending}>
              Create rubric
            </Button>
          </>
        }
      >
        <form
          id="rubric-form"
          className="grid gap-4"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            setError(undefined);
            if (!title.trim()) return setError('Required');
            create.mutate(
              { title: title.trim(), description: description.trim() || null, passingScore: 75 },
              {
                onSuccess: (rubric) => {
                  toast.success('Rubric created');
                  navigate(`/content/ai-scenarios/rubrics/${rubric.id}`);
                },
                onError: (err) =>
                  setError(
                    err instanceof ApiError
                      ? (err.fields.find((f) => f.path === 'title')?.message ?? err.message)
                      : errorMessage(err),
                  ),
              },
            );
          }}
        >
          <Field label="Title" required error={error}>
            <Input autoComplete="off" value={title} onChange={(e) => setTitle(e.target.value)} />
          </Field>
          <Field label="Description" optional>
            <Textarea
              rows={3}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </Field>
        </form>
      </DialogContent>
    </DialogRoot>
  );
}

function RubricsTab() {
  const navigate = useNavigate();
  const rubrics = useRubrics();
  const canCreate = useCan('ai_scenarios.create');
  const [creating, setCreating] = useState(false);
  return (
    <>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-[60ch] text-sm text-text-secondary">
          Scoring criteria with weights. Publishing a new version creates a new prompt version for
          every live scenario that uses the rubric.
        </p>
        {canCreate && (
          <Button leading={<Plus className="size-4" />} onClick={() => setCreating(true)}>
            New rubric
          </Button>
        )}
      </div>
      {rubrics.isPending ? (
        <TableSkeleton columns={5} rows={3} />
      ) : rubrics.isError ? (
        <ErrorState message={errorMessage(rubrics.error)} onRetry={() => rubrics.refetch()} />
      ) : rubrics.data.items.length === 0 ? (
        <EmptyState title="No rubrics yet" description="Scenarios are scored against a rubric." />
      ) : (
        <Table caption="Rubrics">
          <THead>
            <tr>
              <Th>Rubric</Th>
              <Th className="text-right">Version</Th>
              <Th className="text-right">Criteria</Th>
              <Th className="text-right">Default pass mark</Th>
              <Th className="text-right">Scenarios</Th>
              <Th>Updated</Th>
            </tr>
          </THead>
          <TBody>
            {rubrics.data.items.map((r) => (
              <Tr key={r.id} onClick={() => navigate(`/content/ai-scenarios/rubrics/${r.id}`)}>
                <Td className="min-w-56">
                  <Link
                    to={`/content/ai-scenarios/rubrics/${r.id}`}
                    className="font-medium hover:underline"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {r.title}
                  </Link>
                  {r.description && (
                    <span className="line-clamp-1 text-xs text-text-secondary">
                      {r.description}
                    </span>
                  )}
                </Td>
                <Td className="tabular text-right">v{r.currentVersion.version}</Td>
                <Td className="tabular text-right">{r.currentVersion.categoryCount}</Td>
                <Td className="tabular text-right">{r.currentVersion.passingScore}</Td>
                <Td className="tabular text-right">{pluralize(r.scenarioCount, 'scenario')}</Td>
                <Td className="whitespace-nowrap text-text-secondary">
                  {formatRelative(r.updatedAt)}
                </Td>
              </Tr>
            ))}
          </TBody>
        </Table>
      )}
      {creating && <NewRubricDialog onClose={() => setCreating(false)} />}
    </>
  );
}

// ------------------------------------------------------------------ page

function ScenariosHome() {
  const [state, setState] = useSearchState(DEFAULTS);
  const tab = state.tab === 'personas' || state.tab === 'rubrics' ? state.tab : 'scenarios';
  const canCreate = useCan('ai_scenarios.create');
  return (
    <>
      <PageHeader
        title="AI scenarios"
        description="Objection scenarios, homeowner personas and scoring rubrics for the AI Coach."
        actions={
          canCreate && (
            <Button asChild variant="primary" leading={<Plus className="size-4" />}>
              <Link to="/content/ai-scenarios/new">New scenario</Link>
            </Button>
          )
        }
      />
      <TabsRoot value={tab} onValueChange={(v) => setState({ tab: v })}>
        <TabsList
          className="mb-5"
          items={[
            { value: 'scenarios', label: 'Scenarios' },
            { value: 'personas', label: 'Personas' },
            { value: 'rubrics', label: 'Rubrics' },
          ]}
        />
        <TabsContent value="scenarios">
          <ScenariosTab />
        </TabsContent>
        <TabsContent value="personas">
          <PersonasTab />
        </TabsContent>
        <TabsContent value="rubrics">
          <RubricsTab />
        </TabsContent>
      </TabsRoot>
    </>
  );
}

export function AiScenariosPage() {
  return (
    <RequirePermission all={['ai_scenarios.view']}>
      <ScenariosHome />
    </RequirePermission>
  );
}
