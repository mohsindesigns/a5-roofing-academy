import { useMemo, useState } from 'react';
import type { notification } from '@a5/contracts';
import { Button, ErrorState, Skeleton, Switch, toast } from '@/components/ui';
import { UnsavedBar } from '@/app/shell/unsaved-bar';
import { errorMessage } from '@/lib/api/errors';
import { usePreferences, useSavePreferences } from './api';
import { categoryLabel } from './notification-item';

const CHANNEL_LABEL: Record<notification.NotificationChannel, string> = {
  in_app: 'In the app',
  email: 'Email',
};

type Edits = Record<string, boolean>; // `${type}:${channel}` -> enabled

export function PreferencesPanel() {
  const prefs = usePreferences();
  const save = useSavePreferences();
  const [edits, setEdits] = useState<Edits>({});
  const [error, setError] = useState<string | null>(null);
  const grouped = useMemo(() => {
    const map = new Map<notification.NotificationCategory, notification.NotificationPreference[]>();
    for (const p of prefs.data?.items ?? [])
      map.set(p.category, [...(map.get(p.category) ?? []), p]);
    return [...map.entries()];
  }, [prefs.data]);
  if (prefs.isPending) return <Skeleton className="h-64 w-full" />;
  if (prefs.isError)
    return <ErrorState message={errorMessage(prefs.error)} onRetry={() => prefs.refetch()} />;

  const value = (
    p: notification.NotificationPreference,
    channel: notification.NotificationChannel,
  ) =>
    edits[`${p.type}:${channel}`] ??
    p.channels.find((c) => c.channel === channel)?.enabled ??
    false;
  const changes = Object.keys(edits).length;

  return (
    <>
      <p className="mb-5 max-w-[68ch] text-sm text-text-secondary">
        Choose how you hear about each kind of update. Messages about your account and security
        always reach you.
      </p>
      <div className="grid gap-6">
        {grouped.map(([category, items]) => (
          <section
            key={category}
            aria-label={categoryLabel(category)}
            className="overflow-hidden rounded-lg border border-border bg-surface"
          >
            <h3 className="border-b border-border bg-surface-sunken/60 px-4 py-2 text-sm font-semibold">
              {categoryLabel(category)}
            </h3>
            <ul className="divide-y divide-divider">
              {items.map((p) => (
                <li
                  key={p.type}
                  className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 px-4 py-3"
                >
                  <div className="min-w-0 flex-1 basis-60">
                    <p className="font-medium">{p.label}</p>
                    <p className="text-sm text-text-secondary">{p.description}</p>
                  </div>
                  <div className="flex gap-5">
                    {p.channels.map((c) => (
                      <label
                        key={c.channel}
                        className="flex items-center gap-2 text-sm text-text-secondary"
                      >
                        <Switch
                          aria-label={`${p.label}: ${CHANNEL_LABEL[c.channel]}`}
                          checked={value(p, c.channel)}
                          onCheckedChange={(enabled) =>
                            setEdits((e) => {
                              const next = { ...e };
                              const original = c.enabled;
                              if (enabled === original) delete next[`${p.type}:${c.channel}`];
                              else next[`${p.type}:${c.channel}`] = enabled;
                              return next;
                            })
                          }
                        />
                        {CHANNEL_LABEL[c.channel]}
                      </label>
                    ))}
                  </div>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
      {changes > 0 && (
        <UnsavedBar
          actions={
            <>
              <Button onClick={() => setEdits({})} disabled={save.isPending}>
                Discard
              </Button>
              <Button
                variant="primary"
                loading={save.isPending}
                onClick={async () => {
                  setError(null);
                  try {
                    await save.mutateAsync(
                      Object.entries(edits).map(([key, enabled]) => {
                        const [type, channel] = key.split(':') as [
                          notification.NotificationType,
                          notification.NotificationChannel,
                        ];
                        return { type, channel, enabled };
                      }),
                    );
                    setEdits({});
                    toast.success('Notification preferences saved');
                  } catch (err) {
                    setError(errorMessage(err));
                  }
                }}
              >
                Save preferences
              </Button>
            </>
          }
        >
          <p>
            <strong className="font-semibold">{changes}</strong> unsaved{' '}
            {changes === 1 ? 'change' : 'changes'}
            {error && <span className="mt-1 block text-danger">{error}</span>}
          </p>
        </UnsavedBar>
      )}
    </>
  );
}
