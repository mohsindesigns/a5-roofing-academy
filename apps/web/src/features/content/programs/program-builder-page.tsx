import { useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { Copy, MoreHorizontal, Rocket } from 'lucide-react';
import type { learning } from '@a5/contracts';
import {
  Button,
  ConfirmDialog,
  ErrorState,
  IconButton,
  MenuContent,
  MenuItem,
  MenuRoot,
  MenuTrigger,
  Notice,
  PageHeader,
  Skeleton,
  StatusText,
  TabsContent,
  TabsList,
  TabsRoot,
  Tag,
  toast,
} from '@/components/ui';
import { RequirePermission } from '@/app/guards';
import { useCan } from '@/features/auth/session';
import { useSearchState } from '@/hooks/use-search-state';
import { ApiError, errorMessage } from '@/lib/api/errors';
import { formatDateTime } from '@/lib/format';
import { useDuplicateProgram, useProgramAction, useProgramDetail } from './api';
import { EnrollmentPanel } from './enrollment-panel';
import { PublishDialog } from './publish-dialog';
import { SettingsPanel } from './settings-panel';
import { StructureTab } from './structure-tab';
import { VersionsPanel } from './versions-panel';

const TABS = [
  { value: 'structure', label: 'Structure' },
  { value: 'settings', label: 'Settings' },
  { value: 'enrollment', label: 'Audience and enrollment' },
  { value: 'versions', label: 'Versions' },
];

/** Move to the item an issue is about: open the lesson, or scroll to the phase or module. */
function issueTarget(issue: learning.PublishIssue): { lesson?: string; node?: string } {
  if (issue.nodeType === 'lesson') return { lesson: issue.nodeId };
  if (issue.nodeType === 'phase' || issue.nodeType === 'module')
    return { node: `${issue.nodeType}:${issue.nodeId}` };
  return {};
}

function Builder({ program }: { program: learning.ProgramDetail }) {
  const navigate = useNavigate();
  const [state, setState] = useSearchState({ tab: 'structure', lesson: '' });
  const canPublish = useCan('programs.publish');
  const canUpdate = useCan('programs.update');
  const canArchive = useCan('programs.archive');
  const canCopy = useCan('programs.create');
  const [publishOpen, setPublishOpen] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const archiveAction = useProgramAction(program.id);
  const duplicate = useDuplicateProgram();
  const tab = TABS.some((t) => t.value === state.tab) ? state.tab : 'structure';
  const archived = program.status === 'archived';
  const issues = program.publishIssues;

  const goTo = (issue: learning.PublishIssue) => {
    const target = issueTarget(issue);
    setState({ tab: 'structure', lesson: target.lesson ?? '' });
    if (target.node) {
      setTimeout(() => {
        const el = document.querySelector<HTMLElement>(`[data-node="${target.node}"]`);
        el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
        el?.querySelector<HTMLElement>('button')?.focus();
      }, 50);
    }
  };

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: 'Programs', to: '/content/programs' }, { label: program.title }]}
        title={program.title}
        description={program.summary ?? undefined}
        meta={
          <>
            <StatusText
              tone={archived ? 'neutral' : program.status === 'published' ? 'success' : 'neutral'}
            >
              {archived ? 'Archived' : program.status === 'published' ? 'Published' : 'Draft'}
            </StatusText>
            {program.publishedVersion > 0 && (
              <span>
                Version {program.publishedVersion}
                {program.publishedAt && `, ${formatDateTime(program.publishedAt)}`}
              </span>
            )}
            {program.hasUnpublishedChanges && !archived && (
              <Tag tone="warning">
                {program.status === 'draft' ? 'Not published yet' : 'Unpublished changes'}
              </Tag>
            )}
            {program.owner && <span>Owner: {program.owner.displayName}</span>}
          </>
        }
        actions={
          <>
            {canPublish && !archived && (
              <Button
                variant="primary"
                leading={<Rocket className="size-4" />}
                disabled={!program.hasUnpublishedChanges || issues.length > 0}
                onClick={() => setPublishOpen(true)}
              >
                Publish changes
              </Button>
            )}
            {(canCopy || canArchive) && (
              <MenuRoot>
                <MenuTrigger asChild>
                  <IconButton label="More program actions" variant="secondary">
                    <MoreHorizontal className="size-4" />
                  </IconButton>
                </MenuTrigger>
                <MenuContent>
                  {canCopy && (
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
                    <MenuItem
                      tone={archived ? undefined : 'danger'}
                      onSelect={() => setArchiveOpen(true)}
                    >
                      {archived ? 'Restore program' : 'Archive program'}
                    </MenuItem>
                  )}
                </MenuContent>
              </MenuRoot>
            )}
          </>
        }
      />

      {archived && (
        <Notice tone="warning" title="This program is archived" className="mb-5">
          It cannot be edited or assigned while archived. Restore it from the actions menu to
          continue.
        </Notice>
      )}

      {issues.length > 0 && !archived && (
        <Notice
          tone="warning"
          title={`${issues.length === 1 ? '1 thing' : `${issues.length} things`} to fix before you can publish`}
          className="mb-5"
        >
          <ul className="mt-1 grid gap-1">
            {issues.slice(0, 6).map((issue, i) => {
              const linkable = issue.nodeType !== 'program';
              return (
                <li key={`${issue.nodeId}-${i}`} className="flex flex-wrap items-baseline gap-x-2">
                  <span>{issue.message}</span>
                  {linkable && (
                    <button
                      type="button"
                      className="text-information underline underline-offset-2"
                      onClick={() => goTo(issue)}
                    >
                      Go to it
                    </button>
                  )}
                </li>
              );
            })}
            {issues.length > 6 && <li>And {issues.length - 6} more.</li>}
          </ul>
        </Notice>
      )}

      <TabsRoot value={tab} onValueChange={(v) => setState({ tab: v })}>
        <TabsList className="mb-6" items={TABS} />
        <TabsContent value="structure">
          <StructureTab program={program} />
        </TabsContent>
        <TabsContent value="settings">
          <SettingsPanel
            key={program.updatedAt}
            program={program}
            canEdit={canUpdate && !archived}
          />
        </TabsContent>
        <TabsContent value="enrollment">
          <EnrollmentPanel program={program} />
        </TabsContent>
        <TabsContent value="versions">
          <VersionsPanel program={program} />
        </TabsContent>
      </TabsRoot>

      <PublishDialog program={program} open={publishOpen} onOpenChange={setPublishOpen} />
      <ConfirmDialog
        open={archiveOpen}
        onOpenChange={setArchiveOpen}
        title={archived ? `Restore ${program.title}?` : `Archive ${program.title}?`}
        description={
          archived
            ? 'The program returns to your draft and published programs.'
            : 'Learners keep their progress, but nobody new can be enrolled while it is archived.'
        }
        confirmLabel={archived ? 'Restore' : 'Archive'}
        tone={archived ? 'primary' : 'danger'}
        loading={archiveAction.isPending}
        onConfirm={async () => {
          try {
            await archiveAction.mutateAsync(archived ? 'restore' : 'archive');
            toast.success(archived ? 'Program restored' : 'Program archived');
            setArchiveOpen(false);
          } catch (err) {
            toast.error('That did not work', errorMessage(err));
          }
        }}
      />
    </>
  );
}

function BuilderLoader() {
  const { id = '' } = useParams();
  const program = useProgramDetail(id);
  if (program.isPending)
    return (
      <div aria-busy="true" aria-label="Loading program" className="grid gap-4">
        <Skeleton className="h-7 w-72" />
        <Skeleton className="h-4 w-96" />
        <Skeleton className="mt-4 h-64 w-full" />
      </div>
    );
  if (program.isError)
    return (
      <ErrorState
        title={
          program.error instanceof ApiError && program.error.isNotFound
            ? 'Program not found'
            : 'The program could not be loaded'
        }
        message={errorMessage(program.error)}
        onRetry={() => program.refetch()}
      />
    );
  return <Builder program={program.data} />;
}

export function ProgramBuilderPage() {
  return (
    <RequirePermission all={['programs.view']}>
      <BuilderLoader />
    </RequirePermission>
  );
}
