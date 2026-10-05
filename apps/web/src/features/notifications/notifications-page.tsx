import { useSearchParams } from 'react-router';
import { CheckCheck } from 'lucide-react';
import { notification as contract } from '@a5/contracts';
import {
  Button,
  EmptyState,
  ErrorState,
  PageHeader,
  Select,
  Skeleton,
  Switch,
  TabsContent,
  TabsList,
  TabsRoot,
} from '@/components/ui';
import { errorMessage } from '@/lib/api/errors';
import { useMarkAllRead, useMarkRead, useNotificationInbox, useUnreadCount } from './api';
import { NotificationItem, categoryLabel } from './notification-item';
import { PreferencesPanel } from './preferences-panel';

function Inbox() {
  const [params, setParams] = useSearchParams();
  const unreadOnly = params.get('unread') === 'true';
  const category = params.get('category') ?? '';
  const inbox = useNotificationInbox({ unread: unreadOnly, category });
  const unread = useUnreadCount();
  const markRead = useMarkRead();
  const markAll = useMarkAllRead();
  const items = inbox.data?.pages.flatMap((p) => p.items) ?? [];
  const setFilter = (key: string, value: string | null) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (value) next.set(key, value);
        else next.delete(key);
        return next;
      },
      { replace: true },
    );

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-4">
          <label className="flex items-center gap-2 text-sm text-text-secondary">
            <Switch
              checked={unreadOnly}
              onCheckedChange={(on) => setFilter('unread', on ? 'true' : null)}
              aria-label="Unread only"
            />
            Unread only
          </label>
          <Select
            aria-label="Category"
            className="w-44"
            value={category}
            onChange={(e) => setFilter('category', e.target.value || null)}
          >
            <option value="">All categories</option>
            {contract.NOTIFICATION_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {categoryLabel(c)}
              </option>
            ))}
          </Select>
        </div>
        <Button
          leading={<CheckCheck className="size-4" />}
          disabled={(unread.data ?? 0) === 0}
          loading={markAll.isPending}
          onClick={() => markAll.mutate()}
        >
          Mark all read
        </Button>
      </div>
      {inbox.isPending ? (
        <div className="grid gap-3" aria-busy="true">
          {Array.from({ length: 5 }, (_, i) => (
            <Skeleton key={i} className="h-16" />
          ))}
        </div>
      ) : inbox.isError ? (
        <ErrorState message={errorMessage(inbox.error)} onRetry={() => inbox.refetch()} />
      ) : items.length === 0 ? (
        <EmptyState
          title={unreadOnly || category ? 'Nothing matches these filters' : "You're all caught up"}
          description={
            unreadOnly || category
              ? 'Clear a filter to see more.'
              : 'New assignments, results, approvals and certificate updates appear here as they happen.'
          }
        />
      ) : (
        <>
          <ul className="divide-y divide-divider overflow-hidden rounded-lg border border-border bg-surface">
            {items.map((n) => (
              <li key={n.id}>
                <NotificationItem
                  n={n}
                  onOpen={(item) => item.readAt === null && markRead.mutate(item.id)}
                />
              </li>
            ))}
          </ul>
          {inbox.hasNextPage && (
            <div className="mt-4 flex justify-center">
              <Button loading={inbox.isFetchingNextPage} onClick={() => inbox.fetchNextPage()}>
                Load older notifications
              </Button>
            </div>
          )}
        </>
      )}
    </>
  );
}

export function NotificationsPage() {
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') ?? 'inbox';
  return (
    <>
      <PageHeader
        title="Notifications"
        description="Assignments, results, approvals and certificate updates for you."
      />
      <TabsRoot
        value={tab}
        onValueChange={(v) => setParams(v === 'inbox' ? {} : { tab: v }, { replace: true })}
      >
        <TabsList
          className="mb-5"
          items={[
            { value: 'inbox', label: 'Inbox' },
            { value: 'preferences', label: 'Preferences' },
          ]}
        />
        <TabsContent value="inbox">
          <Inbox />
        </TabsContent>
        <TabsContent value="preferences">
          <PreferencesPanel />
        </TabsContent>
      </TabsRoot>
    </>
  );
}
