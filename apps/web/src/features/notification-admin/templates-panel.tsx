import { useCallback, useMemo, useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import { notification } from '@a5/contracts';
import { ConfirmDialog, EmptyState, ErrorState, Skeleton, StatusText } from '@/components/ui';
import { categoryLabel } from '@/features/notifications/notification-item';
import { useSearchState } from '@/hooks/use-search-state';
import { errorMessage } from '@/lib/api/errors';
import { cn } from '@/lib/cn';
import { useTemplates } from './api';
import { TemplateEditor } from './template-editor';

const CHANNEL_LABEL: Record<notification.NotificationChannel, string> = {
  email: 'Email',
  in_app: 'In-app',
};

/** Templates grouped by category; each row is one notification type on one channel. */
export function TemplatesPanel() {
  const templates = useTemplates();
  const [state, setState] = useSearchState({ template: '' });
  const [dirty, setDirty] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const onDirtyChange = useCallback((d: boolean) => setDirty(d), []);

  const groups = useMemo(() => {
    const items = templates.data?.items ?? [];
    return notification.NOTIFICATION_CATEGORIES.map((category) => ({
      category,
      items: items.filter((t) => t.category === category),
    })).filter((g) => g.items.length > 0);
  }, [templates.data]);

  if (templates.isPending) return <Skeleton className="h-96 w-full" />;
  if (templates.isError)
    return (
      <ErrorState message={errorMessage(templates.error)} onRetry={() => templates.refetch()} />
    );

  const selected = templates.data.items.find((t) => t.id === state.template) ?? null;
  const select = (id: string) => {
    if (dirty && id !== state.template) setPending(id);
    else setState({ template: id });
  };

  return (
    <div className="grid gap-8 lg:grid-cols-[300px_minmax(0,1fr)]">
      <nav
        aria-label="Notification templates"
        className={cn(
          'lg:sticky lg:top-6 lg:block lg:max-h-[calc(100dvh-3rem)] lg:self-start lg:overflow-y-auto',
          selected && 'hidden',
        )}
      >
        {groups.map((g) => (
          <div key={g.category} className="mb-5">
            <h2 className="mb-1 text-xs font-medium text-text-tertiary">
              {categoryLabel(g.category)}
            </h2>
            <ul className="flex flex-col">
              {g.items.map((t) => {
                const active = t.id === state.template;
                return (
                  <li key={t.id}>
                    <button
                      type="button"
                      aria-current={active ? 'true' : undefined}
                      onClick={() => select(t.id)}
                      className={cn(
                        'flex w-full items-center justify-between gap-3 rounded px-2 py-1.5 text-left hover:bg-surface-hover',
                        active && 'bg-surface-selected',
                      )}
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-medium">{t.typeLabel}</span>
                        <span className="text-xs text-text-tertiary">
                          {CHANNEL_LABEL[t.channel]}
                          {!t.isDefault && ' · edited'}
                        </span>
                      </span>
                      {!t.enabled && <StatusText tone="neutral">Off</StatusText>}
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>

      <div className={cn('min-w-0', !selected && 'hidden lg:block')}>
        {selected ? (
          <>
            <button
              type="button"
              className="mb-4 inline-flex items-center gap-1.5 text-sm text-information hover:underline lg:hidden"
              onClick={() => select('')}
            >
              <ArrowLeft aria-hidden className="size-4" />
              All templates
            </button>
            <TemplateEditor key={selected.id} template={selected} onDirtyChange={onDirtyChange} />
          </>
        ) : (
          <EmptyState
            title="Choose a template"
            description="Pick a notification on the left to edit its wording, switch it on or off, and preview what people receive."
          />
        )}
      </div>

      <ConfirmDialog
        open={pending !== null}
        onOpenChange={(o) => !o && setPending(null)}
        title="Discard your changes?"
        description="You have unsaved edits to this template. Opening another template discards them."
        confirmLabel="Discard and open"
        tone="danger"
        onConfirm={() => {
          if (pending !== null) setState({ template: pending });
          setDirty(false);
          setPending(null);
        }}
      />
    </div>
  );
}
