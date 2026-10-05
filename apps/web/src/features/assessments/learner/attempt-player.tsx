import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ArrowRight, Check, CircleAlert, Clock, ListChecks } from 'lucide-react';
import type { assessment } from '@a5/contracts';
import {
  Button,
  DialogContent,
  DialogRoot,
  Notice,
  PageHeader,
  ProgressBar,
  Spinner,
  type Crumb,
} from '@/components/ui';
import { Markdown } from '@/components/markdown';
import { errorMessage } from '@/lib/api/errors';
import { cn } from '@/lib/cn';
import { assessmentKeys, saveAnswer, useSubmitAttempt } from '../api';
import { formatClockTime, formatPoints } from '../labels';
import { AutosaveQueue, classifySaveError, type AutosaveSnapshot } from './autosave';
import { QuestionInput, questionHint, type ChangeOptions } from './question-inputs';
import {
  countAnswered,
  initialAnswers,
  isAnswered,
  responseProblem,
  unansweredIndexes,
  type Answer,
  type Answers,
  type Question,
} from './quiz-state';
import { useServerCountdown } from './use-countdown';

/** Seconds left at which the timer changes colour and is announced to screen readers. */
const WARN_AT = 300;
const URGENT_AT = 60;

function SaveStatus({ snapshot }: { snapshot: AutosaveSnapshot }) {
  const { status } = snapshot;
  let content: React.ReactNode;
  if (status === 'failed') {
    content = (
      <span className="inline-flex items-center gap-1.5 font-medium text-danger">
        <CircleAlert aria-hidden className="size-4" /> Some answers are not saved
      </span>
    );
  } else if (status === 'retrying') {
    content = (
      <span className="inline-flex items-center gap-1.5 font-medium text-warning">
        <CircleAlert aria-hidden className="size-4" /> Not saved yet. Retrying
      </span>
    );
  } else if (status === 'saving' || status === 'dirty') {
    content = (
      <span className="inline-flex items-center gap-1.5 text-text-secondary">
        <Spinner size={14} /> Saving
      </span>
    );
  } else if (snapshot.lastSavedAt !== null) {
    content = (
      <span className="inline-flex items-center gap-1.5 text-text-secondary">
        <Check aria-hidden className="size-4 text-success" /> Saved
      </span>
    );
  } else {
    content = <span className="text-text-tertiary">Answers save as you go</span>;
  }
  return (
    <p className="text-sm" data-save-status={status}>
      {content}
    </p>
  );
}

function Timer({ seconds }: { seconds: number }) {
  const tone =
    seconds <= URGENT_AT
      ? 'text-danger'
      : seconds <= WARN_AT
        ? 'text-warning'
        : 'text-text-primary';
  return (
    <div className="flex items-center gap-2">
      <Clock aria-hidden className={cn('size-4', tone)} />
      <span
        role="timer"
        aria-label="Time remaining"
        className={cn('tabular text-lg font-semibold', tone)}
      >
        {formatClockTime(seconds)}
      </span>
      <span className="text-sm text-text-tertiary">left</span>
    </div>
  );
}

function Navigator({
  questions,
  answers,
  index,
  errors,
  onGo,
}: {
  questions: readonly Question[];
  answers: Answers;
  index: number;
  errors: Record<string, string>;
  onGo: (i: number) => void;
}) {
  return (
    <nav aria-label="Questions">
      <ol className="grid grid-cols-6 gap-1.5 sm:grid-cols-8 lg:grid-cols-5">
        {questions.map((q, i) => {
          const answered = isAnswered(answers[q.id]);
          const flagged = Boolean(errors[q.id]);
          return (
            <li key={q.id}>
              <button
                type="button"
                onClick={() => onGo(i)}
                aria-current={i === index ? 'step' : undefined}
                aria-label={`Question ${i + 1}, ${flagged ? 'needs attention' : answered ? 'answered' : 'not answered'}`}
                className={cn(
                  'tabular flex h-9 w-full items-center justify-center rounded border text-sm font-medium transition-colors',
                  flagged
                    ? 'border-danger bg-danger-soft text-danger'
                    : answered
                      ? 'border-brand-primary bg-brand-primary text-text-inverse'
                      : 'border-border-strong bg-surface text-text-primary hover:bg-surface-hover',
                  i === index && 'ring-2 ring-focus ring-offset-2 ring-offset-background',
                )}
              >
                {i + 1}
              </button>
            </li>
          );
        })}
      </ol>
      <p className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-text-tertiary">
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden className="size-3 rounded-sm bg-brand-primary" /> Answered
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden className="size-3 rounded-sm border border-border-strong bg-surface" />{' '}
          Not answered
        </span>
      </p>
    </nav>
  );
}

