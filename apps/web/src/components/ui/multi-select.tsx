import { useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Popover } from 'radix-ui';
import { Check, X } from 'lucide-react';
import { cn } from '@/lib/cn';
import { Spinner } from './spinner';

export interface Option {
  value: string;
  label: string;
  description?: string;
}

interface MultiSelectProps {
  options: Option[];
  value: string[];
  onChange: (value: string[]) => void;
  placeholder?: string;
  /** Async search: called with the query; options are then provided by the caller. */
  onQueryChange?: (q: string) => void;
  loading?: boolean;
  /** Labels for selected values that may not be in the current option list (async search). */
  selectedLabels?: Record<string, string>;
  id?: string;
  'aria-invalid'?: boolean;
  'aria-describedby'?: string;
  max?: number;
  emptyText?: string;
}

/** Accessible multi-select combobox with removable selections. */
export function MultiSelect({
  options,
  value,
  onChange,
  placeholder = 'Search…',
  onQueryChange,
  loading,
  selectedLabels = {},
  id,
  max,
  emptyText = 'No matches',
  ...aria
}: MultiSelectProps) {
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const labelOf = (v: string) =>
    options.find((o) => o.value === v)?.label ?? selectedLabels[v] ?? 'Unknown';
  const visible = useMemo(
    () =>
      onQueryChange
        ? options
        : options.filter((o) => o.label.toLowerCase().includes(query.trim().toLowerCase())),
    [options, query, onQueryChange],
  );
  const full = max !== undefined && value.length >= max;

  const toggle = (v: string) => {
    if (value.includes(v)) onChange(value.filter((x) => x !== v));
    else if (!full) onChange([...value, v]);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setOpen(true);
      setActive((a) => Math.min(visible.length - 1, a + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === 'Enter') {
      if (open && visible[active]) {
        e.preventDefault();
        toggle(visible[active]!.value);
      }
    } else if (e.key === 'Backspace' && query === '' && value.length) {
      onChange(value.slice(0, -1));
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  };

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Anchor asChild>
        <div
          className={cn(
            'flex min-h-[var(--a5-control-height)] w-full flex-wrap items-center gap-1 rounded border border-border-strong bg-surface px-1.5 py-1 focus-within:border-information focus-within:ring-2 focus-within:ring-information/20',
            aria['aria-invalid'] && 'border-danger',
          )}
          onClick={() => inputRef.current?.focus()}
        >
          {value.map((v) => (
            <span
              key={v}
              className="inline-flex h-6 items-center gap-1 rounded-sm bg-surface-sunken pr-0.5 pl-2 text-sm"
            >
              {labelOf(v)}
              <button
                type="button"
                aria-label={`Remove ${labelOf(v)}`}
                className="rounded-sm p-0.5 text-text-tertiary hover:bg-surface-selected hover:text-text-primary"
                onClick={(e) => {
                  e.stopPropagation();
                  toggle(v);
                }}
              >
                <X className="size-3" />
              </button>
            </span>
          ))}
          <input
            ref={inputRef}
            id={id}
            role="combobox"
            aria-expanded={open}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={
              open && visible[active] ? `${listId}-${visible[active]!.value}` : undefined
            }
            aria-invalid={aria['aria-invalid']}
            aria-describedby={aria['aria-describedby']}
            className="h-6 min-w-[120px] flex-1 bg-transparent px-1 text-base outline-none placeholder:text-text-tertiary"
            placeholder={value.length ? '' : placeholder}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
              setOpen(true);
              onQueryChange?.(e.target.value);
            }}
            onFocus={() => setOpen(true)}
            onKeyDown={onKeyDown}
          />
          {loading && <Spinner size={14} className="mr-1 text-text-tertiary" />}
        </div>
      </Popover.Anchor>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={4}
          onOpenAutoFocus={(e) => e.preventDefault()}
          className="z-50 max-h-64 w-[var(--radix-popover-trigger-width)] min-w-[240px] overflow-y-auto rounded-lg border border-border bg-surface-elevated p-1 shadow-popover"
        >
          <ul id={listId} role="listbox" aria-multiselectable="true">
            {visible.length === 0 && (
              <li className="px-2 py-2 text-sm text-text-tertiary">
                {loading ? 'Searching…' : emptyText}
              </li>
            )}
            {visible.map((o, i) => {
              const selected = value.includes(o.value);
              return (
                <li
                  key={o.value}
                  id={`${listId}-${o.value}`}
                  role="option"
                  aria-selected={selected}
                  aria-disabled={!selected && full}
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => toggle(o.value)}
                  className={cn(
                    'flex cursor-default items-center gap-2 rounded px-2 py-1.5',
                    i === active && 'bg-surface-hover',
                    !selected && full && 'opacity-50',
                  )}
                >
                  <span className="flex size-4 items-center justify-center text-brand-primary">
                    {selected && <Check className="size-4" />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-base">{o.label}</span>
                    {o.description && (
                      <span className="block truncate text-xs text-text-tertiary">
                        {o.description}
                      </span>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
