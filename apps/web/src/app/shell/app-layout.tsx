import { Suspense } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router';
import { PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { IconButton, Skeleton, Tooltip } from '@/components/ui';
import { usePermissions } from '@/features/auth/session';
import { cn } from '@/lib/cn';
import { visibleNav, type NavItem } from '../nav';
import { BrandLockup, BrandMark } from './brand';
import { useUi } from './ui-store';
import { NotificationBell } from '@/features/notifications/notification-bell';
import { useNotificationStream } from '@/features/notifications/use-notification-stream';
import { UserMenu } from './user-menu';
import { CommandPalette, SearchTrigger } from '@/features/search/command-palette';

function isActive(item: NavItem, pathname: string): boolean {
  if (item.to === '/') return pathname === '/';
  return [item.to, ...(item.match ?? [])].some(
    (p) => pathname === p || pathname.startsWith(`${p}/`),
  );
}

function SidebarLink({
  item,
  collapsed,
  active,
}: {
  item: NavItem;
  collapsed: boolean;
  active: boolean;
}) {
  const link = (
    <NavLink
      to={item.to}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'group flex h-8 items-center gap-2.5 rounded px-2 text-base font-medium transition-colors',
        active
          ? 'bg-surface text-text-primary shadow-[0_0_0_1px_var(--a5-border)]'
          : 'text-text-secondary hover:bg-surface-hover hover:text-text-primary',
        collapsed && 'justify-center px-0',
      )}
    >
      <item.icon
        aria-hidden
        className={cn(
          'size-4 shrink-0',
          active ? 'text-brand-secondary' : 'text-text-tertiary group-hover:text-text-secondary',
        )}
      />
      {!collapsed && <span className="truncate">{item.label}</span>}
      {collapsed && <span className="sr-only">{item.label}</span>}
    </NavLink>
  );
  return collapsed ? (
    <Tooltip content={item.label} side="right">
      {link}
    </Tooltip>
  ) : (
    link
  );
}

function Sidebar() {
  const permissions = usePermissions();
  const { pathname } = useLocation();
  const { sidebarCollapsed: collapsed, toggleSidebar } = useUi();
  const sections = visibleNav(permissions);
  return (
    <aside
      className={cn(
        'sticky top-0 hidden h-dvh shrink-0 flex-col border-r border-border lg:flex',
        collapsed ? 'w-[var(--a5-sidebar-collapsed)]' : 'w-[var(--a5-sidebar-width)]',
      )}
    >
      <div className={cn('flex h-14 items-center gap-2 px-3', collapsed && 'justify-center px-0')}>
        <NavLink to="/" className="min-w-0 flex-1 rounded" aria-label="A5 Sales Academy home">
          <BrandLockup collapsed={collapsed} />
        </NavLink>
      </div>
      <div className="px-2.5 pb-3">
        <SearchTrigger collapsed={collapsed} />
      </div>
      <nav aria-label="Main" className="flex-1 overflow-y-auto px-2.5 pb-4">
        {sections.map((section, i) => (
          <div key={section.label ?? i} className={cn(i > 0 && 'mt-5')}>
            {section.label && !collapsed && (
              <p className="mb-1 px-2 text-xs font-medium text-text-tertiary">{section.label}</p>
            )}
            {section.label && collapsed && <div className="mx-2 mb-2 h-px bg-divider" />}
            <ul className="flex flex-col gap-0.5">
              {section.items.map((item) => (
                <li key={item.to}>
                  <SidebarLink
                    item={item}
                    collapsed={collapsed}
                    active={isActive(item, pathname)}
                  />
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>
      <div
        className={cn(
          'flex items-center gap-1 border-t border-border p-2',
          collapsed && 'flex-col',
        )}
      >
        <div className="min-w-0 flex-1">
          <UserMenu collapsed={collapsed} />
        </div>
        <NotificationBell />
        <IconButton
          label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          size="sm"
          onClick={toggleSidebar}
        >
          {collapsed ? <PanelLeftOpen className="size-4" /> : <PanelLeftClose className="size-4" />}
        </IconButton>
      </div>
    </aside>
  );
}

function MobileTopBar() {
  return (
    <header className="sticky top-0 z-30 flex h-14 items-center justify-between border-b border-border bg-background/95 px-4 backdrop-blur lg:hidden">
      <NavLink to="/" aria-label="A5 Sales Academy home" className="flex items-center gap-2">
        <BrandMark size={26} />
        <span className="text-sm font-semibold">Sales Academy</span>
      </NavLink>
      <div className="flex items-center gap-1">
        <SearchTrigger collapsed className="size-9 w-9 border-0" />
        <NotificationBell />
        <UserMenu compact />
      </div>
    </header>
  );
}

function MobileTabBar() {
  const permissions = usePermissions();
  const { pathname } = useLocation();
  const items = visibleNav(permissions)
    .flatMap((s) => s.items)
    .filter((i) => i.mobile)
    .slice(0, 4);
  if (items.length < 2) return null;
  return (
    <nav
      aria-label="Primary"
      className="fixed inset-x-0 bottom-0 z-30 border-t border-border bg-surface/95 pb-[env(safe-area-inset-bottom)] backdrop-blur lg:hidden"
    >
      <ul
        className="grid"
        style={{ gridTemplateColumns: `repeat(${items.length}, minmax(0, 1fr))` }}
      >
        {items.map((item) => {
          const active = isActive(item, pathname);
          return (
            <li key={item.to}>
              <NavLink
                to={item.to}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'flex h-14 flex-col items-center justify-center gap-0.5 text-2xs font-medium',
                  active ? 'text-text-primary' : 'text-text-tertiary',
                )}
              >
                <item.icon aria-hidden className={cn('size-5', active && 'text-brand-secondary')} />
                {item.label}
              </NavLink>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

function RouteFallback() {
  return (
    <div className="flex flex-col gap-3" aria-busy="true" aria-label="Loading page">
      <Skeleton className="h-7 w-56" />
      <Skeleton className="h-4 w-80" />
      <Skeleton className="mt-6 h-40 w-full" />
    </div>
  );
}

export function AppLayout() {
  useNotificationStream();
  return (
    <div className="flex min-h-dvh">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded focus:bg-surface focus:px-3 focus:py-2"
      >
        Skip to content
      </a>
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <MobileTopBar />
        <main
          id="main"
          className="mx-auto w-full max-w-[1280px] flex-1 px-4 pt-5 pb-24 sm:px-6 lg:px-10 lg:pt-8 lg:pb-12"
        >
          <Suspense fallback={<RouteFallback />}>
            <Outlet />
          </Suspense>
        </main>
      </div>
      <MobileTabBar />
      <CommandPalette />
    </div>
  );
}
