import { create } from 'zustand';
import { Toast as T } from 'radix-ui';
import { CheckCircle2, CircleAlert, X } from 'lucide-react';
import { cn } from '@/lib/cn';

interface ToastItem {
  id: number;
  title: string;
  description?: string;
  tone: 'success' | 'danger' | 'neutral';
}

interface ToastState {
  items: ToastItem[];
  push: (t: Omit<ToastItem, 'id'>) => void;
  dismiss: (id: number) => void;
}

let seq = 0;
const useToasts = create<ToastState>((set) => ({
  items: [],
  push: (t) => set((s) => ({ items: [...s.items.slice(-3), { ...t, id: ++seq }] })),
  dismiss: (id) => set((s) => ({ items: s.items.filter((i) => i.id !== id) })),
}));

export const toast = {
  success: (title: string, description?: string) =>
    useToasts.getState().push({ title, description, tone: 'success' }),
  error: (title: string, description?: string) =>
    useToasts.getState().push({ title, description, tone: 'danger' }),
  info: (title: string, description?: string) =>
    useToasts.getState().push({ title, description, tone: 'neutral' }),
};

export function Toaster() {
  const { items, dismiss } = useToasts();
  return (
    <T.Provider swipeDirection="right" duration={5000}>
      {items.map((t) => (
        <T.Root
          key={t.id}
          onOpenChange={(open) => !open && dismiss(t.id)}
          className="flex items-start gap-3 rounded-lg border border-border bg-surface-elevated px-4 py-3 shadow-popover"
        >
          {t.tone === 'success' ? (
            <CheckCircle2 aria-hidden className="mt-0.5 size-4 shrink-0 text-success" />
          ) : t.tone === 'danger' ? (
            <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-danger" />
          ) : null}
          <div className="min-w-0 flex-1">
            <T.Title className={cn('text-sm font-semibold', t.tone === 'danger' && 'text-danger')}>
              {t.title}
            </T.Title>
            {t.description && (
              <T.Description className="mt-0.5 text-sm text-text-secondary">
                {t.description}
              </T.Description>
            )}
          </div>
          <T.Close
            aria-label="Dismiss"
            className="rounded p-0.5 text-text-tertiary hover:text-text-primary"
          >
            <X className="size-3.5" />
          </T.Close>
        </T.Root>
      ))}
      <T.Viewport className="fixed right-0 bottom-0 z-[60] flex w-full max-w-[400px] flex-col gap-2 p-4 outline-none" />
    </T.Provider>
  );
}
