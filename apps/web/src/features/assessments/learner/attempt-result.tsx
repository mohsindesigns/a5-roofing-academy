import { Link } from 'react-router';
import { ArrowRight, RotateCcw } from 'lucide-react';
import type { assessment } from '@a5/contracts';
import { StatCell, StatRow, StatTile } from '@/components/charts';
import {
  Button,
  Notice,
  PageHeader,
  Panel,
  Section,
  StatusText,
  type Crumb,
  type Tone,
} from '@/components/ui';
import { Markdown } from '@/components/markdown';
import { formatDateTime } from '@/lib/format';
import { cn } from '@/lib/cn';
import {
  CorrectAnswerView,
  correctAnswerLabel,
  lookupFromLearner,
  ResponseView,
  type ChoiceLookup,
} from '../answer-view';
import { attemptsPhrase, formatPoints, formatScore, OUTCOME } from '../labels';
import { useNow } from './use-countdown';

type Result = assessment.AttemptResult;
type LearnerAttempt = assessment.LearnerAttempt;

function verdict(r: Result): { label: string; tone: Tone } | null {
  if (r.status === 'pending_review') return { label: 'Awaiting review', tone: 'warning' };
  if (r.status !== 'graded') return { label: 'Grading', tone: 'information' };
  if (r.passed === true) return { label: 'Passed', tone: 'success' };
  if (r.passed === false) return { label: 'Not passed', tone: 'danger' };
  return null;
}

/** Score against the pass mark on one bar, with the numbers written out for everyone. */
function ScoreMeter({
  score,
  passMark,
  passed,
}: {
  score: number;
  passMark: number;
  passed: boolean | null;
}) {
  const clamp = (n: number) => Math.max(0, Math.min(100, n));
  return (
    <div className="mt-3 w-72 max-w-full">
      <div
        role="img"
        aria-label={`Score ${score}%, pass mark ${passMark}%`}
        className="relative h-2.5 overflow-hidden rounded-full bg-surface-sunken"
      >
        <div
          className={cn('h-full rounded-full', passed ? 'bg-success' : 'bg-text-tertiary')}
          style={{ width: `${clamp(score)}%` }}
        />
        <div
          aria-hidden
          className="absolute inset-y-0 w-0.5 bg-text-primary"
          style={{ left: `calc(${clamp(passMark)}% - 1px)` }}
        />
      </div>
      <div className="tabular mt-1.5 flex justify-between text-xs text-text-tertiary">
        <span>0%</span>
        <span>Pass mark {passMark}%</span>
        <span>100%</span>
      </div>
    </div>
  );
}

function QuestionResult({
  q,
  attemptQuestion,
  lookup,
}: {
  q: Result['questions'][number];
  attemptQuestion: assessment.LearnerQuestion | undefined;
  lookup: ChoiceLookup;
}) {
  const outcome = q.outcome ? OUTCOME[q.outcome] : null;
  return (
    <li className="py-5">
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-2">
        <div className="min-w-0 flex-1">
          <p className="text-sm text-text-tertiary">Question {q.position}</p>
          <div className="mt-0.5 font-medium">
            <Markdown className="[&_p]:mb-2">{q.prompt}</Markdown>
          </div>
        </div>
        <div className="shrink-0 sm:text-right">
          {outcome && <StatusText tone={outcome.tone}>{outcome.label}</StatusText>}
          {q.awardedPoints !== null && (
            <p className="tabular text-sm text-text-secondary">
              {formatPoints(q.awardedPoints)} of {formatPoints(q.points)}{' '}
              {q.points === 1 ? 'point' : 'points'}
            </p>
          )}
        </div>
      </div>

      {attemptQuestion?.type === 'scenario' && (
        <div className="mt-3 rounded-lg border border-border bg-surface-sunken/60 px-4 py-3 text-sm">
          <Markdown className="text-sm [&_p]:mb-2">{attemptQuestion.scenario}</Markdown>
          <div className="mt-1 font-medium">
            <Markdown className="text-sm [&_p]:mb-0">{attemptQuestion.subQuestion.prompt}</Markdown>
          </div>
        </div>
      )}

      <dl className={cn('mt-3 grid gap-4 text-base', q.correctAnswer && 'sm:grid-cols-2')}>
        <div className="min-w-0">
          <dt className="mb-0.5 text-xs font-medium text-text-tertiary">Your answer</dt>
          <dd>
            <ResponseView
              response={q.response}
              lookup={lookup}
              empty="You did not answer this question"
            />
          </dd>
        </div>
        {q.correctAnswer && (
          <div className="min-w-0">
            <dt className="mb-0.5 text-xs font-medium text-text-tertiary">
              {correctAnswerLabel(q.correctAnswer)}
            </dt>
            <dd>
              <CorrectAnswerView correct={q.correctAnswer} lookup={lookup} />
            </dd>
          </div>
        )}
      </dl>

      {q.explanation && (
        <p className="mt-3 max-w-[68ch] text-sm text-text-secondary">
          <span className="font-medium text-text-primary">Why: </span>
          {q.explanation}
        </p>
      )}
      {q.feedback && (
        <Notice className="mt-3" tone="information" title="Feedback from your trainer">
          <span className="whitespace-pre-wrap">{q.feedback}</span>
        </Notice>
      )}
    </li>
  );
}

