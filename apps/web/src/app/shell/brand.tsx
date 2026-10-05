import { cn } from '@/lib/cn';

/** Temporary A5 mark until official brand assets are provided. */
export function BrandMark({ size = 28, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      aria-hidden
      className={cn('shrink-0', className)}
    >
      <rect width="32" height="32" rx="6" fill="var(--a5-brand-primary)" />
      <path
        d="M6 20 16 10l10 10"
        fill="none"
        stroke="#c8773f"
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M11 23h10" stroke="#fff" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  );
}

export function BrandLockup({ collapsed = false }: { collapsed?: boolean }) {
  return (
    <span className="flex min-w-0 items-center gap-2.5">
      <BrandMark />
      {!collapsed && (
        <span className="min-w-0 leading-tight">
          <span className="block truncate text-sm font-semibold text-text-primary">A5 Roofing</span>
          <span className="block truncate text-xs text-text-tertiary">Sales Academy</span>
        </span>
      )}
    </span>
  );
}