function SubmitDialog({
  open,
  onOpenChange,
  questions,
  answers,
  problems,
  busy,
  error,
  onSubmit,
  onGo,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  questions: readonly Question[];
  answers: Answers;
  problems: Record<string, string>;
  busy: boolean;
  error: string | null;
  onSubmit: () => void;
  onGo: (i: number) => void;
}) {
  const total = questions.length;
  const answered = countAnswered(questions, answers);
  const missing = unansweredIndexes(questions, answers);
  const blocked = questions.map((q, i) => ({ q, i })).filter(({ q }) => problems[q.id]);
  return (
    <DialogRoot open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent
        title="Submit your answers?"
        description={`You have answered ${answered} of ${total} ${total === 1 ? 'question' : 'questions'}. You cannot change your answers after you submit.`}
        dismissible={!busy}
        footer={
          <>
            <Button onClick={() => onOpenChange(false)} disabled={busy}>
              Keep working
            </Button>
            <Button
              variant="primary"
              loading={busy}
              disabled={blocked.length > 0}
              onClick={onSubmit}
            >
              Submit answers
            </Button>
          </>
        }
      >
        <div className="grid gap-4">
          {missing.length > 0 && (
            <div>
              <p className="text-sm font-medium">Not answered yet</p>
              <ul className="mt-2 flex flex-wrap gap-2">
                {missing.map((i) => (
                  <li key={i}>
                    <Button
                      size="sm"
                      onClick={() => {
                        onOpenChange(false);
                        onGo(i);
                      }}
                    >
                      Question {i + 1}
                    </Button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {blocked.length > 0 && (
            <Notice tone="warning" title="Fix these before you submit">
              <ul className="mt-1 grid gap-1">
                {blocked.map(({ q, i }) => (
                  <li key={q.id}>
                    Question {i + 1}: {problems[q.id]}
                  </li>
                ))}
              </ul>
            </Notice>
          )}
          {error && (
            <p role="alert" className="rounded bg-danger-soft px-3 py-2 text-sm text-danger">
              {error}
            </p>
          )}
        </div>
      </DialogContent>
    </DialogRoot>
  );
}

export function AttemptPlayer({
  attempt,
  crumbs,
}: {
  attempt: assessment.LearnerAttempt;
  crumbs: Crumb[];
}) {
  const qc = useQueryClient();
  const submit = useSubmitAttempt();
  const questions = attempt.questions;
  const total = questions.length;

  const [answers, setAnswers] = useState<Answers>(() => initialAnswers(questions));
  const [index, setIndex] = useState(
    () => unansweredIndexes(questions, initialAnswers(questions))[0] ?? 0,
  );
  const [reviewOpen, setReviewOpen] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [timedOut, setTimedOut] = useState(false);
  const [announcement, setAnnouncement] = useState('');

  // The countdown is created before the queue so saves can re-sync it with the server's clock.
  const syncRef = useRef<(seconds: number | null) => void>(() => undefined);
  const [queue] = useState(
    () =>
      new AutosaveQueue({
        save: (questionId, response, sequence) =>
          saveAnswer(attempt.id, questionId, { response, clientSequence: sequence }),
        classify: classifySaveError,
        onSaved: (_id, result) => syncRef.current(result.timeRemainingSeconds),
        onClosed: () => void qc.invalidateQueries({ queryKey: assessmentKeys.attempt(attempt.id) }),
      }),
  );
  const snapshot = useSyncExternalStore(queue.subscribe, queue.getSnapshot);

  const finish = useCallback(
    async (auto: boolean) => {
      setSubmitError(null);
      setSubmitting(true);
      try {
        const unsaved = await queue.flush();
        if (unsaved.length > 0 && !auto) {
          setSubmitError('Some answers could not be saved. Check your connection and try again.');
          return;
        }
        await submit.mutateAsync(attempt.id);
      } catch (err) {
        setSubmitError(errorMessage(err));
      } finally {
        setSubmitting(false);
      }
    },
    [queue, submit, attempt.id],
  );

  const countdown = useServerCountdown(attempt.timeRemainingSeconds, () => {
    setTimedOut(true);
    setReviewOpen(false);
    void finish(true);
  });
  useEffect(() => {
    syncRef.current = countdown.sync;
  }, [countdown.sync]);

  // Send what is waiting when the learner leaves, and keep the queue quiet afterwards.
  useEffect(() => {
    queue.setActive(true);
    const flushNow = () => void queue.flush();
    const onVisibility = () => document.visibilityState === 'hidden' && flushNow();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      flushNow();
      queue.setActive(false);
    };
  }, [queue]);

  const unsavedWork = snapshot.status !== 'idle';
  useEffect(() => {
    if (!unsavedWork) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [unsavedWork]);

  // Announce the clock only at a few moments; announcing every second would drown the question.
  const announced = useRef(new Set<number>());
  useEffect(() => {
    const left = countdown.remaining;
    if (left === null || left === 0) return;
    for (const mark of [WARN_AT, URGENT_AT]) {
      if (left <= mark && !announced.current.has(mark) && (attempt.timeLimitSeconds ?? 0) > mark) {
        announced.current.add(mark);
        setAnnouncement(
          mark >= 120 ? `${Math.round(mark / 60)} minutes left.` : `${mark} seconds left.`,
        );
      }
    }
  }, [countdown.remaining, attempt.timeLimitSeconds]);

  // Move focus to the question heading when the question changes, so screen readers announce it.
  const headingRef = useRef<HTMLHeadingElement>(null);
  const shownIndex = useRef(index);
  useEffect(() => {
    if (shownIndex.current === index) return;
    shownIndex.current = index;
    headingRef.current?.focus();
  }, [index]);

  const change = useCallback(
    (q: Question, value: Answer | null, options?: ChangeOptions) => {
      setAnswers((a) => ({ ...a, [q.id]: value }));
      // An answer the server is certain to refuse stays on screen with an explanation.
      if (responseProblem(q, value)) return;
      queue.set(q.id, value, options);
    },
    [queue],
  );

  const problems = useMemo(() => {
    const out: Record<string, string> = {};
    for (const q of questions) {
      const local = responseProblem(q, answers[q.id] ?? null);
      if (local) out[q.id] = local;
    }
    return out;
  }, [questions, answers]);
  const visibleProblems = useMemo(
    () => ({ ...snapshot.errors, ...problems }),
    [snapshot.errors, problems],
  );

  const question = questions[index];
  const answered = countAnswered(questions, answers);
  const promptId = useId();
  const go = (i: number) => {
    setIndex(Math.min(Math.max(i, 0), total - 1));
    setPanelOpen(false);
  };

  if (!question) {
    return (
      <>
        <PageHeader title={attempt.title} breadcrumbs={crumbs} />
        <Notice tone="warning" title="This attempt has no questions">
          Contact your training administrator. Your attempt has not been affected.
        </Notice>
      </>
    );
  }
  const last = index === total - 1;

  return (
    <>
      <PageHeader
        title={attempt.title}
        breadcrumbs={crumbs}
        meta={
          <>
            <span>Attempt {attempt.attemptNumber}</span>
            <span>Pass mark {attempt.passingPercent}%</span>
            {attempt.resumed && <span>Resumed where you left off</span>}
          </>
        }
        className="mb-4 lg:mb-6"
      />

      <div className="grid gap-x-8 gap-y-4 lg:grid-cols-[minmax(0,1fr)_280px] lg:items-start">
        <div className="order-3 min-w-0 lg:order-none lg:col-start-1 lg:row-start-1">
          <section
            aria-labelledby={`${promptId}-heading`}
            className="rounded-lg border border-border bg-surface p-4 sm:p-6"
          >
            <div className="mb-4 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
              <h2
                id={`${promptId}-heading`}
                ref={headingRef}
                tabIndex={-1}
                className="text-sm font-semibold text-text-secondary outline-none"
              >
                Question {index + 1} of {total}
              </h2>
              <p className="tabular text-sm text-text-tertiary">
                {formatPoints(question.points)} {question.points === 1 ? 'point' : 'points'}
              </p>
            </div>
            <div id={promptId} className="mb-1 text-md font-medium">
              <Markdown className="text-md [&_p]:mb-2">{question.prompt}</Markdown>
            </div>
            <p className="mb-4 text-sm text-text-secondary">{questionHint(question)}</p>
            <QuestionInput
              key={question.id}
              question={question}
              promptId={promptId}
              value={answers[question.id] ?? null}
              problem={visibleProblems[question.id] ?? null}
              disabled={timedOut || submitting}
              onChange={(value, options) => change(question, value, options)}
            />
          </section>

          <div className="sticky bottom-16 z-20 -mx-4 mt-4 border-t border-border bg-background/95 px-4 py-3 backdrop-blur lg:static lg:mx-0 lg:border-0 lg:bg-transparent lg:p-0 lg:backdrop-blur-none">
            <div className="flex items-center justify-between gap-3">
              <Button
                onClick={() => go(index - 1)}
                disabled={index === 0}
                leading={<ArrowLeft className="size-4" />}
              >
                Previous
              </Button>
              <SaveStatus snapshot={snapshot} />
              {last ? (
                <Button
                  variant="primary"
                  onClick={() => setReviewOpen(true)}
                  trailing={<ListChecks className="size-4" />}
                >
                  Review and submit
                </Button>
              ) : (
                <Button
                  variant="primary"
                  onClick={() => go(index + 1)}
                  trailing={<ArrowRight className="size-4" />}
                >
                  Next
                </Button>
              )}
            </div>
          </div>
        </div>

        <div className="contents lg:block lg:col-start-2 lg:row-start-1 lg:sticky lg:top-6">
          <div className="sticky top-14 z-20 order-1 -mx-4 border-b border-border bg-background/95 px-4 py-3 backdrop-blur lg:static lg:order-none lg:mx-0 lg:rounded-lg lg:border lg:bg-surface lg:p-4 lg:backdrop-blur-none">
            <div className="flex items-center justify-between gap-4">
              {countdown.remaining !== null ? (
                <Timer seconds={countdown.remaining} />
              ) : (
                <p className="text-sm text-text-secondary">No time limit</p>
              )}
              <button
                type="button"
                className="inline-flex h-8 items-center gap-1.5 rounded border border-border-strong bg-surface px-2.5 text-sm font-medium lg:hidden"
                aria-expanded={panelOpen}
                aria-controls="attempt-questions"
                onClick={() => setPanelOpen((o) => !o)}
              >
                <ListChecks aria-hidden className="size-4" /> Questions
              </button>
            </div>
            <div className="mt-3">
              <ProgressBar
                value={total ? (answered / total) * 100 : 0}
                label={`${answered} of ${total} questions answered`}
                size="md"
                tone={answered === total ? 'success' : 'accent'}
              />
              <p className="tabular mt-1.5 text-xs text-text-secondary">
                {answered} of {total} answered
              </p>
            </div>
          </div>

          <div
            id="attempt-questions"
            className={cn(
              'order-2 rounded-lg border border-border bg-surface p-4 lg:order-none lg:mt-4 lg:block',
              panelOpen ? 'block' : 'hidden',
            )}
          >
            <Navigator
              questions={questions}
              answers={answers}
              index={index}
              errors={visibleProblems}
              onGo={go}
            />
            <Button variant="secondary" block className="mt-4" onClick={() => setReviewOpen(true)}>
              Submit answers
            </Button>
          </div>
        </div>
      </div>

      <SubmitDialog
        open={reviewOpen}
        onOpenChange={setReviewOpen}
        questions={questions}
        answers={answers}
        problems={problems}
        busy={submitting}
        error={submitError}
        onSubmit={() => void finish(false)}
        onGo={go}
      />

      <DialogRoot open={timedOut}>
        <DialogContent
          title="Time is up"
          description="Your saved answers are being submitted."
          dismissible={false}
          footer={
            submitError ? (
              <Button variant="primary" loading={submitting} onClick={() => void finish(true)}>
                Try again
              </Button>
            ) : undefined
          }
        >
          {submitError ? (
            <p role="alert" className="rounded bg-danger-soft px-3 py-2 text-sm text-danger">
              {submitError}
            </p>
          ) : (
            <p className="flex items-center gap-2 text-sm text-text-secondary">
              <Spinner size={16} /> Submitting
            </p>
          )}
        </DialogContent>
      </DialogRoot>

      <p role="status" className="sr-only">
        {announcement}
        {snapshot.status === 'retrying' && 'Your latest answer is not saved yet. Retrying.'}
        {snapshot.status === 'failed' &&
          'Some answers could not be saved. Check the highlighted questions.'}
      </p>
    </>
  );
}
