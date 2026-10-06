import { Link } from 'react-router';
import { assessment } from '@a5/contracts';
import {
  DescriptionList,
  DialogRoot,
  ErrorState,
  Notice,
  SheetContent,
  Skeleton,
  StatusText,
  Table,
  TBody,
  Td,
  Th,
  THead,
  Tr,
} from '@/components/ui';
import { Markdown } from '@/components/markdown';
import { useCan } from '@/features/auth/session';
import { errorMessage } from '@/lib/api/errors';
import { formatDateTime } from '@/lib/format';
import {
  CorrectAnswerView,
  correctAnswerLabel,
  correctAnswerOf,
  lookupFromDefinition,
  ResponseView,
} from '../answer-view';
import { useReviewAttempt } from '../api';
import {
  ATTEMPT_STATUS,
  DIFFICULTY_LABELS,
  OUTCOME,
  formatDuration,
  formatPoints,
  formatScore,
} from '../labels';

type Detail = assessment.ReviewAttemptDetail;

export interface CategoryScore {
  name: string;
  /** Points earned on graded answers. */
  earned: number;
  /** Points available on graded answers. */
  possible: number;
  questions: number;
  awaitingReview: number;
}

/** Points earned per category. Answers still waiting for a reviewer are counted apart, not as zero. */
export function categoryBreakdown(
  questions: readonly assessment.ReviewQuestion[],
): CategoryScore[] {
  const rows = new Map<string, CategoryScore>();
  for (const q of questions) {
    const name = q.category?.name ?? 'No category';
    const row = rows.get(name) ?? { name, earned: 0, possible: 0, questions: 0, awaitingReview: 0 };
    row.questions += 1;
    if (q.outcome === 'pending_review') row.awaitingReview += 1;
    else {
      row.earned += q.awardedPoints ?? 0;
      row.possible += q.points;
    }
    rows.set(name, row);
  }
  return [...rows.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function Body({ a }: { a: Detail }) {
  const canViewPeople = useCan('users.view');
  const canViewAssessments = useCan('assessments.view');
  const status = ATTEMPT_STATUS[a.status];
  const taken = a.submittedAt
    ? Math.max(
        0,
        Math.round((new Date(a.submittedAt).getTime() - new Date(a.startedAt).getTime()) / 1000),
      )
    : null;
  const categories = categoryBreakdown(a.questions);
  const resultTone = a.passed === true ? 'success' : a.passed === false ? 'danger' : 'neutral';

  return (
    <div className="grid gap-8">
      <DescriptionList
        items={[
          {
            label: 'Learner',
            value: canViewPeople ? (
              <Link to={`/people/${a.learner.id}`} className="text-information hover:underline">
                {a.learner.displayName}
              </Link>
            ) : (
              a.learner.displayName
            ),
          },
          {
            label: 'Assessment',
            value: canViewAssessments ? (
              <Link
                to={`/content/assessments/${a.assessment.id}`}
                className="text-information hover:underline"
              >
                {a.assessment.title}
              </Link>
            ) : (
              a.assessment.title
            ),
          },
          { label: 'Attempt', value: a.attemptNumber },
          { label: 'Status', value: <StatusText tone={status.tone}>{status.label}</StatusText> },
          { label: 'Started', value: formatDateTime(a.startedAt) },
          {
            label: 'Submitted',
            value: a.submittedAt ? formatDateTime(a.submittedAt) : 'Not submitted',
          },
          { label: 'Time taken', value: taken === null ? null : formatDuration(taken) },
          {
            label: 'Time limit',
            value:
              a.config.timeLimitSeconds === null
                ? 'No time limit'
                : formatDuration(a.config.timeLimitSeconds),
          },
        ]}
      />

      {a.autoSubmitted && (
        <Notice tone="warning">
          The time limit ended, so the answers saved at that point were submitted automatically.
        </Notice>
      )}

      <section aria-labelledby="attempt-result">
        <h3 id="attempt-result" className="mb-2 text-md font-semibold">
          Result
        </h3>
        {a.scorePercent === null ? (
          <p className="text-text-secondary">
            {a.status === 'pending_review'
              ? 'Waiting for a trainer to score written answers.'
              : 'Not graded yet.'}
          </p>
        ) : (
          <>
            <p className="flex flex-wrap items-baseline gap-x-3">
              <span className="tabular text-2xl font-semibold">{formatScore(a.scorePercent)}</span>
              <StatusText tone={resultTone}>{a.passed ? 'Passed' : 'Not passed'}</StatusText>
              <span className="text-sm text-text-secondary">
                Pass mark {a.config.passingPercent}%
              </span>
            </p>
            {a.overridden && (
              <div className="mt-3">
                <Notice tone="information" title="Score adjusted">
                  Original grading: {formatScore(a.gradedScorePercent)} (
                  {a.gradedPassed ? 'passed' : 'not passed'}). The adjusted score is the one that
                  counts.
                </Notice>
                <ul className="mt-2 grid gap-2 text-sm">
                  {a.overrides.map((o) => (
                    <li key={o.id} className="rounded-lg border border-border px-3 py-2">
                      <p className="font-medium">
                        {formatScore(o.previousScorePercent)} to {formatScore(o.newScorePercent)} by{' '}
                        {o.actor.displayName}, {formatDateTime(o.createdAt)}
                      </p>
                      <p className="text-text-secondary">{o.reason}</p>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </section>

      {categories.length > 0 && (
        <section aria-labelledby="attempt-categories">
          <h3 id="attempt-categories" className="mb-2 text-md font-semibold">
            By category
          </h3>
          <Table caption="Points by category">
            <THead>
              <tr>
                <Th>Category</Th>
                <Th className="text-right">Questions</Th>
                <Th className="text-right">Points</Th>
                <Th className="text-right">Score</Th>
              </tr>
            </THead>
            <TBody>
              {categories.map((c) => (
                <Tr key={c.name}>
                  <Td>{c.name}</Td>
                  <Td className="tabular text-right">{c.questions}</Td>
                  <Td className="tabular text-right">
                    {formatPoints(c.earned)} of {formatPoints(c.possible)}
                    {c.awaitingReview > 0 && (
                      <span className="block text-xs text-text-tertiary">
                        {c.awaitingReview} awaiting review
                      </span>
                    )}
                  </Td>
                  <Td className="tabular text-right">
                    {c.possible > 0 ? formatScore(Math.round((c.earned / c.possible) * 100)) : '—'}
                  </Td>
                </Tr>
              ))}
            </TBody>
          </Table>
        </section>
      )}

      <section aria-labelledby="attempt-answers">
        <h3 id="attempt-answers" className="mb-1 text-md font-semibold">
          Answers
        </h3>
        <ol aria-label="Answers" className="divide-y divide-divider border-y border-divider">
          {a.questions.map((q) => {
            const lookup = lookupFromDefinition(q.definition);
            const outcome = OUTCOME[q.outcome];
            return (
              <li key={q.attemptQuestionId} className="py-4">
                <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1">
                  <p className="text-sm text-text-secondary">
                    <span className="font-medium text-text-primary">Question {q.position}</span> ·{' '}
                    {assessment.QUESTION_TYPE_LABELS[q.definition.type]} ·{' '}
                    {DIFFICULTY_LABELS[q.difficulty]} · {q.category?.name ?? 'No category'} ·
                    version {q.version}
                  </p>
                  <p className="flex items-center gap-3">
                    <StatusText tone={outcome.tone}>{outcome.label}</StatusText>
                    <span className="tabular text-sm text-text-secondary">
                      {q.awardedPoints === null ? '—' : formatPoints(q.awardedPoints)} of{' '}
                      {formatPoints(q.points)}
                    </span>
                  </p>
                </div>
                <div className="mt-1 font-medium">
                  <Markdown className="[&_p]:mb-2">{q.prompt}</Markdown>
                </div>
                {q.definition.type === 'scenario' && (
                  <div className="mt-2 rounded-lg border border-border bg-surface-sunken/60 px-4 py-3 text-sm">
                    <Markdown className="text-sm [&_p]:mb-2">
                      {q.definition.config.scenario}
                    </Markdown>
                    <p className="font-medium">{q.definition.config.subQuestion.prompt}</p>
                  </div>
                )}
                <dl className="mt-3 grid gap-4 sm:grid-cols-2">
                  <div className="min-w-0">
                    <dt className="mb-0.5 text-xs font-medium text-text-tertiary">
                      Learner&apos;s answer
                    </dt>
                    <dd>
                      <ResponseView response={q.response} lookup={lookup} empty="Not answered" />
                    </dd>
                  </div>
                  <div className="min-w-0">
                    <dt className="mb-0.5 text-xs font-medium text-text-tertiary">
                      {correctAnswerLabel(correctAnswerOf(q.definition))}
                    </dt>
                    <dd>
                      <CorrectAnswerView correct={correctAnswerOf(q.definition)} lookup={lookup} />
                    </dd>
                  </div>
                </dl>
                {q.explanation && (
                  <p className="mt-2 max-w-[68ch] text-sm text-text-secondary">{q.explanation}</p>
                )}
                {q.feedback && (
                  <p className="mt-2 text-sm">
                    <span className="font-medium">Feedback: </span>
                    {q.feedback}
                    {q.gradedBy && (
                      <span className="text-text-tertiary"> ({q.gradedBy.displayName})</span>
                    )}
                  </p>
                )}
              </li>
            );
          })}
        </ol>
      </section>
    </div>
  );
}

/** Read-only view of one attempt, within the viewer's data scope. */
export function AttemptDetailSheet({
  attemptId,
  onClose,
}: {
  attemptId: string | undefined;
  onClose: () => void;
}) {
  const attempt = useReviewAttempt(attemptId);
  return (
    <DialogRoot open={Boolean(attemptId)} onOpenChange={(o) => !o && onClose()}>
      <SheetContent
        className="sm:w-[min(760px,94vw)]"
        title={
          attempt.data
            ? `${attempt.data.learner.displayName}: attempt ${attempt.data.attemptNumber}`
            : 'Attempt'
        }
        description={attempt.data?.assessment.title ?? 'Answers and results for this attempt.'}
      >
        {attempt.isPending ? (
          <div className="grid gap-3" aria-busy="true" aria-label="Loading attempt">
            <Skeleton className="h-6 w-56" />
            <Skeleton className="h-32 w-full" />
            <Skeleton className="h-40 w-full" />
          </div>
        ) : attempt.isError ? (
          <ErrorState message={errorMessage(attempt.error)} onRetry={() => attempt.refetch()} />
        ) : (
          <Body a={attempt.data} />
        )}
      </SheetContent>
    </DialogRoot>
  );
}
