import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type InfiniteData,
} from '@tanstack/react-query';
import type { notification } from '@a5/contracts';
import { api } from '@/lib/api/client';

export const notificationKeys = {
  all: ['notifications'] as const,
  list: (filters: { unread: boolean; category: string }) =>
    [...notificationKeys.all, 'list', filters] as const,
  recent: () => [...notificationKeys.all, 'recent'] as const,
  unread: () => [...notificationKeys.all, 'unread'] as const,
  preferences: () => [...notificationKeys.all, 'preferences'] as const,
};

type Page = notification.NotificationPage;

export function useUnreadCount() {
  return useQuery({
    queryKey: notificationKeys.unread(),
    queryFn: () => api.get<notification.UnreadCount>('/notifications/unread-count'),
    select: (d) => d.count,
    staleTime: 60_000,
  });
}

/** Latest notifications for the bell popover. */
export function useRecentNotifications(enabled: boolean) {
  return useQuery({
    queryKey: notificationKeys.recent(),
    queryFn: () => api.get<Page>('/notifications', { limit: 8 }),
    enabled,
    staleTime: 15_000,
  });
}

export function useNotificationInbox(filters: { unread: boolean; category: string }) {
  return useInfiniteQuery({
    queryKey: notificationKeys.list(filters),
    queryFn: ({ pageParam, signal }) =>
      api.get<Page>(
        '/notifications',
        {
          limit: 20,
          cursor: pageParam,
          unread: filters.unread ? 'true' : undefined,
          category: filters.category || undefined,
        },
        signal,
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    placeholderData: keepPreviousData,
  });
}

function markReadInCache(
  qc: ReturnType<typeof useQueryClient>,
  ids: Set<string> | 'all',
  unreadCount: number,
) {
  const now = new Date().toISOString();
  const patch = (n: notification.Notification) =>
    ids === 'all' || ids.has(n.id) ? { ...n, readAt: n.readAt ?? now } : n;
  qc.setQueryData<Page>(
    notificationKeys.recent(),
    (old) => old && { ...old, items: old.items.map(patch), unreadCount },
  );
  qc.setQueriesData<InfiniteData<Page>>(
    { queryKey: [...notificationKeys.all, 'list'] },
    (old) =>
      old && {
        ...old,
        pages: old.pages.map((p) => ({ ...p, items: p.items.map(patch), unreadCount })),
      },
  );
  qc.setQueryData<notification.UnreadCount>(notificationKeys.unread(), { count: unreadCount });
}

export function useMarkRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post<{ unreadCount: number }>(`/notifications/${id}/read`),
    // Optimistic: marking read is idempotent and trivially reversible.
    onMutate: (id) => {
      const current =
        qc.getQueryData<notification.UnreadCount>(notificationKeys.unread())?.count ?? 0;
      markReadInCache(qc, new Set([id]), Math.max(0, current - 1));
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: notificationKeys.unread() }),
  });
}

export function useMarkAllRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<notification.MarkAllReadResponse>('/notifications/read-all'),
    onSuccess: (r) => markReadInCache(qc, 'all', r.unreadCount),
  });
}

export function usePreferences() {
  return useQuery({
    queryKey: notificationKeys.preferences(),
    queryFn: () => api.get<notification.PreferencesResponse>('/notifications/preferences'),
  });
}

export function useSavePreferences() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (preferences: notification.UpdatePreferencesRequest['preferences']) =>
      api.put<notification.PreferencesResponse>('/notifications/preferences', { preferences }),
    onSuccess: (data) => qc.setQueryData(notificationKeys.preferences(), data),
  });
}
