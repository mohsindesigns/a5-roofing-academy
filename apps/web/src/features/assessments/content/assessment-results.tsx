import { Link } from 'react-router';
import { assessment } from '@a5/contracts';
import { BarList, StatCell, StatRow, StatTile } from '@/components/charts';
import { Button, EmptyState, ErrorState, Section, Skeleton } from '@/components/ui';
import { errorMessage } from '@/lib/api/errors';
import { useAssessmentStats } from '../api';
import { formatDuration, formatScore } from '../labels';

/** Aggregate results for one assessment: how learners are doing and which questions trip them up. */
export function AssessmentResults({
  assessmentId,
  canViewAttempts,
}: {
  assessmentId: string;
  canViewAttempts: boolean;
}) {
  const stats = useAssessmentStats(assessmentId);
  if (stats.isPending) return <Skeleton className="h-48 w-full" />;
  if (stats.isError)
    return <ErrorState message={errorMessage(stats.error)} onRetry={() => stats.refetch()} />;
  const s = stats.data;
  if (s.attempts.total === 0) {
    return (
      <EmptyState
        title="No attempts yet"
        description="Results appear here once learners start taking this assessment."
      />
    );
  }
  const bins = s.scoreDistribution.map((b) => ({
    key: `${b.from}-${b.to}`,
    label: `${b.from}–${b.to}%`,
    value: b.count,
  }));
  return (
    <div>
      <StatRow className="mb-8">
        <StatCell>
          <StatTile
            label="Attempts"
            value={s.attempts.total}
            context={`${s.learners} ${s.learners === 1 ? 'learner' : 'learners'}`}
          />
        </StatCell>
        <StatCell>
          <StatTile
            label="Pass rate"
            value={s.passRate === null ? '—' : formatScore(Math.round(s.passRate))}
            context="of graded attempts"
          />
        </StatCell>
        <StatCell>
          <StatTile
            label="First-attempt pass rate"
            value={
              s.firstAttemptPassRate === null
                ? '—'
                : formatScore(Math.round(s.firstAttemptPassRate))
            }
          />
        </StatCell>
        <StatCell>
          <StatTile
            label="Average score"
            value={formatScore(
              s.averageScorePercent === null ? null : Math.round(s.averageScorePercent),
            )}
            context={
              s.medianScorePercent === null
                ? undefined
                : `median ${formatScore(Math.round(s.medianScorePercent))}`
            }
          />
        </StatCell>
        <StatCell>
          <StatTile
            label="Average time taken"
            value={
              s.averageDurationSeconds === null ? '—' : formatDuration(s.averageDurationSeconds)
            }
          />
        </StatCell>
      </StatRow>

      <div className="grid gap-10 lg:grid-cols-2">
        <Section title="Score distribution" description="Graded attempts by score band.">
          <BarList
            ariaLabel="Graded attempts by score band"
            data={bins}
            emptyText="No graded attempts yet."
          />
        </Section>
        <Section
          title="Hardest questions"
          description="Lowest share answered correctly among graded attempts."
        >
          {s.hardestQuestions.length === 0 ? (
            <p className="text-sm text-text-secondary">No graded answers yet.</p>
          ) : (
            <ol className="divide-y divide-divider border-y border-divider">
              {s.hardestQuestions.map((q) => (
                <li key={q.questionId} className="flex items-start justify-between gap-4 py-3">
                  <div className="min-w-0">
                    <Link
                      to={`/content/questions/${q.questionId}`}
                      className="line-clamp-2 font-medium hover:underline"
                    >
                      {q.prompt}
                    </Link>
                    <p className="text-sm text-text-secondary">
                      {assessment.QUESTION_TYPE_LABELS[q.type]} ·{' '}
                      {q.category?.name ?? 'No category'} · answered {q.answered}{' '}
                      {q.answered === 1 ? 'time' : 'times'}
                    </p>
                  </div>
                  <p className="tabular shrink-0 text-right font-semibold">
                    {formatScore(Math.round(q.correctRate))}
                    <span className="block text-xs font-normal text-text-tertiary">correct</span>
                  </p>
                </li>
              ))}
            </ol>
          )}
        </Section>
      </div>

      {canViewAttempts && (
        <div className="mt-8">
          <Button asChild>
            <Link to={`/content/assessments/attempts?assessmentId=${assessmentId}`}>
              View attempts
            </Link>
          </Button>
        </div>
      )}
    </div>
  );
}
