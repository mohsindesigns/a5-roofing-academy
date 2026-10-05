import { useEffect } from 'react';
import { useQueryClient, type InfiniteData } from '@tanstack/react-query';
import type { notification } from '@a5/contracts';
import { streamSse } from '@/lib/api/sse';
import { ApiError } from '@/lib/api/errors';
import { useAuth } from '@/lib/auth-store';
import { toast } from '@/components/ui';
import { notificationKeys } from './api';

type Page = notification.NotificationPage;

/**
 * One authenticated SSE connection per tab. New notifications update the query cache directly
 * (no refetch storm), the unread badge follows the server's count, and a dropped connection
 * reconnects with backoff, replaying missed notifications through Last-Event-ID.
 */
export function useNotificationStream() {
  const qc = useQueryClient();
  const status = useAuth((s) => s.status);

  useEffect(() => {
    if (status !== 'authenticated') return;
    const controller = new AbortController();
    let lastId: string | undefined;
    let delay = 1_000;

    const onNotification = (n: notification.Notification) => {
      qc.setQueryData<Page>(notificationKeys.recent(), (old) =>
        old && !old.items.some((i) => i.id === n.id)
          ? { ...old, items: [n, ...old.items].slice(0, 8) }
          : old,
      );
      qc.setQueriesData<InfiniteData<Page>>(
        { queryKey: [...notificationKeys.all, 'list'] },
        (old) => {
          if (!old || old.pages.some((p) => p.items.some((i) => i.id === n.id))) return old;
          const [first, ...rest] = old.pages;
          return first
            ? { ...old, pages: [{ ...first, items: [n, ...first.items] }, ...rest] }
            : old;
        },
      );
      if (n.priority !== 'low')
        toast.info(n.title, n.body.length > 140 ? `${n.body.slice(0, 137)}…` : n.body);
    };

    void (async () => {
      while (!controller.signal.aborted) {
        try {
          await streamSse('/notifications/stream', {
            signal: controller.signal,
            headers: lastId ? { 'last-event-id': lastId } : undefined,
            onMessage: (m) => {
              delay = 1_000;
              if (m.event === 'unread') {
                const { count } = JSON.parse(m.data) as notification.UnreadCount;
                qc.setQueryData<notification.UnreadCount>(notificationKeys.unread(), { count });
              } else if (m.event === 'notification') {
                if (m.id) lastId = m.id;
                onNotification(JSON.parse(m.data) as notification.Notification);
              }
            },
          });
        } catch (err) {
          if (controller.signal.aborted || (err as Error).name === 'AbortError') return;
          // Auth errors are handled by the client (refresh/sign-out); stop retrying a forbidden stream.
          if (err instanceof ApiError && err.status === 403) return;
        }
        await new Promise((r) => setTimeout(r, delay + Math.random() * 500));
        delay = Math.min(delay * 2, 30_000);
      }
    })();

    return () => controller.abort();
  }, [qc, status]);
}
