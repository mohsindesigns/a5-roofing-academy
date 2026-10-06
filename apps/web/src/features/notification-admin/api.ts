import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { PageResult, notification } from '@a5/contracts';
import { api } from '@/lib/api/client';

export const notificationAdminKeys = {
  all: ['notification-admin'] as const,
  templates: () => [...notificationAdminKeys.all, 'templates'] as const,
  rules: () => [...notificationAdminKeys.all, 'rules'] as const,
  deliveries: (q: Record<string, unknown>) =>
    [...notificationAdminKeys.all, 'deliveries', q] as const,
  delivery: (id: string) => [...notificationAdminKeys.all, 'delivery', id] as const,
};

export function useTemplates() {
  return useQuery({
    queryKey: notificationAdminKeys.templates(),
    queryFn: ({ signal }) =>
      api.get<{ items: notification.NotificationTemplate[] }>(
        '/notification-templates',
        undefined,
        signal,
      ),
  });
}

export function useUpdateTemplate(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: notification.UpdateTemplateRequest) =>
      api.patch<notification.NotificationTemplate>(`/notification-templates/${id}`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: notificationAdminKeys.templates() }),
  });
}

export function useResetTemplate(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api.post<notification.NotificationTemplate>(`/notification-templates/${id}/reset`),
    onSuccess: () => qc.invalidateQueries({ queryKey: notificationAdminKeys.templates() }),
  });
}

/** Renders the template (optionally unsaved text) with sample values; the API validates placeholders. */
export function usePreviewTemplate(id: string) {
  return useMutation({
    mutationFn: (body: notification.PreviewTemplateRequest) =>
      api.post<notification.TemplatePreview>(`/notification-templates/${id}/preview`, body),
  });
}

export function useRules() {
  return useQuery({
    queryKey: notificationAdminKeys.rules(),
    queryFn: ({ signal }) =>
      api.get<{ items: notification.NotificationRule[] }>('/notification-rules', undefined, signal),
  });
}

export function useUpdateRule(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: notification.UpdateRuleRequest) =>
      api.patch<notification.NotificationRule>(`/notification-rules/${id}`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: notificationAdminKeys.rules() }),
  });
}

export function useToggleRule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      api.post<notification.NotificationRule>(
        `/notification-rules/${id}/${enabled ? 'enable' : 'disable'}`,
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: notificationAdminKeys.rules() }),
  });
}

export interface DeliveryQuery {
  page: number;
  pageSize: number;
  status?: string;
  type?: string;
  q?: string;
}

export function useDeliveries(query: DeliveryQuery) {
  return useQuery({
    queryKey: notificationAdminKeys.deliveries({ ...query }),
    queryFn: ({ signal }) =>
      api.get<PageResult<notification.EmailDelivery>>(
        '/notifications/email-deliveries',
        { ...query },
        signal,
      ),
    placeholderData: keepPreviousData,
  });
}

export function useDelivery(id: string | null) {
  return useQuery({
    queryKey: notificationAdminKeys.delivery(id ?? ''),
    queryFn: ({ signal }) =>
      api.get<notification.EmailDeliveryDetail>(
        `/notifications/email-deliveries/${id}`,
        undefined,
        signal,
      ),
    enabled: Boolean(id),
  });
}
