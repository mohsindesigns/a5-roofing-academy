import { type ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { useUi } from './ui-store';

/** Sticky bar for pages with batched edits (permissions, matrix, builders). */
export function UnsavedBar({ children, actions }: { children: ReactNode; actions: ReactNode }) {
  const collapsed = useUi((s) => s.sidebarCollapsed);
  return (
    <div
      role="region"
      aria-label="Unsaved changes"
      className={cn(
        'fixed inset-x-0 bottom-16 z-30 border-t border-border bg-surface/95 backdrop-blur lg:bottom-0',
        collapsed ? 'lg:left-[var(--a5-sidebar-collapsed)]' : 'lg:left-[var(--a5-sidebar-width)]',
      )}
    >
      <div className="mx-auto flex max-w-[1280px] flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6 lg:px-10">
        <div className="text-sm">{children}</div>
        <div className="flex gap-2">{actions}</div>
      </div>
    </div>
  );
}
