import { Link, useParams } from 'react-router';
import { ArrowRight } from 'lucide-react';
import type { learning } from '@a5/contracts';
import {
  Button,
  ErrorState,
  Notice,
  PageHeader,
  ProgressBar,
  Skeleton,
  Tag,
} from '@/components/ui';
import { ApiError, errorMessage } from '@/lib/api/errors';
import { cn } from '@/lib/cn';
import { formatDate, formatMinutes } from '@/lib/format';
import { useOutline } from './api';
import { LessonTypeIcon, Requirements, StateMark, lessonTypeLabel } from './lesson-ui';

function LessonRow({ programId, l }: { programId: string; l: learning.OutlineLesson }) {
  const locked = l.state === 'locked';
  const inner = (
    <>
      <StateMark state={l.state} />
      <LessonTypeIcon type={l.type} className="size-4 shrink-0 text-text-tertiary" />
      <span className="min-w-0 flex-1">
        <span
          className={cn(
            'block truncate text-base',
            locked ? 'text-text-tertiary' : 'text-text-primary',
            l.state === 'completed' && 'text-text-secondary',
          )}
        >
          {l.title}
        </span>
        <span className="block text-xs text-text-tertiary">
          {lessonTypeLabel(l.type)} · {l.estimatedMinutes} min{!l.isRequired && ' · optional'}
        </span>
      </span>
    </>
  );
  return locked ? (
    <div className="flex items-center gap-3 px-4 py-2.5" aria-disabled>
      {inner}
    </div>
  ) : (
    <Link
      to={`/training/${programId}/lessons/${l.id}`}
      className="flex items-center gap-3 px-4 py-2.5 hover:bg-surface-hover"
    >
      {inner}
    </Link>
  );
}

function Phase({
  programId,
  p,
  defaultOpen,
}: {
  programId: string;
  p: learning.OutlinePhase;
  defaultOpen: boolean;
}) {
  const locked = p.state === 'locked';
  return (
    <details
      open={defaultOpen && !locked}
      className="group overflow-hidden rounded-lg border border-border bg-surface"
    >
      <summary className="flex cursor-pointer list-none items-center gap-3 px-4 py-3.5 hover:bg-surface-hover [&::-webkit-details-marker]:hidden">
        <StateMark state={p.state} />
        <div className="min-w-0 flex-1">
          <p className="text-xs text-text-tertiary">
            {p.label} {p.position + 1}
          </p>
          <p className="text-md font-semibold">{p.title}</p>
        </div>
        <div className="hidden w-40 sm:block">
          <ProgressBar
            value={p.percent}
            label={`${p.title} progress`}
            size="sm"
            tone={p.state === 'completed' ? 'success' : 'accent'}
          />
        </div>
        <span className="tabular w-16 text-right text-sm text-text-secondary">
          {p.requiredCompleted}/{p.requiredTotal}
        </span>
      </summary>
      <div className="border-t border-divider">
        {locked && (
          <div className="px-4 py-3">
            <Requirements
              items={p.requirements}
              title={`To unlock ${p.label.toLowerCase()} ${p.position + 1}`}
            />
          </div>
        )}
        {p.summary && !locked && (
          <p className="px-4 pt-3 text-sm text-text-secondary">{p.summary}</p>
        )}
        {p.modules.map((m) => (
          <div key={m.id} className="py-2">
            <p className="px-4 pt-2 pb-1 text-xs font-medium text-text-tertiary">{m.title}</p>
            <div className="divide-y divide-divider/60">
              {m.lessons.map((l) => (
                <LessonRow key={l.id} programId={programId} l={l} />
              ))}
            </div>
          </div>
        ))}
      </div>
    </details>
  );
}

export function ProgramPage() {
  const { programId = '' } = useParams();
  const outline = useOutline(programId);
  if (outline.isPending) return <Skeleton className="h-96 w-full" />;
  if (outline.isError) {
    const gone = outline.error instanceof ApiError && outline.error.isNotFound;
    return (
      <>
        <PageHeader title="Program" breadcrumbs={[{ label: 'Training', to: '/training' }]} />
        {gone ? (
          <Notice tone="warning">This program is not assigned to you, or it was archived.</Notice>
        ) : (
          <ErrorState message={errorMessage(outline.error)} onRetry={() => outline.refetch()} />
        )}
      </>
    );
  }
  const o = outline.data;
  const next = o.phases
    .flatMap((p) => p.modules.flatMap((m) => m.lessons))
    .find((l) => l.id === o.nextLessonId);
  const activePhaseIndex = o.phases.findIndex(
    (p) => p.state !== 'completed' && p.state !== 'locked',
  );
  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: 'Training', to: '/training' }, { label: o.program.title }]}
        title={o.program.title}
        description={o.program.summary}
        meta={
          <>
            <span className="tabular">
              {o.requiredCompleted} of {o.requiredTotal} required lessons
            </span>
            {o.estimatedRemainingMinutes > 0 && (
              <span>about {formatMinutes(o.estimatedRemainingMinutes)} left</span>
            )}
            {o.enrollment?.dueAt && <span>Due {formatDate(o.enrollment.dueAt)}</span>}
            {o.enrollment?.status === 'completed' && <Tag tone="success">Completed</Tag>}
          </>
        }
        actions={
          next && (
            <Button
              asChild
              variant="primary"
              size="lg"
              trailing={<ArrowRight className="size-4" />}
            >
              <Link to={`/training/${o.program.id}/lessons/${next.id}`}>
                {o.percent > 0 ? 'Continue training' : 'Start training'}
              </Link>
            </Button>
          )
        }
      />
      {o.state === 'locked' && (
        <Requirements items={o.requirements} title="This program is not open yet" />
      )}
      <div className="mb-6 max-w-xl">
        <ProgressBar
          value={o.percent}
          label="Overall progress"
          showValue
          size="lg"
          tone={o.enrollment?.status === 'completed' ? 'success' : 'accent'}
        />
      </div>
      <div className="grid gap-3">
        {o.phases.map((p, i) => (
          <Phase
            key={p.id}
            programId={o.program.id}
            p={p}
            defaultOpen={i === Math.max(0, activePhaseIndex)}
          />
        ))}
      </div>
    </>
  );
}
