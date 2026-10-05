import { useNavigate } from 'react-router';
import type { learning } from '@a5/contracts';
import { Button, Notice, Skeleton } from '@/components/ui';
import { errorMessage } from '@/lib/api/errors';
import { pluralize } from '@/lib/format';
import { usePracticeBrief, useStartSession } from './api';
import { Difficulty } from './ui';

/**
 * Body of an `ai_simulation` lesson. The lesson's signed grant makes the conversation an assigned
 * attempt, so its score counts toward the lesson's required score.
 */
export function AiSimulationLesson({ detail }: { detail: learning.LessonDetail }) {
  const navigate = useNavigate();
  const config = detail.lesson.config;
  const scenarioId = typeof config?.scenarioId === 'string' ? config.scenarioId : undefined;
  const minScore = typeof config?.minScore === 'number' ? config.minScore : null;
  const brief = usePracticeBrief(scenarioId);
  const start = useStartSession();
  const best = detail.progress.bestScore;

  if (!scenarioId)
    return (
      <Notice tone="warning">No practice scenario has been chosen for this lesson yet.</Notice>
    );

  return (
    <div className="grid max-w-[70ch] gap-5 rounded-lg border border-border bg-surface p-5">
      {brief.isPending ? (
        <Skeleton className="h-16 w-full" />
      ) : brief.data ? (
        <div className="grid gap-2">
          <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-text-secondary">
            <span className="font-medium text-text-primary">{brief.data.title}</span>
            <Difficulty level={brief.data.difficulty} />
            <span className="tabular">Up to {pluralize(brief.data.maxTurns, 'turn')}</span>
          </p>
          <p className="text-base whitespace-pre-wrap">{brief.data.repBrief}</p>
        </div>
      ) : null}
      <p className="text-sm text-text-secondary">
        {minScore !== null && (
          <>
            Score <strong className="tabular font-medium text-text-primary">{minScore}</strong> or
            more to complete this lesson.{' '}
          </>
        )}
        {best !== null && (
          <>
            Your best so far is{' '}
            <strong className="tabular font-medium text-text-primary">{Math.round(best)}</strong>.
          </>
        )}
      </p>
      {start.isError && (
        <Notice tone="danger" title="Could not start the conversation">
          {errorMessage(start.error)}
        </Notice>
      )}
      <div>
        <Button
          variant="primary"
          size="lg"
          disabled={!detail.grant}
          loading={start.isPending}
          onClick={() =>
            detail.grant &&
            start.mutate(
              { scenarioId, lessonGrant: detail.grant.token },
              { onSuccess: (session) => navigate(`/ai-coach/sessions/${session.id}`) },
            )
          }
        >
          {best === null ? 'Start practice' : 'Practice again'}
        </Button>
      </div>
    </div>
  );
}
