import { Suspense } from 'react';
import { NavLink, Navigate, Outlet } from 'react-router';
import { EmptyState, Skeleton } from '@/components/ui';
import { usePermissions } from '@/features/auth/session';
import { cn } from '@/lib/cn';
import { useDashboard } from '../api';
import { visibleCenterNav } from './nav';

function PageFallback() {
  return (
    <div className="flex flex-col gap-3" aria-busy="true" aria-label="Loading page">
      <Skeleton className="h-7 w-56" />
      <Skeleton className="h-4 w-80" />
      <Skeleton className="mt-6 h-40 w-full" />
    </div>
  );
}

/** Frame of the certification center: section navigation above whichever page is open. */
export function CertificationCenterLayout() {
  const permissions = usePermissions();
  const items = visibleCenterNav(permissions);
  // The approvals tab carries the number of requests waiting for the signed-in approver.
  const dashboard = useDashboard(permissions.has('certificates.view'));
  const pending = dashboard.data?.pendingApprovals ?? 0;

  if (items.length === 0) {
    return (
      <EmptyState
        title="You don't have access to the certification center"
        description="Your role does not include certification tools. If you need them for your work, ask your administrator to update your role."
        className="mt-10"
      />
    );
  }
  return (
    <>
      <nav
        aria-label="Certification center"
        className="-mx-4 mb-6 overflow-x-auto border-b border-border px-4 sm:-mx-6 sm:px-6 lg:mx-0 lg:px-0"
      >
        <ul className="flex gap-5">
          {items.map((item) => (
            <li key={item.to} className="shrink-0">
              <NavLink
                to={item.to}
                end={item.end}
                className={({ isActive }) =>
                  cn(
                    '-mb-px flex h-10 items-center gap-1.5 border-b-2 text-base font-medium whitespace-nowrap',
                    isActive
                      ? 'border-brand-secondary text-text-primary'
                      : 'border-transparent text-text-secondary hover:text-text-primary',
                  )
                }
              >
                {item.label}
                {item.label === 'Approvals' && pending > 0 && (
                  <span className="tabular rounded-sm bg-brand-secondary-soft px-1.5 text-xs font-semibold text-brand-secondary">
                    {pending}
                    <span className="sr-only"> waiting</span>
                  </span>
                )}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>
      <Suspense fallback={<PageFallback />}>
        <Outlet />
      </Suspense>
    </>
  );
}

/** `/certification-center`: the overview for people who can see certificates, else the first page they can use. */
export function CenterIndexRedirect() {
  const permissions = usePermissions();
  const first = visibleCenterNav(permissions)[0];
  if (!first) return null;
  return <Navigate to={first.to} replace />;
}
