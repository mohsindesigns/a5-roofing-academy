import { useState } from 'react';
import { Link } from 'react-router';
import { Popover } from 'radix-ui';
import { Bell } from 'lucide-react';
import { Button, ErrorState, Skeleton } from '@/components/ui';
import { cn } from '@/lib/cn';
import { errorMessage } from '@/lib/api/errors';
import { useMarkAllRead, useMarkRead, useRecentNotifications, useUnreadCount } from './api';
import { NotificationItem } from './notification-item';

/** Bell with live unread badge and a quick-triage popover. */
export function NotificationBell({ className }: { className?: string }) {
  const [open, setOpen] = useState(false);
  const unread = useUnreadCount();
  const recent = useRecentNotifications(open);
  const markRead = useMarkRead();
  const markAll = useMarkAllRead();
  const count = unread.data ?? 0;
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        aria-label={count > 0 ? `Notifications, ${count} unread` : 'Notifications'}
        className={cn(
          'relative flex size-9 items-center justify-center rounded text-text-secondary hover:bg-surface-hover hover:text-text-primary',
          className,
        )}
      >
        <Bell aria-hidden className="size-[18px]" />
        {count > 0 && (
          <span
            aria-hidden
            className="tabular absolute top-0.5 right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-brand-secondary px-1 text-2xs font-semibold text-text-inverse"
          >
            {count > 99 ? '99+' : count}
          </span>
        )}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={8}
          collisionPadding={12}
          className="z-50 w-[min(380px,calc(100vw-24px))] overflow-hidden rounded-lg border border-border bg-surface-elevated shadow-popover"
        >
          <div className="flex items-center justify-between border-b border-divider px-4 py-2.5">
            <Popover.Close asChild>
              <Link to="/notifications" className="text-sm font-semibold hover:underline">
                Notifications
              </Link>
            </Popover.Close>
            <Button
              size="sm"
              variant="ghost"
              disabled={count === 0 || markAll.isPending}
              onClick={() => markAll.mutate()}
            >
              Mark all read
            </Button>
          </div>
          <div className="max-h-[min(440px,70dvh)] divide-y divide-divider overflow-y-auto">
            {recent.isPending ? (
              <div className="grid gap-3 p-4">
                <Skeleton className="h-10" />
                <Skeleton className="h-10" />
                <Skeleton className="h-10" />
              </div>
            ) : recent.isError ? (
              <div className="p-3">
                <ErrorState
                  title="Notifications could not be loaded"
                  message={errorMessage(recent.error)}
                  onRetry={() => recent.refetch()}
                />
              </div>
            ) : recent.data.items.length === 0 ? (
              <p className="px-4 py-8 text-center text-sm text-text-secondary">
                You're all caught up.
              </p>
            ) : (
              recent.data.items.map((n) => (
                <Popover.Close asChild key={n.id}>
                  <div>
                    <NotificationItem
                      n={n}
                      compact
                      onOpen={(item) => item.readAt === null && markRead.mutate(item.id)}
                    />
                  </div>
                </Popover.Close>
              ))
            )}
          </div>
          <div className="border-t border-divider px-4 py-2.5 text-center">
            <Popover.Close asChild>
              <Link
                to="/notifications"
                className="text-sm font-medium text-information hover:underline"
              >
                View all notifications
              </Link>
            </Popover.Close>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
