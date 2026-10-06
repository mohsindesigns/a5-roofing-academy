import { useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import { Copy, Eye, MoreHorizontal, Trash2, Archive } from 'lucide-react';
import {
  Button,
  ConfirmDialog,
  ErrorState,
  IconButton,
  MenuContent,
  MenuItem,
  MenuRoot,
  MenuSeparator,
  MenuTrigger,
  Notice,
  PageHeader,
  Skeleton,
  StatusText,
  TabsContent,
  TabsList,
  TabsRoot,
  toast,
} from '@/components/ui';
import { RequirePermission } from '@/app/guards';
import { useCan } from '@/features/auth/session';
import { ApiError, errorMessage } from '@/lib/api/errors';
import { formatRelative } from '@/lib/format';
import {
  useArchiveAssessment,
  useAssessment,
  useAssessmentValidation,
  useDeleteAssessment,
  useDuplicateAssessment,
  usePublishAssessment,
} from '../api';
import { ASSESSMENT_STATUS, KIND_LABELS } from '../labels';
import { AssessmentItems } from './assessment-items';
import { AssessmentPreviewSheet } from './assessment-preview-sheet';
import { AssessmentResults } from './assessment-results';
import { AssessmentSettingsForm } from './assessment-settings-form';

type Action = 'publish' | 'archive' | 'duplicate' | 'delete';

function Builder({ id }: { id: string }) {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const tab = ['questions', 'settings', 'results'].includes(params.get('tab') ?? '')
    ? (params.get('tab') as string)
    : 'questions';
  const canUpdate = useCan('assessments.update');
  const canCreate = useCan('assessments.create');
  const canViewAttempts = useCan('assessment_attempts.view');
  const detail = useAssessment(id);
  const validation = useAssessmentValidation(id);
  const publish = usePublishAssessment(id);
  const archive = useArchiveAssessment(id);
  const duplicate = useDuplicateAssessment(id);
  const remove = useDeleteAssessment(id);
  const [action, setAction] = useState<Action | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);

  if (detail.isPending) return <Skeleton className="h-96 w-full" />;
  if (detail.isError) {
    const gone = detail.error instanceof ApiError && detail.error.isNotFound;
    return (
      <>
        <PageHeader
          title="Assessment"
          breadcrumbs={[{ label: 'Assessments', to: '/content/assessments' }]}
        />
        {gone ? (
          <Notice tone="warning">
            This assessment no longer exists, or you no longer have access to it.
          </Notice>
        ) : (
          <ErrorState message={errorMessage(detail.error)} onRetry={() => detail.refetch()} />
        )}
      </>
    );
  }

  const a = detail.data;
  const status = ASSESSMENT_STATUS[a.status];
  const issues = validation.data && !validation.data.valid ? validation.data.issues : [];
  const close = () => {
    setAction(null);
    setActionError(null);
  };
  const run = (mutation: Promise<unknown>, done: string, then?: () => void) => {
    mutation
      .then(() => {
        toast.success(done);
        close();
        then?.();
      })
      .catch((err: unknown) => setActionError(errorMessage(err)));
  };

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: 'Assessments', to: '/content/assessments' }, { label: a.title }]}
        title={a.title}
        description={a.description ?? undefined}
        meta={
          <>
            <StatusText tone={status.tone}>{status.label}</StatusText>
            <span>{KIND_LABELS[a.kind]}</span>
            <span>
              {a.questionCount} {a.questionCount === 1 ? 'question' : 'questions'}
            </span>
            <span>
              Updated {formatRelative(a.updatedAt)}
              {a.updatedBy ? ` by ${a.updatedBy.displayName}` : ''}
            </span>
          </>
        }
        actions={
          <>
            <Button
              leading={<Eye className="size-4" />}
              onClick={() => setPreviewing(true)}
              disabled={a.itemCount === 0}
            >
              Preview
            </Button>
            {canUpdate && a.status !== 'published' && (
              <Button
                variant="primary"
                onClick={() => setAction('publish')}
                disabled={validation.data?.valid === false || a.itemCount === 0}
              >
                {a.status === 'archived' ? 'Publish again' : 'Publish'}
              </Button>
            )}
            {(canCreate || canUpdate) && (
              <MenuRoot>
                <MenuTrigger asChild>
                  <IconButton label="More actions" variant="secondary">
                    <MoreHorizontal className="size-4" />
                  </IconButton>
                </MenuTrigger>
                <MenuContent>
                  {canCreate && (
                    <MenuItem
                      icon={<Copy className="size-4" />}
                      onSelect={() => setAction('duplicate')}
                    >
                      Duplicate
                    </MenuItem>
                  )}
                  {canUpdate && a.status === 'published' && (
                    <MenuItem
                      icon={<Archive className="size-4" />}
                      onSelect={() => setAction('archive')}
                    >
                      Archive
                    </MenuItem>
                  )}
                  {canUpdate && a.status === 'draft' && a.attemptCount === 0 && (
                    <>
                      <MenuSeparator />
                      <MenuItem
                        tone="danger"
                        icon={<Trash2 className="size-4" />}
                        onSelect={() => setAction('delete')}
                      >
                        Delete draft
                      </MenuItem>
                    </>
                  )}
                </MenuContent>
              </MenuRoot>
            )}
          </>
        }
      />

      {issues.length > 0 && (
        <Notice
          tone="warning"
          title={
            a.status === 'published'
              ? 'This assessment needs attention'
              : 'Fix these before you can publish'
          }
          className="mb-6"
        >
          <ul className="mt-1 grid gap-1">
            {issues.map((i) => (
              <li key={`${i.code}-${i.itemId ?? i.message}`}>{i.message}</li>
            ))}
          </ul>
        </Notice>
      )}

      <TabsRoot
        value={tab}
        onValueChange={(t) => setParams(t === 'questions' ? {} : { tab: t }, { replace: true })}
      >
        <TabsList
          className="mb-6"
          items={[
            { value: 'questions', label: 'Questions', count: a.itemCount },
            { value: 'settings', label: 'Settings' },
            { value: 'results', label: 'Results', count: a.attemptCount },
          ]}
        />
        <TabsContent value="questions">
          <AssessmentItems
            assessmentId={a.id}
            items={a.items}
            status={a.status}
            canEdit={canUpdate}
          />
        </TabsContent>
        <TabsContent value="settings">
          <AssessmentSettingsForm detail={a} canEdit={canUpdate} />
        </TabsContent>
        <TabsContent value="results">
          <AssessmentResults assessmentId={a.id} canViewAttempts={canViewAttempts} />
        </TabsContent>
      </TabsRoot>

      <AssessmentPreviewSheet assessmentId={a.id} open={previewing} onOpenChange={setPreviewing} />

      <ConfirmDialog
        open={action === 'publish'}
        onOpenChange={(o) => !o && close()}
        title={
          a.status === 'archived' ? 'Publish this assessment again?' : 'Publish this assessment?'
        }
        description={`Learners whose lesson links to ${a.title} can start attempts right away, using the pass mark, attempt limit and time limit in Settings.`}
        confirmLabel="Publish"
        loading={publish.isPending}
        error={actionError}
        onConfirm={() => run(publish.mutateAsync(), 'Published')}
      />
      <ConfirmDialog
        open={action === 'archive'}
        onOpenChange={(o) => !o && close()}
        title="Archive this assessment?"
        description="Learners can no longer start attempts. Attempts already taken, and their results, are kept."
        confirmLabel="Archive"
        tone="danger"
        loading={archive.isPending}
        error={actionError}
        onConfirm={() => run(archive.mutateAsync(), 'Archived')}
      />
      <ConfirmDialog
        open={action === 'duplicate'}
        onOpenChange={(o) => !o && close()}
        title="Duplicate this assessment?"
        description="A draft copy is created with the same settings and questions. Nothing reaches learners until you publish it."
        confirmLabel="Duplicate"
        loading={duplicate.isPending}
        error={actionError}
        onConfirm={() =>
          run(
            duplicate
              .mutateAsync(undefined)
              .then((copy) => navigate(`/content/assessments/${copy.id}`)),
            'Draft copy created',
          )
        }
      />
      <ConfirmDialog
        open={action === 'delete'}
        onOpenChange={(o) => !o && close()}
        title="Delete this draft?"
        description="The draft and its list of questions are removed. Questions stay in the bank."
        confirmLabel="Delete draft"
        tone="danger"
        loading={remove.isPending}
        error={actionError}
        onConfirm={() =>
          run(remove.mutateAsync(), 'Draft deleted', () => navigate('/content/assessments'))
        }
      />
    </>
  );
}

export function AssessmentBuilderPage() {
  const { id = '' } = useParams();
  return (
    <RequirePermission all={['assessments.view']}>
      <Builder id={id} />
    </RequirePermission>
  );
}
