import { useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import { Archive, ArchiveRestore } from 'lucide-react';
import { assessment } from '@a5/contracts';
import {
  Button,
  ConfirmDialog,
  EmptyState,
  ErrorState,
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
import { assessmentKeys, useBanks, useQuestion, useQuestionArchive } from '../api';
import { DIFFICULTY_LABELS } from '../labels';
import { emptyForm, fromVersion } from './question-form-model';
import { QuestionForm } from './question-form';
import { PreviewPanel, UsagePanel, VersionsPanel } from './question-panels';
import { useQueryClient } from '@tanstack/react-query';

const TABS = ['edit', 'preview', 'versions', 'usage'] as const;

function NewQuestion() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const canCreate = useCan('assessments.create');
  const banks = useBanks();
  const wanted = params.get('bankId') ?? '';
  const bankId =
    banks.data?.items.find((b) => b.id === wanted && !b.archived)?.id ??
    banks.data?.items.find((b) => !b.archived)?.id ??
    '';
  const type = assessment.questionTypeSchema.safeParse(params.get('type'));
  const initial = useMemo(
    () => emptyForm(type.success ? type.data : 'multiple_choice', bankId),
    [bankId, type.success, type.data],
  );

  return (
    <>
      <PageHeader
        breadcrumbs={[
          { label: 'Question bank', to: '/content/questions' },
          { label: 'New question' },
        ]}
        title="New question"
        description="Pick the type, write the question and mark the right answer. It saves as version 1."
      />
      {!canCreate ? (
        <EmptyState
          title="You can't add questions"
          description="Your role does not include creating questions. Ask a training administrator."
        />
      ) : banks.isPending ? (
        <Skeleton className="h-96 w-full" />
      ) : banks.isError ? (
        <ErrorState message={errorMessage(banks.error)} onRetry={() => banks.refetch()} />
      ) : banks.data.items.every((b) => b.archived) ? (
        <EmptyState
          title="Create a question bank first"
          description="Questions belong to a bank. Create one from the question bank page, then come back."
          action={
            <Button onClick={() => navigate('/content/questions')}>Go to the question bank</Button>
          }
        />
      ) : (
        <QuestionForm
          key={bankId}
          initial={initial}
          readOnly={false}
          onCreated={(id) => navigate(`/content/questions/${id}`, { replace: true })}
          onReloadLatest={() => undefined}
        />
      )}
    </>
  );
}

function ExistingQuestion({ id }: { id: string }) {
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const canUpdate = useCan('assessments.update');
  const detail = useQuestion(id);
  const archive = useQuestionArchive(id);
  const [confirm, setConfirm] = useState<'archive' | 'restore' | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [seed, setSeed] = useState<assessment.QuestionVersion | null>(null);
  const [previewVersion, setPreviewVersion] = useState<string | undefined>();
  const loaded = detail.data;
  const initial = useMemo(
    () => (loaded ? fromVersion(seed ?? loaded.currentVersion, loaded.bank.id) : null),
    [loaded, seed],
  );
  const tabParam = params.get('tab');
  const tab = TABS.find((t) => t === tabParam) ?? 'edit';
  const setTab = (next: string) =>
    setParams(next === 'edit' ? {} : { tab: next }, { replace: true });

  if (detail.isPending) return <Skeleton className="h-96 w-full" />;
  if (detail.isError) {
    const gone = detail.error instanceof ApiError && detail.error.isNotFound;
    return (
      <>
        <PageHeader
          title="Question"
          breadcrumbs={[{ label: 'Question bank', to: '/content/questions' }]}
        />
        {gone ? (
          <Notice tone="warning">
            This question no longer exists, or you no longer have access to it.
          </Notice>
        ) : (
          <ErrorState message={errorMessage(detail.error)} onRetry={() => detail.refetch()} />
        )}
      </>
    );
  }
  const q = detail.data;
  const current = q.currentVersion;
  const archived = q.status === 'archived';
  const startedFromOlder = seed && seed.id !== current.id ? seed.version : undefined;

  const reloadLatest = async () => {
    setSeed(null);
    await qc.invalidateQueries({ queryKey: assessmentKeys.question(id) });
  };

  return (
    <>
      <PageHeader
        breadcrumbs={[
          { label: 'Question bank', to: '/content/questions' },
          { label: assessment.QUESTION_TYPE_LABELS[current.type] },
        ]}
        title={<span className="line-clamp-2 break-words">{current.prompt}</span>}
        meta={
          <>
            <StatusText tone={archived ? 'warning' : 'success'}>
              {archived ? 'Archived' : 'Active'}
            </StatusText>
            <span>Version {current.version}</span>
            <span>{assessment.QUESTION_TYPE_LABELS[current.type]}</span>
            <span>{DIFFICULTY_LABELS[current.difficulty]}</span>
            <span>{q.bank.title}</span>
            <span>Updated {formatRelative(q.updatedAt)}</span>
          </>
        }
        actions={
          canUpdate && (
            <Button
              leading={
                archived ? <ArchiveRestore className="size-4" /> : <Archive className="size-4" />
              }
              onClick={() => {
                setActionError(null);
                setConfirm(archived ? 'restore' : 'archive');
              }}
            >
              {archived ? 'Restore' : 'Archive'}
            </Button>
          )
        }
      />
      <TabsRoot value={tab} onValueChange={setTab}>
        <TabsList
          className="mb-6"
          items={[
            { value: 'edit', label: 'Edit' },
            { value: 'preview', label: 'Preview' },
            { value: 'versions', label: 'Versions', count: q.versionCount },
            { value: 'usage', label: 'Usage', count: q.usage.length },
          ]}
        />
        <TabsContent value="edit" forceMount>
          <QuestionForm
            key={`${current.id}:${seed?.id ?? ''}`}
            initial={initial!}
            question={q}
            readOnly={!canUpdate || archived}
            seededFrom={startedFromOlder}
            onCreated={() => undefined}
            onReloadLatest={() => void reloadLatest()}
          />
        </TabsContent>
        <TabsContent value="preview">
          <PreviewPanel questionId={q.id} versionId={previewVersion} />
          {previewVersion && previewVersion !== current.id && (
            <div className="mt-4">
              <Button size="sm" onClick={() => setPreviewVersion(undefined)}>
                Preview the current version
              </Button>
            </div>
          )}
        </TabsContent>
        <TabsContent value="versions">
          <VersionsPanel
            questionId={q.id}
            currentVersionId={current.id}
            canEdit={canUpdate && !archived}
            onPreview={(v) => {
              setPreviewVersion(v.id);
              setTab('preview');
            }}
            onStartFrom={(v) => {
              setSeed(v);
              setTab('edit');
            }}
          />
        </TabsContent>
        <TabsContent value="usage">
          <UsagePanel question={q} />
        </TabsContent>
      </TabsRoot>

      <ConfirmDialog
        open={confirm === 'archive'}
        onOpenChange={(o) => !o && setConfirm(null)}
        title="Archive this question?"
        description={
          <>
            It stops being drawn into new attempts and cannot be added to assessments. Past attempts
            keep it.
            {q.usage.some((u) => u.status === 'published') && (
              <> Published assessments that include it must drop it first.</>
            )}
          </>
        }
        confirmLabel="Archive"
        tone="danger"
        loading={archive.isPending}
        error={actionError}
        onConfirm={() =>
          archive.mutate(true, {
            onSuccess: () => {
              toast.success('Question archived');
              setConfirm(null);
            },
            onError: (err) => setActionError(errorMessage(err)),
          })
        }
      />
      <ConfirmDialog
        open={confirm === 'restore'}
        onOpenChange={(o) => !o && setConfirm(null)}
        title="Restore this question?"
        description="It becomes active again and can be drawn into attempts and added to assessments."
        confirmLabel="Restore"
        loading={archive.isPending}
        error={actionError}
        onConfirm={() =>
          archive.mutate(false, {
            onSuccess: () => {
              toast.success('Question restored');
              setConfirm(null);
            },
            onError: (err) => setActionError(errorMessage(err)),
          })
        }
      />
    </>
  );
}

export function QuestionEditorPage() {
  const { id = '' } = useParams();
  return (
    <RequirePermission all={['assessments.view']}>
      {id === 'new' ? <NewQuestion /> : <ExistingQuestion id={id} />}
    </RequirePermission>
  );
}
