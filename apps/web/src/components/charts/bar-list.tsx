import { useState, type ReactNode } from 'react';
import { cn } from '@/lib/cn';

export interface BarDatum {
  key: string;
  label: ReactNode;
  value: number;
  /** Optional secondary text after the label (e.g. "12 people"). */
  meta?: ReactNode;
  href?: string;
}

/**
 * Horizontal bars for ranked magnitudes (completion by team, weakest areas). Thin bars from one
 * baseline, value at the tip in text ink, hover tooltip per bar, and a semantic list for
 * assistive technology. Single series: no legend; the section title names the measure.
 */
export function BarList({
  data,
  max,
  format = (n) => `${Math.round(n)}`,
  color = 'var(--a5-series-1)',
  emptyText = 'No data for this selection yet.',
  ariaLabel,
}: {
  data: BarDatum[];
  max?: number;
  format?: (n: number) => string;
  color?: string;
  emptyText?: string;
  ariaLabel: string;
}) {
  const [hover, setHover] = useState<string | null>(null);
  if (data.length === 0) return <p className="text-sm text-text-secondary">{emptyText}</p>;
  const top = max ?? Math.max(...data.map((d) => d.value), 1);
  return (
    <ul aria-label={ariaLabel} className="flex flex-col gap-2.5">
      {data.map((d) => {
        const pct = Math.max(0, Math.min(100, (d.value / top) * 100));
        return (
          <li
            key={d.key}
            className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1"
            onMouseEnter={() => setHover(d.key)}
            onMouseLeave={() => setHover(null)}
          >
            <span className="min-w-0 truncate text-sm text-text-primary">
              {d.label}
              {d.meta && <span className="ml-1.5 text-text-tertiary">{d.meta}</span>}
            </span>
            <span className="tabular text-sm font-medium text-text-primary">{format(d.value)}</span>
            <span
              className="relative col-span-2 h-2 rounded-r-[4px] bg-[var(--a5-chart-grid)]"
              aria-hidden
            >
              <span
                className={cn(
                  'absolute inset-y-0 left-0 rounded-r-[4px] transition-[width,opacity] duration-300',
                  hover && hover !== d.key && 'opacity-60',
                )}
                style={{ width: `${pct}%`, background: color }}
              />
            </span>
          </li>
        );
      })}
    </ul>
  );
}
