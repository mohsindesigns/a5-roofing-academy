import { Link } from 'react-router';
import type { notification } from '@a5/contracts';
import { cn } from '@/lib/cn';
import { formatRelative } from '@/lib/format';

const CATEGORY_LABEL: Record<notification.NotificationCategory, string> = {
  account: 'Account',
  training: 'Training',
  assessments: 'Assessments',
  ai_coaching: 'AI coaching',
  approvals: 'Approvals',
  certifications: 'Certifications',
};

export function categoryLabel(c: notification.NotificationCategory): string {
  return CATEGORY_LABEL[c];
}

/** A single inbox row. Unread items carry a marker dot and heavier title; high priority gets an accent bar. */
export function NotificationItem({
  n,
  onOpen,
  compact = false,
}: {
  n: notification.Notification;
  onOpen: (n: notification.Notification) => void;
  compact?: boolean;
}) {
  const unread = n.readAt === null;
  const content = (
    <>
      <span
        aria-hidden
        className={cn(
          'mt-[7px] size-2 shrink-0 rounded-full',
          unread ? 'bg-brand-secondary' : 'bg-transparent',
        )}
      />
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline justify-between gap-3">
          <span
            className={cn(
              'truncate text-base',
              unread ? 'font-semibold text-text-primary' : 'font-medium text-text-secondary',
            )}
          >
            {n.title}
            {unread && <span className="sr-only"> (unread)</span>}
          </span>
          <time dateTime={n.createdAt} className="shrink-0 text-xs text-text-tertiary">
            {formatRelative(n.createdAt)}
          </time>
        </span>
        <span
          className={cn(
            'mt-0.5 block text-sm text-text-secondary',
            compact ? 'line-clamp-2' : 'line-clamp-3',
          )}
        >
          {n.body}
        </span>
        {!compact && (
          <span className="mt-1 block text-xs text-text-tertiary">{categoryLabel(n.category)}</span>
        )}
      </span>
    </>
  );
  const base = cn(
    'flex w-full gap-3 px-4 py-3 text-left hover:bg-surface-hover',
    n.priority === 'high' && unread && 'shadow-[inset_3px_0_0_var(--a5-brand-secondary)]',
  );
  return n.link ? (
    <Link to={n.link} onClick={() => onOpen(n)} className={base}>
      {content}
    </Link>
  ) : (
    <button type="button" onClick={() => onOpen(n)} className={base}>
      {content}
    </button>
  );
}
