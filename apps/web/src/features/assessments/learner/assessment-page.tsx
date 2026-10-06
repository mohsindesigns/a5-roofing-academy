import { useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import type { learning } from '@a5/contracts';
import {
  Button,
  EmptyState,
  ErrorState,
  Notice,
  PageHeader,
  Skeleton,
  type Crumb,
} from '@/components/ui';
import { ApiError, errorMessage } from '@/lib/api/errors';
import { useInvalidateProgress, useLesson } from '@/features/learning/api';
import { Requirements } from '@/features/learning/lesson-ui';
import {
  assessmentKeys,
  fetchIntro,
  useAssessmentIntro,
  useAttempt,
  useAttemptResult,
  useStartAttempt,
} from '../api';
import { AssessmentIntroView, IntroError, IntroSkeleton } from './assessment-intro';
import { AttemptPlayer } from './attempt-player';
import { AttemptResultView } from './attempt-result';

type Detail = learning.LessonDetail;

function isGrantError(err: unknown): boolean {
  return err instanceof ApiError && err.code.startsWith('GRANT_');
}

interface Flow {
  detail: Detail;
  programId: string;
  lessonPath: string;
  crumbs: Crumb[];
  assessmentId: string;
  grantToken: string;
  /** Fetch a fresh lesson grant (grants are short-lived) and return its token. */
  refreshGrant: () => Promise<string | undefined>;
  openAttempt: (attemptId: string) => void;
  closeAttempt: () => void;
}

function IntroScreen({ flow }: { flow: Flow }) {
  const qc = useQueryClient();
  const intro = useAssessmentIntro(flow.assessmentId, flow.grantToken);
  const start = useStartAttempt();
  const [startError, setStartError] = useState<string | null>(null);

  const reload = async () => {
    const token = await flow.refreshGrant();
    if (token)
      await qc.fetchQuery({
        queryKey: assessmentKeys.intro(flow.assessmentId),
        queryFn: () => fetchIntro(flow.assessmentId, token),
        staleTime: 0,
      });
    else void intro.refetch();
  };

  if (intro.isPending) return <IntroSkeleton />;
  if (intro.isError) {
    return (
      <>
        <PageHeader title="Assessment" breadcrumbs={flow.crumbs} />
        <IntroError
          error={intro.error}
          onReload={() => void (isGrantError(intro.error) ? reload() : intro.refetch())}
        />
      </>
    );
  }
  return (
    <AssessmentIntroView
      intro={intro.data}
      crumbs={flow.crumbs}
      backTo={flow.lessonPath}
      starting={start.isPending}
      startError={startError}
      onOpen={flow.openAttempt}
      onRefresh={() => void intro.refetch()}
      onStart={() => {
        setStartError(null);
        start.mutate(flow.grantToken, {
          onSuccess: (attempt) => flow.openAttempt(attempt.id),
          onError: (err) => {
            setStartError(errorMessage(err));
            // Attempts used and cooldowns may have changed since the page loaded.
            void (isGrantError(err) ? reload() : intro.refetch());
          },
        });
      }}
    />
  );
}

function AttemptScreen({ flow, attemptId }: { flow: Flow; attemptId: string }) {
  const attempt = useAttempt(attemptId);
  const closed = attempt.isSuccess && attempt.data.status !== 'in_progress';
  const result = useAttemptResult(attemptId, closed);
  const start = useStartAttempt();
  const [retakeError, setRetakeError] = useState<string | null>(null);
  const invalidateProgress = useInvalidateProgress();

  // Passing completes the lesson through an event, so refresh progress now and once more shortly after.
  const passed = result.data?.passed === true;
  useEffect(() => {
    if (!passed) return;
    invalidateProgress();
    const t = setTimeout(invalidateProgress, 3_000);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [passed]);

  if (attempt.isPending) return <Skeleton className="h-96 w-full" />;
  if (attempt.isError) {
    const gone = attempt.error instanceof ApiError && attempt.error.isNotFound;
    return (
      <>
        <PageHeader title="Assessment" breadcrumbs={flow.crumbs} />
        {gone ? (
          <EmptyState
            title="This attempt is not available"
            description="It may belong to someone else, or the link is out of date."
            action={<Button onClick={flow.closeAttempt}>Back to the assessment</Button>}
          />
        ) : (
          <ErrorState message={errorMessage(attempt.error)} onRetry={() => attempt.refetch()} />
        )}
      </>
    );
  }
  if (!closed)
    return <AttemptPlayer key={attempt.data.id} attempt={attempt.data} crumbs={flow.crumbs} />;

  if (result.isPending) return <Skeleton className="h-96 w-full" />;
  if (result.isError) {
    return (
      <>
        <PageHeader title="Your result" breadcrumbs={flow.crumbs} />
        <ErrorState
          title="The result could not be loaded"
          message={errorMessage(result.error)}
          onRetry={() => result.refetch()}
        />
      </>
    );
  }
  const next = flow.detail.nextLessonId;
  return (
    <AttemptResultView
      attempt={attempt.data}
      result={result.data}
      crumbs={flow.crumbs}
      backTo={flow.lessonPath}
      introTo={`${flow.lessonPath}/assessment`}
      nextLessonTo={next ? `/training/${flow.programId}/lessons/${next}` : null}
      retaking={start.isPending}
      retakeError={retakeError}
      onRetake={() => {
        setRetakeError(null);
        const begin = (token: string) =>
          start.mutate(token, {
            onSuccess: (a) => flow.openAttempt(a.id),
            onError: (err) => setRetakeError(errorMessage(err)),
          });
        // A grant older than a few minutes may have expired: use a fresh one for the new attempt.
        void flow.refreshGrant().then((token) => begin(token ?? flow.grantToken));
      }}
    />
  );
}

export function AssessmentTakePage() {
  const { programId = '', lessonId = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const lesson = useLesson(lessonId);
  const attemptId = params.get('attempt');

  const lessonPath = `/training/${programId}/lessons/${lessonId}`;
  if (lesson.isPending) return <Skeleton className="h-96 w-full" />;
  if (lesson.isError) {
    const gone = lesson.error instanceof ApiError && lesson.error.isNotFound;
    return (
      <>
        <PageHeader title="Assessment" breadcrumbs={[{ label: 'Training', to: '/training' }]} />
        {gone ? (
          <Notice tone="warning">This lesson is not available to you.</Notice>
        ) : (
          <ErrorState message={errorMessage(lesson.error)} onRetry={() => lesson.refetch()} />
        )}
      </>
    );
  }

  const d = lesson.data;
  const crumbs: Crumb[] = [
    { label: 'Training', to: '/training' },
    { label: d.program.title, to: `/training/${programId}` },
    { label: d.lesson.title, to: lessonPath },
    { label: 'Assessment' },
  ];
  const isAssessment = d.lesson.type === 'quiz' || d.lesson.type === 'final_assessment';

  if (!isAssessment) {
    return (
      <>
        <PageHeader title="Assessment" breadcrumbs={crumbs} />
        <EmptyState
          title="This lesson does not have an assessment"
          action={
            <Button asChild>
              <Link to={lessonPath}>Back to the lesson</Link>
            </Button>
          }
        />
      </>
    );
  }
  if (d.state === 'locked') {
    return (
      <>
        <PageHeader title={d.lesson.title} breadcrumbs={crumbs} />
        <Requirements items={d.requirements} title="This assessment is locked" />
      </>
    );
  }
  const grant = d.grant;
  if (!grant || grant.resource.type !== 'assessment') {
    return (
      <>
        <PageHeader title={d.lesson.title} breadcrumbs={crumbs} />
        <EmptyState
          title="This assessment is not available yet"
          description="No assessment is attached to this lesson, or it is not open for attempts. Contact your trainer if you expected it to be available."
          action={
            <Button asChild>
              <Link to={lessonPath}>Back to the lesson</Link>
            </Button>
          }
        />
      </>
    );
  }

  const flow: Flow = {
    detail: d,
    programId,
    lessonPath,
    crumbs,
    assessmentId: grant.resource.id,
    grantToken: grant.token,
    refreshGrant: async () => (await lesson.refetch()).data?.grant?.token,
    openAttempt: (id) => setParams({ attempt: id }),
    closeAttempt: () => setParams({}),
  };

  return attemptId ? (
    <AttemptScreen key={attemptId} flow={flow} attemptId={attemptId} />
  ) : (
    <IntroScreen flow={flow} />
  );
}
