import { type ReactNode } from 'react';
import {
  Check,
  CircleDashed,
  ClipboardCheck,
  ExternalLink,
  FileText,
  Lock,
  MessagesSquare,
  PenLine,
  PlayCircle,
  ShieldCheck,
  Video,
  BookOpen,
  FileCheck2,
} from 'lucide-react';
import type { learning } from '@a5/contracts';
import { cn } from '@/lib/cn';

const TYPE_META: Record<learning.LessonType, { label: string; icon: typeof Video }> = {
  video: { label: 'Video', icon: Video },
  article: { label: 'Article', icon: BookOpen },
  pdf: { label: 'PDF', icon: FileText },
  document: { label: 'Document', icon: FileText },
  external: { label: 'External resource', icon: ExternalLink },
  quiz: { label: 'Quiz', icon: ClipboardCheck },
  assignment: { label: 'Assignment', icon: PenLine },
  ai_simulation: { label: 'AI practice', icon: MessagesSquare },
  scenario: { label: 'Scenario', icon: MessagesSquare },
  final_assessment: { label: 'Final assessment', icon: ClipboardCheck },
  manager_approval: { label: 'Manager sign-off', icon: ShieldCheck },
  acknowledgment: { label: 'Acknowledgment', icon: FileCheck2 },
};

export function lessonTypeLabel(t: learning.LessonType): string {
  return TYPE_META[t].label;
}

export function LessonTypeIcon({
  type,
  className,
}: {
  type: learning.LessonType;
  className?: string;
}) {
  const Icon = TYPE_META[type].icon;
  return <Icon aria-hidden className={className ?? 'size-4'} />;
}

/** Completion state marker: check, ring, half ring or lock, always with an accessible name. */
export function StateMark({ state, className }: { state: learning.NodeState; className?: string }) {
  const label = {
    completed: 'Completed',
    in_progress: 'In progress',
    available: 'Not started',
    locked: 'Locked',
  }[state];
  return (
    <span
      role="img"
      aria-label={label}
      className={cn('inline-flex size-[18px] shrink-0 items-center justify-center', className)}
    >
      {state === 'completed' ? (
        <span className="flex size-[18px] items-center justify-center rounded-full bg-success text-text-inverse">
          <Check className="size-3" strokeWidth={3} />
        </span>
      ) : state === 'locked' ? (
        <Lock className="size-4 text-text-tertiary" />
      ) : state === 'in_progress' ? (
        <PlayCircle className="size-[18px] text-brand-secondary" />
      ) : (
        <CircleDashed className="size-[18px] text-text-tertiary" />
      )}
    </span>
  );
}

/** Plain-language unlock requirements with progress. */
export function Requirements({
  items,
  title = 'To unlock this',
}: {
  items: learning.Requirement[];
  title?: string;
}) {
  const open = items.filter((r) => !r.satisfied);
  if (open.length === 0) return null;
  return (
    <div className="rounded-lg border border-border bg-surface-sunken/50 px-4 py-3">
      <p className="mb-1.5 text-sm font-semibold">{title}</p>
      <ul className="grid gap-1.5">
        {items.map((r) => (
          <li key={r.description} className="flex items-start gap-2 text-sm">
            <span className="mt-0.5">
              {r.satisfied ? (
                <Check aria-hidden className="size-4 text-success" />
              ) : (
                <CircleDashed aria-hidden className="size-4 text-text-tertiary" />
              )}
            </span>
            <span
              className={cn(
                r.satisfied && 'text-text-secondary line-through decoration-text-tertiary/50',
              )}
            >
              {r.description}
              {r.progress && !r.satisfied && r.progress.unit !== 'boolean' && (
                <span className="tabular ml-1.5 text-text-tertiary">
                  ({Math.round(r.progress.current)}
                  {r.progress.unit === 'percent' ? '%' : ''} of {r.progress.target}
                  {r.progress.unit === 'percent' ? '%' : ''})
                </span>
              )}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function Eyebrow({ children }: { children: ReactNode }) {
  return <p className="text-xs font-medium text-text-tertiary">{children}</p>;
}
