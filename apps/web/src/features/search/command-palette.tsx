import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Dialog as D } from 'radix-ui';
import { BookOpen, FileText, Search, UserPlus, Users } from 'lucide-react';
import { create } from 'zustand';
import type { PageResult, identity, learning } from '@a5/contracts';
import { visibleNav } from '@/app/nav';
import { Spinner } from '@/components/ui';
import { usePermissions } from '@/features/auth/session';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import { api } from '@/lib/api/client';
import { cn } from '@/lib/cn';
import {
  MIN_REMOTE_QUERY,
  arrangeItems,
  filterLocal,
  isPaletteShortcut,
  moveActive,
  type PaletteItem,
} from './commands';

interface PaletteState {
  open: boolean;
  setOpen: (open: boolean) => void;
}
export const usePalette = create<PaletteState>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
}));

function useIsMac(): boolean {
  return typeof navigator !== 'undefined' && /mac|iphone|ipad/i.test(navigator.platform);
}

/** Button that opens the palette; shows the keyboard shortcut. */
export function SearchTrigger({
  collapsed = false,
  className,
}: {
  collapsed?: boolean;
  className?: string;
}) {
  const setOpen = usePalette((s) => s.setOpen);
  const mac = useIsMac();
  return (
    <button
      type="button"
      onClick={() => setOpen(true)}
      aria-haspopup="dialog"
      aria-keyshortcuts="Control+K Meta+K"
      className={cn(
        'flex h-8 w-full items-center gap-2.5 rounded border border-border bg-surface px-2 text-sm text-text-secondary hover:bg-surface-hover hover:text-text-primary',
        collapsed && 'justify-center px-0',
        className,
      )}
    >
      <Search aria-hidden className="size-4 shrink-0 text-text-tertiary" />
      {collapsed ? (
        <span className="sr-only">Search</span>
      ) : (
        <>
          <span className="flex-1 text-left">Search</span>
          <kbd className="rounded border border-border px-1 font-sans text-2xs text-text-tertiary">
            {mac ? '⌘K' : 'Ctrl K'}
          </kbd>
        </>
      )}
    </button>
  );
}

function usePeopleResults(q: string, enabled: boolean) {
  return useQuery({
    queryKey: ['palette', 'people', q],
    queryFn: ({ signal }) =>
      api.get<PageResult<identity.UserSummary>>(
        '/users',
        { q, pageSize: 5, status: 'active,invited' },
        signal,
      ),
    enabled: enabled && q.length >= MIN_REMOTE_QUERY,
    staleTime: 30_000,
  });
}

function useContentResults(q: string, enabled: boolean) {
  return useQuery({
    queryKey: ['palette', 'content', q],
    queryFn: ({ signal }) =>
      api.get<learning.SearchResult>('/learning/search', { q, limit: 5 }, signal),
    enabled: enabled && q.length >= MIN_REMOTE_QUERY,
    staleTime: 30_000,
  });
}

/**
 * Command palette (Ctrl/Cmd+K). It searches what the API can search: people (`/users?q=`),
 * programs and lessons (`/learning/search`), plus a local match over the navigation the viewer
 * can use. Lists the viewer may not read are never requested.
 */
