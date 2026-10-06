import { useEffect, useRef } from 'react';
import { useBlocker } from 'react-router';
import { ConfirmDialog } from '@/components/ui';

/**
 * Warns before leaving a page with unsaved edits, both for in-app navigation (a dialog) and for
 * closing the tab (the browser's own prompt). Call `markClean()` right before a navigation that
 * follows a successful save so it is not intercepted.
 */
export function useUnsavedGuard(dirty: boolean) {
  const dirtyRef = useRef(dirty);
  useEffect(() => {
    dirtyRef.current = dirty;
  }, [dirty]);

  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      dirtyRef.current && currentLocation.pathname !== nextLocation.pathname,
  );

  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);

  const dialog = (
    <ConfirmDialog
      open={blocker.state === 'blocked'}
      onOpenChange={(open) => {
        if (!open && blocker.state === 'blocked') blocker.reset();
      }}
      title="Leave without saving?"
      description="You have changes that have not been saved. If you leave now they will be lost."
      confirmLabel="Leave without saving"
      tone="danger"
      onConfirm={() => {
        if (blocker.state === 'blocked') blocker.proceed();
      }}
    />
  );

  return {
    dialog,
    markClean: () => {
      dirtyRef.current = false;
    },
  };
}
