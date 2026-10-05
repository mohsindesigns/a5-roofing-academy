import { useEffect } from 'react';
import { Link } from 'react-router';
import { Play } from 'lucide-react';
import type { assessment } from '@a5/contracts';
import {
  Button,
  DescriptionList,
  ErrorState,
  Notice,
  PageHeader,
  Section,
  Skeleton,
  StatusText,
  Table,
  TBody,
  Td,
  Th,
  THead,
  Tr,
  type Crumb,
} from '@/components/ui';
import { ApiError, errorMessage } from '@/lib/api/errors';
import { formatDateTime, formatRelative } from '@/lib/format';
import { attemptsPhrase, formatDuration, formatScore, KIND_LABELS } from '../labels';
import { useNow } from './use-countdown';

type Intro = assessment.AssessmentIntro;

const REVEAL_SUMMARY: Record<assessment.RevealPolicy, string> = {
  never: 'Not shown',
  after_submit: 'Shown after you submit',
  after_pass: 'Shown once you pass',
  after_final_attempt: 'Shown after your last attempt',
};

export function attemptResultLabel(a: assessment.LearnerAttemptSummary): {
  label: string;
  tone: 'success' | 'danger' | 'warning' | 'information' | 'neutral';
} {
  if (a.status === 'in_progress') return { label: 'In progress', tone: 'information' };
  if (a.status === 'pending_review') return { label: 'Awaiting review', tone: 'warning' };
  if (a.status === 'submitted' || a.status === 'expired')
    return { label: 'Grading', tone: 'information' };
  if (a.passed === true) return { label: 'Passed', tone: 'success' };
  if (a.passed === false) return { label: 'Not passed', tone: 'danger' };
  return { label: 'Graded', tone: 'neutral' };
}

function Rules({ intro }: { intro: Intro }) {
  const a = intro.assessment;
  return (
    <DescriptionList
      columns={1}
      items={[
        { label: 'Questions', value: a.questionCount },
        { label: 'Pass mark', value: `${a.passingPercent}%` },
        {
          label: 'Time limit',
          value: a.timeLimitSeconds === null ? 'No time limit' : formatDuration(a.timeLimitSeconds),
        },
        {
          label: 'Attempts',
          value:
            a.maxAttempts === null ? 'Unlimited' : `${intro.attemptsUsed} of ${a.maxAttempts} used`,
        },
        { label: 'Your score after grading', value: a.revealScore ? 'Shown' : 'Not shown' },
        { label: 'Correct answers', value: REVEAL_SUMMARY[a.revealCorrectAnswers] },
      ]}
    />
  );
}

function History({ intro, onOpen }: { intro: Intro; onOpen: (attemptId: string) => void }) {
  if (intro.attempts.length === 0) return null;
  return (
    <Section title="Your attempts">
      <Table caption="Your attempts">
        <THead>
          <tr>
            <Th>Attempt</Th>
            <Th className="hidden sm:table-cell">Started</Th>
            <Th>Result</Th>
            <Th className="text-right">Score</Th>
            <Th>
              <span className="sr-only">Actions</span>
            </Th>
          </tr>
        </THead>
        <TBody>
          {intro.attempts.map((a) => {
            const r = attemptResultLabel(a);
            return (
              <Tr key={a.id}>
                <Td className="tabular font-medium">{a.attemptNumber}</Td>
                <Td className="hidden text-text-secondary sm:table-cell">
                  {formatDateTime(a.startedAt)}
                </Td>
                <Td>
                  <StatusText tone={r.tone}>{r.label}</StatusText>
                </Td>
                <Td className="tabular text-right">
                  {a.status === 'in_progress' ? '—' : formatScore(a.scorePercent)}
                </Td>
                <Td className="text-right">
                  <Button size="sm" onClick={() => onOpen(a.id)}>
                    {a.status === 'in_progress' ? 'Resume' : 'View result'}
                  </Button>
                </Td>
              </Tr>
            );
          })}
        </TBody>
      </Table>
    </Section>
  );
}

