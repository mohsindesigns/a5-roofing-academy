import { useId, useState } from 'react';
import { Link } from 'react-router';
import type { assessment } from '@a5/contracts';
import { Button, EmptyState, ErrorState, Notice, Skeleton, StatusText, Tag } from '@/components/ui';
import { Markdown } from '@/components/markdown';
import { errorMessage } from '@/lib/api/errors';
import { formatDateTime } from '@/lib/format';
import { CorrectAnswerView, correctAnswerLabel, lookupFromLearner } from '../answer-view';
import { useCheckAnswer, useQuestionPreview, useQuestionVersions } from '../api';
import { QuestionInput } from '../learner/question-inputs';
import { isAnswered, type Answer } from '../learner/quiz-state';
import {
  ASSESSMENT_STATUS,
  DIFFICULTY_LABELS,
  KIND_LABELS,
  OUTCOME,
  formatPoints,
} from '../labels';

/** The question as a learner sees it, with a way to try an answer and see how it would be marked. */
export function PreviewPanel({
  questionId,
  versionId,
}: {
  questionId: string;
  versionId?: string;
}) {
  const preview = useQuestionPreview(questionId, versionId);
  const check = useCheckAnswer(questionId);
  const [value, setValue] = useState<Answer | null>(null);
  const promptId = useId();
  if (preview.isPending) return <Skeleton className="h-64 w-full" />;
  if (preview.isError)
    return <ErrorState message={errorMessage(preview.error)} onRetry={() => preview.refetch()} />;
  const p = preview.data;
  const result = check.data;
  return (
    <div className="max-w-3xl">
      <p className="mb-4 text-sm text-text-secondary">
        This is version {p.version}, drawn the way a learner would see it. Answer it to see how it
        would be marked. Nothing is saved.
      </p>
      <section
        className="rounded-lg border border-border bg-surface p-4 sm:p-6"
        aria-label="Learner view"
      >
        <div id={promptId} className="mb-4 text-md font-medium">
          <Markdown className="text-md [&_p]:mb-2">{p.question.prompt}</Markdown>
        </div>
        <QuestionInput
          key={p.versionId}
          question={p.question}
          promptId={promptId}
          value={value}
          disabled={check.isPending}
          onChange={(v) => {
            setValue(v);
            if (check.data) check.reset();
          }}
        />
        <div className="mt-5 flex flex-wrap items-center gap-2">
          <Button
            variant="primary"
            disabled={!isAnswered(value)}
            loading={check.isPending}
            onClick={() => value && check.mutate({ response: value, versionId: p.versionId })}
          >
            Check my answer
          </Button>
          <Button
            onClick={() => {
              setValue(null);
              check.reset();
            }}
          >
            Clear
          </Button>
        </div>
        {check.isError && (
          <p role="alert" className="mt-3 rounded bg-danger-soft px-3 py-2 text-sm text-danger">
            {errorMessage(check.error)}
          </p>
        )}
        {result && (
          <div className="mt-5 border-t border-divider pt-4" aria-live="polite">
            <p className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <StatusText tone={OUTCOME[result.outcome].tone}>
                {OUTCOME[result.outcome].label}
              </StatusText>
              {result.awardedPoints !== null && (
                <span className="tabular text-sm text-text-secondary">
                  {formatPoints(result.awardedPoints)} of {formatPoints(result.points)} points
                </span>
              )}
            </p>
            {result.outcome === 'pending_review' && (
              <p className="mt-1 text-sm text-text-secondary">
                A trainer scores written answers, so there is no automatic mark.
              </p>
            )}
            <div className="mt-3">
              <p className="mb-0.5 text-xs font-medium text-text-tertiary">
                {correctAnswerLabel(result.correctAnswer)}
              </p>
              <CorrectAnswerView
                correct={result.correctAnswer}
                lookup={lookupFromLearner(p.question)}
              />
            </div>
            {result.explanation && (
              <p className="mt-3 max-w-[68ch] text-sm text-text-secondary">{result.explanation}</p>
            )}
          </div>
        )}
      </section>
    </div>
  );
}

/** Every saved version, newest first. Versions are immutable; "Start from this version" copies one into the editor. */
export function VersionsPanel({
  questionId,
  currentVersionId,
  canEdit,
  onPreview,
  onStartFrom,
}: {
  questionId: string;
  currentVersionId: string;
  canEdit: boolean;
  onPreview: (version: assessment.QuestionVersion) => void;
  onStartFrom: (version: assessment.QuestionVersion) => void;
}) {
  const versions = useQuestionVersions(questionId);
  if (versions.isPending) return <Skeleton className="h-48 w-full" />;
  if (versions.isError)
    return <ErrorState message={errorMessage(versions.error)} onRetry={() => versions.refetch()} />;
  return (
    <div className="max-w-3xl">
      <p className="mb-4 text-sm text-text-secondary">
        Each save creates a new version. Attempts keep the version they were given, so editing a
        question never changes a past result.
      </p>
      <ol aria-label="Versions" className="divide-y divide-divider border-y border-divider">
        {versions.data.items.map((v) => {
          const current = v.id === currentVersionId;
          return (
            <li key={v.id} className="py-4">
              <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
                <p className="flex items-center gap-2 font-medium">
                  Version {v.version}
                  {current && <Tag tone="success">Current</Tag>}
                </p>
                <div className="flex gap-2">
                  <Button size="sm" onClick={() => onPreview(v)}>
                    Preview
                  </Button>
                  {canEdit && !current && (
                    <Button size="sm" onClick={() => onStartFrom(v)}>
                      Start from this version
                    </Button>
                  )}
                </div>
              </div>
              <p className="mt-0.5 text-sm text-text-secondary">
                {formatDateTime(v.createdAt)}
                {v.createdBy ? ` by ${v.createdBy.displayName}` : ''}
              </p>
              {v.changeNote && <p className="mt-1 text-sm">{v.changeNote}</p>}
              <p className="mt-1 line-clamp-2 text-sm text-text-tertiary">
                {v.prompt} · <span className="tabular">{formatPoints(v.points)}</span>{' '}
                {v.points === 1 ? 'point' : 'points'} · {DIFFICULTY_LABELS[v.difficulty]}
              </p>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/** Where a question is used, so authors know what an edit affects. */
export function UsagePanel({ question }: { question: assessment.QuestionDetail }) {
  return (
    <div className="max-w-3xl">
      <p className="mb-4 text-sm text-text-secondary">
        This question has been given in {question.attemptCount}{' '}
        {question.attemptCount === 1 ? 'attempt' : 'attempts'} across all of its versions.
      </p>
      {question.usage.length === 0 ? (
        <EmptyState
          title="Not in any assessment yet"
          description="Add it to an assessment from the assessment builder. Random draws may still pick it from the bank."
        />
      ) : (
        <>
          <Notice tone="information" className="mb-4">
            Assessments that include this question directly. Random draws that pick from its bank
            are not listed.
          </Notice>
          <ul className="divide-y divide-divider overflow-hidden rounded-lg border border-border bg-surface">
            {question.usage.map((u) => (
              <li
                key={u.assessmentId}
                className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
              >
                <div className="min-w-0">
                  <Link
                    to={`/content/assessments/${u.assessmentId}`}
                    className="font-medium hover:underline"
                  >
                    {u.title}
                  </Link>
                  <p className="text-sm text-text-secondary">{KIND_LABELS[u.kind]}</p>
                </div>
                <StatusText tone={ASSESSMENT_STATUS[u.status].tone}>
                  {ASSESSMENT_STATUS[u.status].label}
                </StatusText>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
