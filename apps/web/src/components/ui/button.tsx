import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { Slot } from 'radix-ui';
import { cn } from '@/lib/cn';
import { Spinner } from './spinner';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'accent' | 'link';
type Size = 'sm' | 'md' | 'lg';

const variants: Record<Variant, string> = {
  primary:
    'bg-brand-primary text-text-inverse hover:bg-brand-primary-hover active:bg-brand-primary-active disabled:bg-border-strong',
  accent:
    'bg-brand-secondary text-text-inverse hover:bg-brand-secondary-hover disabled:bg-border-strong',
  secondary:
    'bg-surface text-text-primary border border-border-strong hover:bg-surface-hover active:bg-surface-selected disabled:text-text-tertiary',
  ghost:
    'text-text-secondary hover:bg-surface-hover hover:text-text-primary disabled:text-text-tertiary',
  danger: 'bg-danger text-text-inverse hover:brightness-95 disabled:bg-border-strong',
  link: 'text-information underline-offset-2 hover:underline px-0 h-auto',
};

const sizes: Record<Size, string> = {
  sm: 'h-[var(--a5-control-height-sm)] px-2.5 text-sm gap-1.5',
  md: 'h-[var(--a5-control-height)] px-3.5 text-base gap-2',
  lg: 'h-11 px-5 text-md gap-2',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  leading?: ReactNode;
  trailing?: ReactNode;
  asChild?: boolean;
  block?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'secondary',
    size = 'md',
    loading = false,
    leading,
    trailing,
    asChild,
    block,
    className,
    children,
    disabled,
    type,
    ...props
  },
  ref,
) {
  const Comp = asChild ? Slot.Root : 'button';
  return (
    <Comp
      ref={ref}
      type={asChild ? undefined : (type ?? 'button')}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded font-medium whitespace-nowrap transition-colors select-none disabled:cursor-not-allowed',
        variants[variant],
        variant !== 'link' && sizes[size],
        block && 'w-full',
        className,
      )}
      {...props}
    >
      {asChild ? (
        children
      ) : (
        <>
          {loading ? <Spinner size={size === 'lg' ? 18 : 14} /> : leading}
          {children}
          {trailing}
        </>
      )}
    </Comp>
  );
});

export const IconButton = forwardRef<HTMLButtonElement, ButtonProps & { label: string }>(
  function IconButton(
    { label, size = 'md', className, children, variant = 'ghost', ...props },
    ref,
  ) {
    return (
      <Button
        ref={ref}
        variant={variant}
        size={size}
        aria-label={label}
        title={label}
        className={cn(
          size === 'sm'
            ? 'w-[var(--a5-control-height-sm)] px-0'
            : size === 'lg'
              ? 'w-11 px-0'
              : 'w-[var(--a5-control-height)] px-0',
          className,
        )}
        {...props}
      >
        {children}
      </Button>
    );
  },
);
