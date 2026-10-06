import { AlertTriangle, CircleDot, Clock, FileCheck2, PauseCircle } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { learning } from '@a5/contracts';
import { cn } from '@/lib/cn';

type Code = learning.AttentionFlag['code'];

const FLAGS: Record<Code, { label: string; icon: LucideIcon; text: string }> = {
  overdue: { label: 'Overdue', icon: Clock, text: 'text-danger' },
  failing_assessment: { label: 'Failing assessment', icon: AlertTriangle, text: 'text-danger' },
  inactive: { label: 'Inactive', icon: PauseCircle, text: 'text-warning' },
  not_started: { label: 'Not started', icon: CircleDot, text: 'text-warning' },
  awaiting_approval: { label: 'Awaiting sign-off', icon: FileCheck2, text: 'text-information' },
};

/** Severity order: what a manager should look at first. */
export const FLAG_ORDER: Code[] = [
  'overdue',
  'failing_assessment',
  'inactive',
  'not_started',
  'awaiting_approval',
];

export function sortFlags(flags: learning.AttentionFlag[]): learning.AttentionFlag[] {
  return [...flags].sort((a, b) => FLAG_ORDER.indexOf(a.code) - FLAG_ORDER.indexOf(b.code));
}

export function flagLabel(code: Code): string {
  return FLAGS[code].label;
}

/**
 * Attention flags as icon + text (never colour alone). `compact` shows the most urgent flag with
 * a count of the others; the full messages are in the learner drawer.
 */
export function AttentionFlags({
  flags,
  compact = false,
  className,
}: {
  flags: learning.AttentionFlag[];
  compact?: boolean;
  className?: string;
}) {
  if (flags.length === 0) {
    return <span className="text-sm text-text-tertiary">On track</span>;
  }
  const ordered = sortFlags(flags);
  const shown = compact ? ordered.slice(0, 1) : ordered;
  return (
    <ul className={cn('flex flex-col gap-1', className)}>
      {shown.map((f) => {
        const meta = FLAGS[f.code];
        return (
          <li key={`${f.code}-${f.message}`} className="min-w-0">
            <span className={cn('inline-flex items-center gap-1.5 text-sm font-medium', meta.text)}>
              <meta.icon aria-hidden className="size-3.5 shrink-0" />
              {meta.label}
            </span>
            <span
              className={cn(
                'block text-xs text-text-secondary',
                compact && 'max-w-[26ch] truncate',
              )}
              title={compact ? f.message : undefined}
            >
              {f.message}
            </span>
          </li>
        );
      })}
      {compact && ordered.length > 1 && (
        <li className="text-xs text-text-tertiary">+{ordered.length - 1} more</li>
      )}
    </ul>
  );
}
