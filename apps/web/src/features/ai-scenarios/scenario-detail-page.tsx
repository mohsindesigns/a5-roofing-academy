import { useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { Copy, MoreHorizontal, Play, Archive } from 'lucide-react';
import type { ai } from '@a5/contracts';
import {
  Button,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  IconButton,
  MenuContent,
  MenuItem,
  MenuRoot,
  MenuTrigger,
  Notice,
  PageHeader,
  Skeleton,
  Tag,
  TabsContent,
  TabsList,
  TabsRoot,
  toast,
} from '@/components/ui';
import { RequirePermission } from '@/app/guards';
import { useStartSession } from '@/features/ai-coach/api';
import { Difficulty } from '@/features/ai-coach/ui';
import { useCan } from '@/features/auth/session';
import { useSearchState } from '@/hooks/use-search-state';
import { ApiError, errorMessage } from '@/lib/api/errors';
import { formatDateTime } from '@/lib/format';
import { useArchiveScenario, useDuplicateScenario, usePublishScenario, useScenario } from './api';
import { ScenarioForm } from './scenario-form';
import { scenarioStatus } from './scenarios-page';
import { VersionsPanel } from './versions-panel';

const PROVIDER_LABEL: Record<string, string> = {
  anthropic: 'Anthropic Claude',
  openai: 'OpenAI',
  dev_simulator: 'the development simulator',
};

function TestRunPanel({ scenario }: { scenario: ai.ScenarioDetail }) {
  const navigate = useNavigate();
  const start = useStartSession();
  const archived = scenario.status === 'archived';
  return (
    <div className="grid max-w-[70ch] gap-5">
      <div className="grid gap-2 text-base">
        <p>
          Play the learner. You talk to the homeowner, end the conversation and get a scorecard from
          the same conversation and scoring pipeline learners use.
        </p>
        <p className="text-text-secondary">
          Test runs work on drafts. They are marked as tests and left out of learner history,
          analytics and lesson progress.
        </p>
      </div>
      <Notice tone="information" title="Which AI answers">
        This scenario uses{' '}
        {scenario.provider
          ? (PROVIDER_LABEL[scenario.provider] ?? scenario.provider)
          : 'the organization default provider'}
        . Until a real provider is configured on the server, the development simulator answers with
        scripted replies and scores.
      </Notice>
      {start.isError && (
        <Notice tone="danger" title="Could not start the test run">
          {errorMessage(start.error)}
        </Notice>
      )}
      <div>
        <Button
          variant="primary"
          size="lg"
          disabled={archived}
          loading={start.isPending}
          leading={<Play className="size-4" />}
          onClick={() =>
            start.mutate(
              { scenarioId: scenario.id, test: true },
              { onSuccess: (session) => navigate(`/ai-coach/sessions/${session.id}`) },
            )
          }
        >
          Start test run
        </Button>
        {archived && (
          <p className="mt-2 text-sm text-text-secondary">
            Archived scenarios cannot be run. Duplicate it to continue working on it.
          </p>
        )}
      </div>
    </div>
  );
}

function ScenarioDetail({ id }: { id: string }) {
  const navigate = useNavigate();
  const scenario = useScenario(id);
  const canUpdate = useCan('ai_scenarios.update');
  const canCreate = useCan('ai_scenarios.create');
  const [state, setState] = useSearchState({ tab: 'details' });
  const publish = usePublishScenario(id);
  const archive = useArchiveScenario(id);
  const duplicate = useDuplicateScenario(id);
  const [confirm, setConfirm] = useState<'publish' | 'archive' | null>(null);

  if (scenario.isPending) return <Skeleton className="h-96 w-full" />;
  if (scenario.isError) {
    const gone = scenario.error instanceof ApiError && scenario.error.isNotFound;
    return gone ? (
      <EmptyState title="This scenario no longer exists" className="mt-10" />
    ) : (
      <ErrorState message={errorMessage(scenario.error)} onRetry={() => scenario.refetch()} />
    );
  }
  const s = scenario.data;
  const status = scenarioStatus(s.status);
  const archived = s.status === 'archived';
  const tab = state.tab === 'versions' || state.tab === 'test' ? state.tab : 'details';

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: 'AI scenarios', to: '/content/ai-scenarios' }, { label: s.title }]}
        title={s.title}
        description={`“${s.objection}”`}
        meta={
          <>
            <Tag
              tone={
                status.tone === 'success'
                  ? 'success'
                  : status.tone === 'warning'
                    ? 'warning'
                    : 'neutral'
              }
            >
              {status.label}
            </Tag>
            <Difficulty level={s.difficulty} />
            <span>{s.category}</span>
            <span>With {s.persona.name}</span>
            {s.currentPromptVersion && (
              <span className="tabular">Version {s.currentPromptVersion.version}</span>
            )}
            <span className="tabular">{s.sessionCount.toLocaleString()} sessions</span>
            <span>Updated {formatDateTime(s.updatedAt)}</span>
          </>
        }
        actions={
          <>
            {canUpdate && s.status === 'draft' && (
              <Button variant="primary" onClick={() => setConfirm('publish')}>
                Publish
              </Button>
            )}
            {(canUpdate || canCreate) && (
              <MenuRoot>
                <MenuTrigger asChild>
                  <IconButton label="More actions" variant="secondary">
                    <MoreHorizontal className="size-4" />
                  </IconButton>
                </MenuTrigger>
                <MenuContent>
                  {canCreate && (
                    <MenuItem
                      icon={<Copy />}
                      onSelect={() =>
                        duplicate.mutate(undefined, {
                          onSuccess: (copy) => {
                            toast.success('Scenario duplicated', 'The copy is a draft.');
                            navigate(`/content/ai-scenarios/${copy.id}`);
                          },
                          onError: (err) => toast.error('Could not duplicate', errorMessage(err)),
                        })
                      }
                    >
                      Duplicate
                    </MenuItem>
                  )}
                  {canUpdate && !archived && (
                    <MenuItem
                      icon={<Archive />}
                      tone="danger"
                      onSelect={() => setConfirm('archive')}
                    >
                      Archive
                    </MenuItem>
                  )}
                </MenuContent>
              </MenuRoot>
            )}
          </>
        }
      />

      {s.status === 'draft' && (
        <Notice tone="warning" className="mb-6" title="Draft">
          Learners cannot see this scenario yet. Run a test, then publish when it behaves as
          intended.
        </Notice>
      )}
      {archived && (
        <Notice tone="warning" className="mb-6" title="Archived">
          This scenario is hidden from learners and can no longer be edited. Duplicate it to
          continue.
        </Notice>
      )}

      <TabsRoot value={tab} onValueChange={(v) => setState({ tab: v })}>
        <TabsList
          className="mb-6"
          items={[
            { value: 'details', label: 'Details' },
            { value: 'versions', label: 'Prompt versions', count: s.currentPromptVersion?.version },
            ...(canUpdate ? [{ value: 'test', label: 'Test run' }] : []),
          ]}
        />
        <TabsContent value="details" className="max-w-[960px]">
          <ScenarioForm
            mode="edit"
            scenario={s}
            readOnly={!canUpdate || archived}
            onSaved={() => undefined}
          />
        </TabsContent>
        <TabsContent value="versions" className="max-w-[960px]">
          <VersionsPanel scenario={s} />
        </TabsContent>
        {canUpdate && (
          <TabsContent value="test">
            <TestRunPanel scenario={s} />
          </TabsContent>
        )}
      </TabsRoot>

      <ConfirmDialog
        open={confirm === 'publish'}
        onOpenChange={(open) => !open && setConfirm(null)}
        title="Publish this scenario?"
        description="Learners will see it in the AI Coach straight away, using the current prompt version."
        confirmLabel="Publish"
        loading={publish.isPending}
        error={publish.isError ? errorMessage(publish.error) : null}
        onConfirm={() =>
          publish.mutate(undefined, {
            onSuccess: () => {
              toast.success('Scenario published');
              setConfirm(null);
            },
          })
        }
      />
      <ConfirmDialog
        open={confirm === 'archive'}
        onOpenChange={(open) => !open && setConfirm(null)}
        title="Archive this scenario?"
        description="Learners will no longer find it. Past conversations and scorecards are kept. You cannot edit an archived scenario, but you can duplicate it."
        confirmLabel="Archive scenario"
        tone="danger"
        loading={archive.isPending}
        error={archive.isError ? errorMessage(archive.error) : null}
        onConfirm={() =>
          archive.mutate(undefined, {
            onSuccess: () => {
              toast.success('Scenario archived');
              setConfirm(null);
            },
          })
        }
      />
    </>
  );
}

export function ScenarioDetailPage() {
  const { id = '' } = useParams();
  return (
    <RequirePermission all={['ai_scenarios.view']}>
      <ScenarioDetail id={id} />
    </RequirePermission>
  );
}

export function ScenarioCreatePage() {
  const navigate = useNavigate();
  return (
    <RequirePermission all={['ai_scenarios.create']}>
      <PageHeader
        breadcrumbs={[
          { label: 'AI scenarios', to: '/content/ai-scenarios' },
          { label: 'New scenario' },
        ]}
        title="New scenario"
        description="Starts as a draft. Run a test before publishing it to learners."
      />
      <div className="max-w-[960px]">
        <ScenarioForm
          mode="create"
          onSaved={(created) => navigate(`/content/ai-scenarios/${created.id}`)}
          onCancel={() => navigate('/content/ai-scenarios')}
        />
      </div>
    </RequirePermission>
  );
}