export function CommandPalette() {
  const { open, setOpen } = usePalette();
  const navigate = useNavigate();
  const permissions = usePermissions();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const q = useDebouncedValue(query.trim(), 200);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isPaletteShortcut(e)) return;
      e.preventDefault();
      usePalette.getState().setOpen(!usePalette.getState().open);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    if (open) {
      setQuery('');
      setActive(0);
    }
  }, [open]);

  const canPeople = permissions.has('users.view');
  const canContent = permissions.hasAny(['programs.view', 'training.participate']);
  const canEdit = permissions.hasAny(['programs.update', 'lessons.update']);
  const people = usePeopleResults(q, open && canPeople);
  const content = useContentResults(q, open && canContent);

  const local = useMemo<PaletteItem[]>(() => {
    const nav: PaletteItem[] = visibleNav(permissions)
      .flatMap((s) => s.items)
      .map((i) => ({ id: `nav:${i.to}`, group: 'Go to', title: i.label, to: i.to, icon: i.icon }));
    const actions: PaletteItem[] = [];
    if (permissions.hasAll(['users.create'])) {
      actions.push({
        id: 'action:add-person',
        group: 'Actions',
        title: 'Add person',
        to: '/people/new',
        icon: UserPlus,
      });
    }
    if (permissions.has('programs.create')) {
      actions.push({
        id: 'action:new-program',
        group: 'Actions',
        title: 'New program',
        to: '/content/programs?create=1',
        icon: BookOpen,
      });
    }
    return filterLocal([...nav, ...actions], query);
  }, [permissions, query]);

  const remote = useMemo<PaletteItem[]>(() => {
    const items: PaletteItem[] = [];
    for (const u of people.data?.items ?? []) {
      items.push({
        id: `person:${u.id}`,
        group: 'People',
        title: u.displayName,
        subtitle: [u.jobTitle, u.teams.map((t) => t.name).join(', ')].filter(Boolean).join(' · '),
        to: `/people/${u.id}`,
        icon: Users,
      });
    }
    for (const p of content.data?.programs ?? []) {
      items.push({
        id: `program:${p.id}`,
        group: 'Programs',
        title: p.title,
        subtitle: p.status === 'published' ? undefined : `${p.status} program`,
        to:
          canEdit || !permissions.has('training.participate')
            ? `/content/programs/${p.id}`
            : `/training/${p.id}`,
        icon: BookOpen,
      });
    }
    for (const l of content.data?.lessons ?? []) {
      items.push({
        id: `lesson:${l.id}`,
        group: 'Lessons',
        title: l.title,
        subtitle: `${l.programTitle} · ${l.phaseTitle}`,
        to:
          canEdit || !permissions.has('training.participate')
            ? `/content/programs/${l.programId}?lesson=${l.id}`
            : `/training/${l.programId}/lessons/${l.id}`,
        icon: FileText,
      });
    }
    return items;
  }, [people.data, content.data, canEdit, permissions]);

  const { groups, flat } = arrangeItems([...local, ...remote]);
  const searching = q.length >= MIN_REMOTE_QUERY && (people.isFetching || content.isFetching);
  const failed = (canPeople && people.isError ? ['people'] : []).concat(
    canContent && content.isError ? ['programs and lessons'] : [],
  );
  const activeIndex = Math.min(active, Math.max(0, flat.length - 1));

  const choose = (item: PaletteItem) => {
    setOpen(false);
    navigate(item.to);
  };

  return (
    <D.Root open={open} onOpenChange={setOpen}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-40 bg-[rgb(28_27_25/0.36)]" />
        <D.Content
          aria-label="Search"
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            inputRef.current?.focus();
          }}
          className="fixed top-[10vh] left-1/2 z-50 flex max-h-[min(560px,80dvh)] w-[min(640px,calc(100vw-24px))] -translate-x-1/2 flex-col overflow-hidden rounded-lg bg-surface-elevated shadow-dialog"
        >
          <D.Title className="sr-only">Search</D.Title>
          <D.Description className="sr-only">
            Search people, programs and lessons, or jump to a page. Use the arrow keys to move and
            Enter to open.
          </D.Description>
          <div className="flex items-center gap-2.5 border-b border-divider px-4">
            <Search aria-hidden className="size-4 shrink-0 text-text-tertiary" />
            <input
              ref={inputRef}
              role="combobox"
              aria-expanded
              aria-controls={listId}
              aria-autocomplete="list"
              aria-activedescendant={flat[activeIndex] ? `${listId}-${activeIndex}` : undefined}
              aria-label="Search people, programs, lessons and pages"
              placeholder="Search people, programs, lessons and pages"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setActive(0);
              }}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                  e.preventDefault();
                  setActive(moveActive(activeIndex, e.key === 'ArrowDown' ? 1 : -1, flat.length));
                } else if (e.key === 'Enter' && flat[activeIndex]) {
                  e.preventDefault();
                  choose(flat[activeIndex]);
                }
              }}
              className="h-12 min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-text-tertiary"
            />
            {searching && <Spinner size={14} className="text-text-tertiary" />}
          </div>
          <div
            id={listId}
            role="listbox"
            aria-label="Results"
            className="min-h-0 flex-1 overflow-y-auto p-2"
          >
            {flat.length === 0 && (
              <p className="px-3 py-6 text-center text-sm text-text-secondary">
                {searching
                  ? 'Searching…'
                  : q.length > 0 && q.length < MIN_REMOTE_QUERY
                    ? 'Keep typing to search people, programs and lessons.'
                    : `Nothing matches “${query.trim()}”.`}
              </p>
            )}
            {groups.map((g) => (
              <div key={g.group} role="group" aria-label={g.group} className="mb-1">
                <p aria-hidden className="px-3 pt-2 pb-1 text-xs font-medium text-text-tertiary">
                  {g.group}
                </p>
                {g.items.map((item) => {
                  const index = flat.indexOf(item);
                  const isActive = index === activeIndex;
                  return (
                    <div
                      key={item.id}
                      id={`${listId}-${index}`}
                      role="option"
                      aria-selected={isActive}
                      onMouseMove={() => setActive(index)}
                      onClick={() => choose(item)}
                      className={cn(
                        'flex cursor-default items-center gap-3 rounded px-3 py-2',
                        isActive && 'bg-surface-selected',
                      )}
                    >
                      {item.icon && (
                        <item.icon aria-hidden className="size-4 shrink-0 text-text-tertiary" />
                      )}
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-base">{item.title}</span>
                        {item.subtitle && (
                          <span className="block truncate text-xs text-text-secondary">
                            {item.subtitle}
                          </span>
                        )}
                      </span>
                    </div>
                  );
                })}
              </div>
            ))}
            {failed.length > 0 && (
              <p role="status" className="px-3 py-2 text-xs text-danger">
                Search for {failed.join(' and ')} is unavailable right now. Pages above still work.
              </p>
            )}
          </div>
          <div className="flex items-center justify-between border-t border-divider px-4 py-2 text-xs text-text-tertiary">
            <span>Arrow keys to move · Enter to open · Esc to close</span>
          </div>
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}
