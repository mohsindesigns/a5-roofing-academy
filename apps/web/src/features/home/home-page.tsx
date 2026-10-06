import { Link } from 'react-router';
import { ArrowRight } from 'lucide-react';
import { PageHeader, Section } from '@/components/ui';
import { useMe, usePermissions } from '@/features/auth/session';
import { visibleNav } from '@/app/nav';
import { TraineeDashboard } from './trainee-dashboard';
import { RoleDashboards } from './role-sections';

/**
 * Starting point after sign-in. Role dashboards (trainee, manager, administrator) replace the
 * shortcut list as each area ships.
 */
export function HomePage() {
  const me = useMe();
  const permissions = usePermissions();
  const firstName = me.data?.user.firstName ?? '';
  const destinations = visibleNav(permissions)
    .flatMap((s) => s.items)
    .filter((i) => i.to !== '/');
  return (
    <>
      <PageHeader
        title={`Welcome back, ${firstName}`}
        description={me.data?.user.organizationName}
      />
      {permissions.has('training.participate') && (
        <div className="mb-8">
          <TraineeDashboard />
        </div>
      )}
      <RoleDashboards />
      {destinations.length > 1 && (
        <Section title="Go to">
          <ul className="grid gap-px overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-2 lg:grid-cols-3">
            {destinations.map((d) => (
              <li key={d.to} className="bg-surface">
                <Link
                  to={d.to}
                  className="group flex items-center gap-3 px-4 py-3.5 hover:bg-surface-hover"
                >
                  <d.icon aria-hidden className="size-4 text-text-tertiary" />
                  <span className="flex-1 font-medium">{d.label}</span>
                  <ArrowRight
                    aria-hidden
                    className="size-4 text-text-tertiary opacity-0 transition-opacity group-hover:opacity-100"
                  />
                </Link>
              </li>
            ))}
          </ul>
        </Section>
      )}
    </>
  );
}