export function AssessmentIntroView({
  intro,
  crumbs,
  starting,
  startError,
  onStart,
  onOpen,
  onRefresh,
  backTo,
}: {
  intro: Intro;
  crumbs: Crumb[];
  starting: boolean;
  startError: string | null;
  onStart: () => void;
  onOpen: (attemptId: string) => void;
  /** Re-read the intro, e.g. when a cooldown has ended. */
  onRefresh: () => void;
  backTo: string;
}) {
  const a = intro.assessment;
  const open = intro.inProgressAttempt;
  const cooldownMs = intro.cooldownUntil ? new Date(intro.cooldownUntil).getTime() : null;
  const now = useNow(1_000, cooldownMs !== null);

  // When a cooldown ends, ask the server again instead of trusting the local clock.
  const cooldownOver = cooldownMs !== null && now >= cooldownMs;
  useEffect(() => {
    if (cooldownOver) onRefresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cooldownOver]);

  const blocked = !open && !intro.canStart;
  const used = intro.attemptsUsed > 0;
  return (
    <>
      <PageHeader
        title={a.title}
        description={a.description ?? undefined}
        breadcrumbs={crumbs}
        meta={
          <>
            <span>{KIND_LABELS[a.kind]}</span>
            <span>{a.questionCount} questions</span>
          </>
        }
      />
      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_300px]">
        <div className="grid min-w-0 content-start gap-6">
          {intro.passed && (
            <Notice tone="success" title="You have passed">
              {intro.bestScorePercent !== null
                ? `Your best score is ${formatScore(intro.bestScorePercent)}. `
                : ''}
              Passing counts toward your training progress. You can continue to the next lesson.
            </Notice>
          )}

          {open && (
            <Notice tone="information" title={`Attempt ${open.attemptNumber} is in progress`}>
              Started {formatRelative(open.startedAt)}.{' '}
              {open.expiresAt
                ? `The timer ends at ${formatDateTime(open.expiresAt)} whether or not this page is open.`
                : 'Your saved answers are kept.'}
            </Notice>
          )}

          {blocked && intro.blockedReason && (
            <Notice
              tone="warning"
              title={
                intro.blockedReason.code === 'COOLDOWN_ACTIVE'
                  ? 'Please wait before your next attempt'
                  : 'You cannot start an attempt right now'
              }
            >
              {intro.blockedReason.message}
              {intro.cooldownUntil && intro.blockedReason.code === 'COOLDOWN_ACTIVE' && (
                <> Available at {formatDateTime(intro.cooldownUntil)}.</>
              )}
            </Notice>
          )}

          {startError && (
            <p role="alert" className="rounded bg-danger-soft px-3 py-2 text-sm text-danger">
              {startError}
            </p>
          )}

          <div className="flex flex-wrap items-center gap-3">
            {open ? (
              <Button
                variant="primary"
                size="lg"
                leading={<Play className="size-4" />}
                onClick={() => onOpen(open.id)}
              >
                Resume attempt {open.attemptNumber}
              </Button>
            ) : (
              <Button
                variant="primary"
                size="lg"
                leading={<Play className="size-4" />}
                loading={starting}
                disabled={!intro.canStart}
                onClick={onStart}
              >
                {used ? 'Start another attempt' : 'Start attempt'}
              </Button>
            )}
            <Button asChild size="lg" variant="secondary">
              <Link to={backTo}>Back to lesson</Link>
            </Button>
            {!open && intro.canStart && (
              <p className="text-sm text-text-secondary">
                {a.maxAttempts === null
                  ? 'You can retake this as often as you like.'
                  : `${attemptsPhrase(intro.attemptsRemaining)}.`}
              </p>
            )}
          </div>

          <Section title="How it works">
            <ul className="grid max-w-[68ch] list-disc gap-1.5 pl-5 text-base text-text-secondary">
              <li>
                Your answers save automatically as you go. You can move between questions freely
                before you submit.
              </li>
              {a.timeLimitSeconds !== null && (
                <li>
                  You have {formatDuration(a.timeLimitSeconds)}. The timer starts when you begin and
                  keeps running if you leave. When it ends, your saved answers are submitted for
                  you.
                </li>
              )}
              <li>If you leave and come back, you can resume the attempt where you stopped.</li>
              <li>
                You will be asked to confirm before you submit, and you cannot change answers
                afterwards.
              </li>
            </ul>
          </Section>

          <History intro={intro} onOpen={onOpen} />
        </div>

        <aside className="lg:sticky lg:top-6 lg:self-start">
          <div className="rounded-lg border border-border bg-surface p-5">
            <h2 className="mb-4 text-md font-semibold">Before you begin</h2>
            <Rules intro={intro} />
          </div>
        </aside>
      </div>
    </>
  );
}

export function IntroSkeleton() {
  return (
    <div className="grid gap-4" aria-busy="true" aria-label="Loading assessment">
      <Skeleton className="h-7 w-72" />
      <Skeleton className="h-4 w-96 max-w-full" />
      <Skeleton className="mt-4 h-40 w-full" />
    </div>
  );
}

export function IntroError({ error, onReload }: { error: unknown; onReload: () => void }) {
  const grant =
    error instanceof ApiError &&
    (error.code === 'GRANT_EXPIRED' ||
      error.code === 'GRANT_INVALID' ||
      error.code === 'GRANT_MISMATCH');
  return (
    <ErrorState
      title={grant ? 'This lesson link needs refreshing' : 'The assessment could not be loaded'}
      message={errorMessage(error)}
      onRetry={onReload}
    />
  );
}
