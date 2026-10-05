import { cn } from '@/lib/cn';

/** Two or three mutually exclusive views of one list, kept in the URL by the caller. */
export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
  className,
}: {
  label: string;
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange: (value: T) => void;
  className?: string;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className={cn('inline-flex rounded border border-border-strong bg-surface p-0.5', className)}
    >
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            'h-8 rounded-sm px-3 text-base font-medium',
            value === o.value
              ? 'bg-brand-primary text-text-inverse'
              : 'text-text-secondary hover:bg-surface-hover hover:text-text-primary',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
