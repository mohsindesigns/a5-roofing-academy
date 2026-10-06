import type { LucideIcon } from 'lucide-react';

/** One selectable row in the command palette. */
export interface PaletteItem {
  id: string;
  group: 'Go to' | 'Actions' | 'People' | 'Programs' | 'Lessons';
  title: string;
  subtitle?: string;
  to: string;
  icon?: LucideIcon;
}

const GROUP_ORDER: PaletteItem['group'][] = ['Go to', 'Actions', 'People', 'Programs', 'Lessons'];

function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * Local match for navigation entries: every word typed must start a word in the label. An empty
 * query matches everything, so the palette doubles as a menu when first opened.
 */
export function matchesQuery(label: string, query: string): boolean {
  const wanted = tokens(query);
  if (wanted.length === 0) return true;
  const words = tokens(label);
  return wanted.every((w) => words.some((word) => word.startsWith(w)));
}

export function filterLocal<T extends { title: string }>(items: T[], query: string): T[] {
  return items.filter((i) => matchesQuery(i.title, query));
}

/**
 * Items grouped in display order. Keyboard navigation moves through the flat list in the same
 * order, so `flat` and `groups` always agree.
 */
export function arrangeItems(items: PaletteItem[]): {
  groups: Array<{ group: PaletteItem['group']; items: PaletteItem[] }>;
  flat: PaletteItem[];
} {
  const groups = GROUP_ORDER.map((group) => ({
    group,
    items: items.filter((i) => i.group === group),
  })).filter((g) => g.items.length > 0);
  return { groups, flat: groups.flatMap((g) => g.items) };
}

/** Next active index when arrowing through `count` items; wraps at both ends. */
export function moveActive(current: number, delta: 1 | -1, count: number): number {
  if (count === 0) return 0;
  return (current + delta + count) % count;
}

export function isPaletteShortcut(
  e: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey'>,
) {
  return (e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'k';
}

/** Server-side searches need two characters (the learning search rejects shorter input). */
export const MIN_REMOTE_QUERY = 2;
