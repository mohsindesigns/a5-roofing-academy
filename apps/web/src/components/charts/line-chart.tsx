import { useEffect, useMemo, useRef, useState } from 'react';
import { cn } from '@/lib/cn';

export interface LinePoint {
  x: string; // ISO date or label
  y: number | null;
}

export interface LineSeries {
  key: string;
  label: string;
  points: LinePoint[];
}

const SLOTS = [
  'var(--a5-series-1)',
  'var(--a5-series-2)',
  'var(--a5-series-3)',
  'var(--a5-series-4)',
];
const MARGIN = { top: 12, right: 44, bottom: 26, left: 36 };

function niceTicks(min: number, max: number, count = 4): number[] {
  const span = max - min || 1;
  const raw = span / count;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => span / s <= count) ?? raw;
  const ticks: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max + 1e-9; v += step)
    ticks.push(Math.round(v * 100) / 100);
  return ticks;
}

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setWidth(entry?.contentRect.width ?? 0));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

/**
 * Line chart for change over time (one to four series, one y-axis). 2px lines, end dots with a
 * surface ring, hairline grid, crosshair + tooltip on hover, legend for 2+ series, direct end
 * labels, and a table view for assistive technology and print.
 */
export function LineChart({
  series,
  height = 220,
  yDomain,
  formatY = (n) => `${Math.round(n)}`,
  formatX = (x) => new Date(x).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
  ariaLabel,
  className,
}: {
  series: LineSeries[];
  height?: number;
  yDomain?: [number, number];
  formatY?: (n: number) => string;
  formatX?: (x: string) => string;
  ariaLabel: string;
  className?: string;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const shown = series.slice(0, 4);
  const xs = useMemo(
    () => [...new Set(shown.flatMap((s) => s.points.map((p) => p.x)))].sort(),
    [shown],
  );
  const values = shown.flatMap((s) =>
    s.points.map((p) => p.y).filter((v): v is number => v !== null),
  );
  if (xs.length === 0 || values.length === 0) {
    return <p className="text-sm text-text-secondary">Not enough activity yet to show a trend.</p>;
  }
  const [y0, y1] = yDomain ?? [Math.min(0, ...values), Math.max(...values) * 1.1 || 1];
  const innerW = Math.max(0, width - MARGIN.left - MARGIN.right);
  const innerH = height - MARGIN.top - MARGIN.bottom;
  const x = (i: number) =>
    MARGIN.left + (xs.length === 1 ? innerW / 2 : (i / (xs.length - 1)) * innerW);
  const y = (v: number) => MARGIN.top + innerH - ((v - y0) / (y1 - y0 || 1)) * innerH;
  const ticks = niceTicks(y0, y1);
  const xLabelEvery = Math.max(1, Math.ceil(xs.length / Math.max(2, Math.floor(innerW / 80))));

  const path = (s: LineSeries) => {
    let d = '';
    let pen = false;
    for (const [i, xv] of xs.entries()) {
      const p = s.points.find((pt) => pt.x === xv);
      if (!p || p.y === null) {
        pen = false;
        continue;
      }
      d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.y).toFixed(1)}`;
      pen = true;
    }
    return d;
  };

  return (
    <figure className={cn('m-0', className)}>
      {shown.length > 1 && (
        <figcaption className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-text-secondary">
          {shown.map((s, i) => (
            <span key={s.key} className="inline-flex items-center gap-1.5">
              <span
                aria-hidden
                className="h-0.5 w-3 rounded-full"
                style={{ background: SLOTS[i] }}
              />
              {s.label}
            </span>
          ))}
        </figcaption>
      )}
      <div ref={ref} className="relative" style={{ height }}>
        {width > 0 && (
          <svg
            width={width}
            height={height}
            role="img"
            aria-label={ariaLabel}
            onPointerMove={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              const px = e.clientX - rect.left;
              const idx =
                xs.length === 1 ? 0 : Math.round(((px - MARGIN.left) / innerW) * (xs.length - 1));
              setHover(Math.max(0, Math.min(xs.length - 1, idx)));
            }}
            onPointerLeave={() => setHover(null)}
            className="overflow-visible"
          >
            {ticks.map((t) => (
              <g key={t}>
                <line
                  x1={MARGIN.left}
                  x2={width - MARGIN.right}
                  y1={y(t)}
                  y2={y(t)}
                  stroke="var(--a5-chart-grid)"
                  strokeWidth={1}
                />
                <text
                  x={MARGIN.left - 8}
                  y={y(t)}
                  dy="0.32em"
                  textAnchor="end"
                  className="fill-[var(--a5-text-tertiary)] text-[11px] tabular-nums"
                >
                  {formatY(t)}
                </text>
              </g>
            ))}
            {xs.map((xv, i) =>
              i % xLabelEvery === 0 || i === xs.length - 1 ? (
                <text
                  key={xv}
                  x={x(i)}
                  y={height - 6}
                  textAnchor="middle"
                  className="fill-[var(--a5-text-tertiary)] text-[11px]"
                >
                  {formatX(xv)}
                </text>
              ) : null,
            )}
            {hover !== null && (
              <line
                x1={x(hover)}
                x2={x(hover)}
                y1={MARGIN.top}
                y2={MARGIN.top + innerH}
                stroke="var(--a5-border-strong)"
                strokeWidth={1}
              />
            )}
            {shown.map((s, i) => (
              <path
                key={s.key}
                d={path(s)}
                fill="none"
                stroke={SLOTS[i]}
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            ))}
            {shown.map((s, i) => {
              const last = [...s.points].reverse().find((p) => p.y !== null);
              if (!last || last.y === null) return null;
              const li = xs.indexOf(last.x);
              return (
                <g key={s.key}>
                  <circle
                    cx={x(li)}
                    cy={y(last.y)}
                    r={4}
                    fill={SLOTS[i]}
                    stroke="var(--a5-surface)"
                    strokeWidth={2}
                  />
                  <text
                    x={x(li) + 8}
                    y={y(last.y)}
                    dy="0.32em"
                    className="fill-[var(--a5-text-secondary)] text-[11px] font-medium tabular-nums"
                  >
                    {formatY(last.y)}
                  </text>
                </g>
              );
            })}
            {hover !== null &&
              shown.map((s, i) => {
                const p = s.points.find((pt) => pt.x === xs[hover]);
                return p && p.y !== null ? (
                  <circle
                    key={s.key}
                    cx={x(hover)}
                    cy={y(p.y)}
                    r={4}
                    fill={SLOTS[i]}
                    stroke="var(--a5-surface)"
                    strokeWidth={2}
                  />
                ) : null;
              })}
          </svg>
        )}
        {hover !== null && width > 0 && (
          <div
            role="presentation"
            className="pointer-events-none absolute top-0 z-10 min-w-[140px] rounded border border-border bg-surface-elevated px-2.5 py-2 text-xs shadow-popover"
            style={{ left: Math.min(Math.max(0, x(hover) + 12), width - 160) }}
          >
            <p className="mb-1 font-medium text-text-primary">{formatX(xs[hover]!)}</p>
            {shown.map((s, i) => {
              const p = s.points.find((pt) => pt.x === xs[hover]);
              return (
                <p key={s.key} className="flex items-center gap-1.5 text-text-secondary">
                  <span
                    aria-hidden
                    className="size-2 rounded-full"
                    style={{ background: SLOTS[i] }}
                  />
                  <span className="flex-1">{s.label}</span>
                  <span className="tabular font-medium text-text-primary">
                    {p?.y === null || p === undefined ? '—' : formatY(p.y)}
                  </span>
                </p>
              );
            })}
          </div>
        )}
      </div>
      <details className="mt-1 text-xs text-text-tertiary">
        <summary className="cursor-pointer select-none hover:text-text-secondary">
          View as table
        </summary>
        <table className="mt-2 w-full text-left text-sm text-text-primary">
          <thead>
            <tr className="text-xs text-text-tertiary">
              <th className="py-1 font-medium">Date</th>
              {shown.map((s) => (
                <th key={s.key} className="py-1 font-medium">
                  {s.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {xs.map((xv) => (
              <tr key={xv} className="border-t border-divider">
                <td className="py-1">{formatX(xv)}</td>
                {shown.map((s) => {
                  const p = s.points.find((pt) => pt.x === xv);
                  return (
                    <td key={s.key} className="tabular py-1">
                      {p?.y === null || p === undefined ? '—' : formatY(p.y)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}
