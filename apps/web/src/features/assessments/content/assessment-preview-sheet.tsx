import { useEffect } from 'react';
import { assessment } from '@a5/contracts';
import { DialogRoot, ErrorState, Notice, SheetContent, Skeleton, Tag } from '@/components/ui';
import { Markdown } from '@/components/markdown';
import { errorMessage } from '@/lib/api/errors';
import { CorrectAnswerView, lookupFromLearner } from '../answer-view';
import { usePreviewAssessment } from '../api';
import { DIFFICULTY_LABELS, formatPoints } from '../labels';

/** A sample draw of the assessment with its answer key. Nothing is stored and no attempt is started. */
export function AssessmentPreviewSheet({
  assessmentId,
  open,
  onOpenChange,
}: {
  assessmentId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const preview = usePreviewAssessment(assessmentId);
  const { mutate, isIdle } = preview;
  useEffect(() => {
    if (open && isIdle) mutate();
  }, [open, isIdle, mutate]);

  return (
    <DialogRoot
      open={open}
      onOpenChange={(o) => {
        if (!o) preview.reset();
        onOpenChange(o);
      }}
    >
      <SheetContent
        title="Sample attempt"
        description="One possible draw, shown with the answer key. Random draws pick different questions for each learner."
      >
        {preview.isError ? (
          <ErrorState
            title="The preview could not be drawn"
            message={errorMessage(preview.error)}
            onRetry={() => preview.mutate()}
          />
        ) : !preview.data ? (
          <div className="grid gap-3" aria-busy="true" aria-label="Drawing a sample attempt">
            <Skeleton className="h-5 w-48" />
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-24 w-full" />
          </div>
        ) : (
          <div>
            <p className="tabular mb-4 text-sm text-text-secondary">
              {preview.data.questionCount}{' '}
              {preview.data.questionCount === 1 ? 'question' : 'questions'} ·{' '}
              {formatPoints(preview.data.totalPoints)} points in total
            </p>
            <ol className="divide-y divide-divider border-y border-divider">
              {preview.data.questions.map((q) => (
                <li key={q.itemId + q.position} className="py-4">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-text-secondary">
                    <span className="tabular font-medium text-text-primary">
                      Question {q.position}
                    </span>
                    <span>{assessment.QUESTION_TYPE_LABELS[q.question.type]}</span>
                    <span>· {DIFFICULTY_LABELS[q.difficulty]}</span>
                    <span>· {q.category?.name ?? 'No category'}</span>
                    <span className="tabular">
                      · {formatPoints(q.question.points)}{' '}
                      {q.question.points === 1 ? 'point' : 'points'}
                    </span>
                    {q.source === 'pool' && <Tag>Random draw</Tag>}
                  </div>
                  <div className="mt-1 font-medium">
                    <Markdown className="[&_p]:mb-2">{q.question.prompt}</Markdown>
                  </div>
                  {q.question.type === 'scenario' && (
                    <div className="mt-2 rounded-lg border border-border bg-surface-sunken/60 px-4 py-3 text-sm">
                      <Markdown className="text-sm [&_p]:mb-2">{q.question.scenario}</Markdown>
                      <p className="font-medium">{q.question.subQuestion.prompt}</p>
                    </div>
                  )}
                  <div className="mt-2">
                    <p className="mb-0.5 text-xs font-medium text-text-tertiary">Correct answer</p>
                    <CorrectAnswerView
                      correct={q.correctAnswer}
                      lookup={lookupFromLearner(q.question)}
                    />
                  </div>
                  {q.explanation && (
                    <p className="mt-2 max-w-[68ch] text-sm text-text-secondary">{q.explanation}</p>
                  )}
                </li>
              ))}
            </ol>
            {preview.data.questions.length === 0 && (
              <Notice tone="warning">This assessment has no questions to draw yet.</Notice>
            )}
          </div>
        )}
      </SheetContent>
    </DialogRoot>
  );
}
