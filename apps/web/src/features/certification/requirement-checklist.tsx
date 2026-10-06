import { Circle, CircleCheck, CircleHelp } from 'lucide-react';
import { ProgressBar } from '@/components/ui';
import { cn } from '@/lib/cn';
import type { RequirementItem } from './types';

/** "3 of 5", "72% of 80% needed" or null for yes/no requirements. */
export function describeProgress(p: RequirementItem['progress']): string | null {
  if (!p || p.unit === 'boolean') return null;
  const round = (n: number) => Math.round(n * 10) / 10;
  switch (p.unit) {
    case 'percent':
      return `${round(p.current)}% of ${round(p.target)}% needed`;
    case 'days':
      return `${round(p.current)} of ${round(p.target)} days`;
    case 'count':
      return `${round(p.current)} of ${round(p.target)}`;
  }
}

/** Share of a requirement that is done, 0-100, for the thin progress bar. */
export function progressValue(item: RequirementItem): number {
  if (item.satisfied) return 100;
  const p = item.progress;
  if (!p || p.target <= 0) return 0;
  return Math.max(0, Math.min(100, (p.current / p.target) * 100));
}

function Row({ item }: { item: RequirementItem }) {
  const detail = describeProgress(item.progress);
  const showBar = item.progress !== null && item.progress.unit !== 'boolean' && !item.unknown;
  return (
    <li className="flex items-start gap-3 py-2.5">
      {item.unknown ? (
        <CircleHelp aria-hidden className="mt-0.5 size-4 shrink-0 text-text-tertiary" />
      ) : item.satisfied ? (
        <CircleCheck aria-hidden className="mt-0.5 size-4 shrink-0 text-success" />
      ) : (
        <Circle aria-hidden className="mt-0.5 size-4 shrink-0 text-text-tertiary" />
      )}
      <div className="min-w-0 flex-1">
        <p
          className={cn('text-base', item.satisfied ? 'text-text-secondary' : 'text-text-primary')}
        >
          {item.description}
          <span className="sr-only">
            {item.unknown
              ? '. Status not available yet.'
              : item.satisfied
                ? '. Met.'
                : '. Not met yet.'}
          </span>
        </p>
        {item.unknown ? (
          <p aria-hidden className="text-xs text-text-secondary">
            Status not available yet.
          </p>
        ) : (
          (detail || showBar) && (
            <div className="mt-1 flex items-center gap-3">
              {showBar && (
                <ProgressBar
                  value={progressValue(item)}
                  label={`Progress: ${item.description}`}
                  size="sm"
                  tone={item.satisfied ? 'success' : 'accent'}
                  className="max-w-[220px] flex-1"
                />
              )}
              {detail && <span className="tabular text-xs text-text-secondary">{detail}</span>}
            </div>
          )
        )}
      </div>
    </li>
  );
}

/**
 * Per-requirement progress ("6 of 8 requirements complete"). Everything shown comes from the API's
 * evaluation of the certification rules; no thresholds live in the client.
 */
export function RequirementChecklist({
  requirements,
  metCount,
  totalCount,
  heading = 'Requirements',
  className,
}: {
  requirements: RequirementItem[];
  metCount: number;
  totalCount: number;
  heading?: string;
  className?: string;
}) {
  if (requirements.length === 0) {
    return (
      <p className={cn('text-sm text-text-secondary', className)}>
        No individual requirements are tracked for this certification.
      </p>
    );
  }
  return (
    <div className={className}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h3 className="text-sm font-semibold text-text-primary">{heading}</h3>
        <p className="tabular text-sm text-text-secondary">
          {metCount} of {totalCount} complete
        </p>
      </div>
      <ProgressBar
        value={totalCount > 0 ? (metCount / totalCount) * 100 : 0}
        label={`${metCount} of ${totalCount} requirements complete`}
        tone={metCount === totalCount ? 'success' : 'accent'}
        className="mt-2"
      />
      <ul className="mt-2 divide-y divide-divider">
        {requirements.map((item) => (
          <Row key={item.key} item={item} />
        ))}
      </ul>
    </div>
  );
}
