import { Link } from 'react-router';
import { ArrowRight } from 'lucide-react';
import type { learning } from '@a5/contracts';
import {
  Button,
  EmptyState,
  ErrorState,
  PageHeader,
  ProgressBar,
  Section,
  Skeleton,
  StatusText,
  toast,
} from '@/components/ui';
import { errorMessage } from '@/lib/api/errors';
import { formatDate, formatMinutes } from '@/lib/format';
import { useCatalog, useEnrollSelf, useMyEnrollments } from './api';
import { LessonTypeIcon, lessonTypeLabel } from './lesson-ui';

function EnrollmentRow({ e }: { e: learning.MyEnrollment }) {
  const done = e.status === 'completed';
  return (
    <li className="grid gap-4 px-5 py-5 sm:grid-cols-[1fr_auto] sm:items-center">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <Link to={`/training/${e.program.id}`} className="text-lg font-semibold hover:underline">
            {e.program.title}
          </Link>
          {done ? (
            <StatusText tone="success">Completed {formatDate(e.completedAt)}</StatusText>
          ) : e.overdue ? (
            <StatusText tone="danger">Overdue</StatusText>
          ) : null}
        </div>
        {e.program.summary && (
          <p className="mt-1 line-clamp-2 max-w-[70ch] text-sm text-text-secondary">
            {e.program.summary}
          </p>
        )}
        <div className="mt-3 max-w-md">
          <ProgressBar
            value={e.progressPercent}
            label={`${e.program.title} progress`}
            showValue
            tone={done ? 'success' : 'accent'}
          />
          <p className="mt-1.5 text-xs text-text-tertiary">
            {e.requiredCompleted} of {e.requiredTotal} required lessons
            {e.currentPhase && !done && (
              <>
                {' '}
                · {e.currentPhase.label} {e.currentPhase.position + 1}: {e.currentPhase.title}
              </>
            )}
            {!done && e.estimatedRemainingMinutes > 0 && (
              <> · about {formatMinutes(e.estimatedRemainingMinutes)} left</>
            )}
            {e.dueAt && !done && <> · due {formatDate(e.dueAt)}</>}
          </p>
        </div>
      </div>
      <div className="flex gap-2">
        {e.nextLesson && !done ? (
          <Button asChild variant="primary" trailing={<ArrowRight className="size-4" />}>
            <Link to={`/training/${e.program.id}/lessons/${e.nextLesson.id}`}>
              {e.status === 'active' && e.progressPercent > 0 ? 'Continue' : 'Start'}
            </Link>
          </Button>
        ) : null}
        <Button asChild>
          <Link to={`/training/${e.program.id}`}>Outline</Link>
        </Button>
      </div>
    </li>
  );
}

function Catalog() {
  const catalog = useCatalog();
  const enroll = useEnrollSelf();
  if (!catalog.data || catalog.data.items.length === 0) return null;
  return (
    <Section title="More training available to you">
      <ul className="divide-y divide-divider rounded-lg border border-border bg-surface">
        {catalog.data.items.map((c) => (
          <li key={c.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
            <div className="min-w-0">
              <p className="font-medium">{c.title}</p>
              <p className="text-sm text-text-secondary">
                {c.phaseCount} {c.phaseLabel.toLowerCase()}s · {c.lessonCount} lessons · about{' '}
                {formatMinutes(c.estimatedMinutes)}
              </p>
            </div>
            <Button
              loading={enroll.isPending && enroll.variables === c.id}
              onClick={() =>
                enroll.mutate(c.id, {
                  onSuccess: () => toast.success(`You joined ${c.title}`),
                  onError: (err) => toast.error('Could not join', errorMessage(err)),
                })
              }
            >
              Join
            </Button>
          </li>
        ))}
      </ul>
    </Section>
  );
}

export function TrainingPage() {
  const mine = useMyEnrollments();
  return (
    <>
      <PageHeader title="Training" description="Your assigned programs and what to do next." />
      {mine.isPending ? (
        <Skeleton className="h-40 w-full" />
      ) : mine.isError ? (
        <ErrorState message={errorMessage(mine.error)} onRetry={() => mine.refetch()} />
      ) : mine.data.items.length === 0 ? (
        <EmptyState
          title="No training assigned yet"
          description="Your manager assigns programs to you. They appear here as soon as they do."
        />
      ) : (
        <ul className="mb-10 divide-y divide-divider overflow-hidden rounded-lg border border-border bg-surface">
          {mine.data.items.map((e) => (
            <EnrollmentRow key={e.id} e={e} />
          ))}
        </ul>
      )}
      <Catalog />
    </>
  );
}

export { lessonTypeLabel, LessonTypeIcon };