export function AttemptResultView({
  attempt,
  result,
  crumbs,
  backTo,
  introTo,
  nextLessonTo,
  retaking,
  retakeError,
  onRetake,
}: {
  attempt: LearnerAttempt;
  result: Result;
  crumbs: Crumb[];
  backTo: string;
  /** The assessment overview (rules and attempts), without an attempt selected. */
  introTo: string;
  nextLessonTo: string | null;
  retaking: boolean;
  retakeError: string | null;
  onRetake: () => void;
}) {
  const retakeAt = result.retakeAvailableAt ? new Date(result.retakeAvailableAt).getTime() : null;
  const now = useNow(1_000, retakeAt !== null);
  const retakeReady = retakeAt !== null && now >= retakeAt;
  const v = verdict(result);
  const byId = new Map(attempt.questions.map((q) => [q.id, q]));
  const counts = { correct: 0, partial: 0, incorrect: 0, unanswered: 0, pending_review: 0 };
  for (const q of result.questions) if (q.outcome) counts[q.outcome] += 1;
  const showsOutcomes = result.questions.some((q) => q.outcome !== null);
  const showsDetails = showsOutcomes || result.questions.some((q) => q.correctAnswer !== null);

  return (
    <>
      <PageHeader
        title="Your result"
        description={result.title}
        breadcrumbs={crumbs}
        meta={<span>Attempt {result.attemptNumber}</span>}
      />

      <Panel className="mb-8">
        <div className="flex flex-wrap items-start justify-between gap-x-8 gap-y-6">
          <div className="min-w-0">
            {v && (
              <StatusText tone={v.tone} className="text-md">
                {v.label}
              </StatusText>
            )}
            {result.scoreVisible && result.scorePercent !== null && (
              <>
                <p className="tabular mt-2 text-3xl font-semibold tracking-[-0.01em]">
                  {formatScore(result.scorePercent)}
                </p>
                {result.scorePoints !== null && result.maxPoints !== null && (
                  <p className="tabular text-sm text-text-secondary">
                    {formatPoints(result.scorePoints)} of {formatPoints(result.maxPoints)} points
                  </p>
                )}
                <ScoreMeter
                  score={result.scorePercent}
                  passMark={result.passingPercent}
                  passed={result.passed}
                />
              </>
            )}
            {!result.scoreVisible && (
              <p className="mt-2 text-sm text-text-secondary">Pass mark {result.passingPercent}%</p>
            )}
          </div>

          <div className="flex min-w-0 flex-col items-start gap-3 sm:items-end">
            {result.passed === true && nextLessonTo && (
              <Button
                asChild
                variant="primary"
                size="lg"
                trailing={<ArrowRight className="size-4" />}
              >
                <Link to={nextLessonTo}>Continue to next lesson</Link>
              </Button>
            )}
            {retakeAt !== null && (
              <div className="flex flex-col items-start gap-1.5 sm:items-end">
                <Button
                  variant="primary"
                  size="lg"
                  leading={<RotateCcw className="size-4" />}
                  loading={retaking}
                  disabled={!retakeReady}
                  onClick={onRetake}
                >
                  Try again
                </Button>
                <p className="text-sm text-text-secondary">
                  {attemptsPhrase(result.attemptsRemaining)}
                  {!retakeReady && <> · available at {formatDateTime(result.retakeAvailableAt)}</>}
                </p>
              </div>
            )}
            <div className="flex flex-wrap gap-2">
              <Button asChild>
                <Link to={backTo}>Back to lesson</Link>
              </Button>
              {retakeAt === null && (
                <Button asChild>
                  <Link to={introTo}>All attempts</Link>
                </Button>
              )}
            </div>
          </div>
        </div>

        <p className="mt-5 max-w-[68ch] border-t border-divider pt-4 text-base">{result.message}</p>
        {result.overridden && (
          <Notice className="mt-4" tone="information" title="Score adjusted by a trainer">
            A trainer changed the score for this attempt. The score shown here is the one that
            counts.
          </Notice>
        )}
        {retakeError && (
          <p role="alert" className="mt-4 rounded bg-danger-soft px-3 py-2 text-sm text-danger">
            {retakeError}
          </p>
        )}
      </Panel>

      {showsOutcomes && (
        <StatRow className="mb-8">
          <StatCell>
            <StatTile
              label="Correct"
              value={counts.correct}
              context={`of ${result.questions.length} questions`}
            />
          </StatCell>
          {counts.partial > 0 && (
            <StatCell>
              <StatTile label="Partly correct" value={counts.partial} />
            </StatCell>
          )}
          <StatCell>
            <StatTile label="Incorrect" value={counts.incorrect} />
          </StatCell>
          {counts.unanswered > 0 && (
            <StatCell>
              <StatTile label="Not answered" value={counts.unanswered} />
            </StatCell>
          )}
          {counts.pending_review > 0 && (
            <StatCell>
              <StatTile label="Awaiting review" value={counts.pending_review} />
            </StatCell>
          )}
        </StatRow>
      )}

      {showsDetails ? (
        <Section
          title="Your answers"
          description={
            result.answersRevealed
              ? undefined
              : 'Correct answers are not shown for this assessment.'
          }
        >
          <ol
            aria-label="Question results"
            className="divide-y divide-divider border-y border-divider"
          >
            {result.questions.map((q) => {
              const aq = byId.get(q.attemptQuestionId);
              return (
                <QuestionResult
                  key={q.attemptQuestionId}
                  q={q}
                  attemptQuestion={aq}
                  lookup={
                    aq
                      ? lookupFromLearner(aq)
                      : { options: {}, items: {}, prompts: {}, choices: {} }
                  }
                />
              );
            })}
          </ol>
        </Section>
      ) : (
        <Notice tone="information" title="Your answers were submitted">
          This assessment does not show question-by-question results.
        </Notice>
      )}
    </>
  );
}
