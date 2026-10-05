import { Link } from 'react-router';
import { ArrowRight } from 'lucide-react';
import { ErrorState, ProgressBar, Section, Skeleton, StatusText } from '@/components/ui';
import { useContinueLearning, useMyEnrollments } from '@/features/learning/api';
import { LessonTypeIcon, lessonTypeLabel } from '@/features/learning/lesson-ui';
import { formatDate, formatMinutes } from '@/lib/format';

/** The trainee's "what do I do next" block: one primary action, then every program in flight. */
export function TraineeDashboard() {
  const next = useContinueLearning();
  const enrollments = useMyEnrollments();

  if (next.isPending || enrollments.isPending) {
    return <Skeleton className="h-40 w-full" />;
  }
  if (next.isError || enrollments.isError) {
    return (
      <ErrorState
        title="Your training could not be loaded"
        onRetry={() => {
          void next.refetch();
          void enrollments.refetch();
        }}
      />
    );
  }

  const items = enrollments.data.items;
  if (items.length === 0) return null;
  const item = next.data.item;
  const active = items.filter((e) => e.status !== 'completed');

  return (
    <div className="space-y-8">
      {item && (
        <section
          aria-labelledby="continue-heading"
          className="rounded-lg bg-brand-primary p-5 text-text-inverse sm:p-6"
        >
          <p className="text-xs font-medium uppercase tracking-wide opacity-70">
            {item.phase.label}: {item.phase.title} · {item.module.title}
          </p>
          <h2 id="continue-heading" className="mt-2 text-xl font-semibold">
            {item.lesson.title}
          </h2>
          <p className="mt-1 flex items-center gap-2 text-sm opacity-80">
            <LessonTypeIcon type={item.lesson.type} className="size-4" />
            {lessonTypeLabel(item.lesson.type)} · {formatMinutes(item.lesson.estimatedMinutes)}
            {item.lesson.percent > 0 && <> · {Math.round(item.lesson.percent)}% watched</>}
          </p>
          <Link
            to={`/training/${item.program.id}/lessons/${item.lesson.id}`}
            className="mt-5 inline-flex min-h-11 items-center gap-2 rounded-md bg-surface px-4 text-sm font-semibold text-text-primary hover:bg-surface-hover"
          >
            {item.lesson.percent > 0 ? 'Resume lesson' : 'Start lesson'}
            <ArrowRight aria-hidden className="size-4" />
          </Link>
        </section>
      )}

      <Section title="Your programs">
        <ul className="divide-y divide-divider rounded-lg border border-border bg-surface">
          {items.map((e) => (
            <li key={e.id} className="px-4 py-4 sm:px-5">
              <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
                <Link to={`/training/${e.program.id}`} className="font-semibold hover:underline">
                  {e.program.title}
                </Link>
                {e.status === 'completed' ? (
                  <StatusText tone="success">Completed {formatDate(e.completedAt)}</StatusText>
                ) : e.overdue ? (
                  <StatusText tone="danger">Overdue</StatusText>
                ) : e.dueAt ? (
                  <span className="text-xs text-text-tertiary">Due {formatDate(e.dueAt)}</span>
                ) : null}
              </div>
              <div className="mt-2 max-w-md">
                <ProgressBar
                  value={e.progressPercent}
                  label={`${e.program.title} progress`}
                  showValue
                  tone={e.status === 'completed' ? 'success' : 'accent'}
                />
              </div>
            </li>
          ))}
        </ul>
        {active.length === 0 && (
          <p className="mt-3 text-sm text-text-secondary">All assigned programs are complete.</p>
        )}
      </Section>
    </div>
  );
}
