import { useEffect, type ReactNode } from 'react';
import { Navigate, Outlet, useLocation } from 'react-router';
import type { PermissionKey } from '@a5/permissions';
import { Button, EmptyState, Skeleton } from '@/components/ui';
import { useMe, usePermissions } from '@/features/auth/session';
import { refreshSession } from '@/lib/api/client';
import { useAuth } from '@/lib/auth-store';

let bootstrapped = false;

/** Restores the session from the refresh cookie once per page load. */
export function useSessionBootstrap() {
  const status = useAuth((s) => s.status);
  useEffect(() => {
    if (bootstrapped || status !== 'loading') return;
    bootstrapped = true;
    void refreshSession().then((ok) => {
      if (!ok && useAuth.getState().status === 'loading') useAuth.getState().clear(null);
    });
  }, [status]);
  return status;
}

function SessionLoading() {
  return (
    <div
      className="flex min-h-dvh items-center justify-center"
      aria-busy="true"
      aria-label="Loading your session"
    >
      <div className="flex w-64 flex-col gap-3">
        <Skeleton className="h-6 w-32" />
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-3/4" />
      </div>
    </div>
  );
}

/** Routes that require a signed-in user. */
export function RequireAuth() {
  const status = useSessionBootstrap();
  const location = useLocation();
  const me = useMe();
  if (status === 'loading') return <SessionLoading />;
  if (status === 'anonymous') {
    const next = `${location.pathname}${location.search}`;
    return (
      <Navigate to={next === '/' ? '/login' : `/login?next=${encodeURIComponent(next)}`} replace />
    );
  }
  if (me.isPending) return <SessionLoading />;
  if (me.isError) {
    return (
      <div className="flex min-h-dvh items-center justify-center p-6">
        <EmptyState
          title="Your workspace could not be loaded"
          description="Check your connection and try again. If this keeps happening, contact your administrator."
          action={<Button onClick={() => me.refetch()}>Retry</Button>}
        />
      </div>
    );
  }
  return <Outlet />;
}

/** Pages for signed-out users only (sign-in, activation). */
export function RedirectIfAuthenticated({ children }: { children: ReactNode }) {
  const status = useSessionBootstrap();
  const location = useLocation();
  if (status === 'loading') return <SessionLoading />;
  if (status === 'authenticated') {
    const next = new URLSearchParams(location.search).get('next');
    return (
      <Navigate to={next && next.startsWith('/') && !next.startsWith('//') ? next : '/'} replace />
    );
  }
  return <>{children}</>;
}

/** Page-level permission gate with an explanatory state instead of a blank page. */
export function RequirePermission({
  any,
  all,
  children,
}: {
  any?: PermissionKey[];
  all?: PermissionKey[];
  children: ReactNode;
}) {
  const p = usePermissions();
  const allowed = (!all || p.hasAll(all)) && (!any || p.hasAny(any));
  if (!allowed) {
    return (
      <EmptyState
        title="You don't have access to this page"
        description="Your role does not include this area. If you need it for your work, ask your administrator to update your role."
        className="mt-10"
      />
    );
  }
  return <>{children}</>;
}
