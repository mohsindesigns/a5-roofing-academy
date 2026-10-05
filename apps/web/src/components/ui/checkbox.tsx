import { forwardRef, type ComponentPropsWithoutRef } from 'react';
import { Checkbox as C, Switch as S } from 'radix-ui';
import { Check, Minus } from 'lucide-react';
import { cn } from '@/lib/cn';

export const Checkbox = forwardRef<HTMLButtonElement, ComponentPropsWithoutRef<typeof C.Root>>(
  function Checkbox({ className, ...props }, ref) {
    return (
      <C.Root
        ref={ref}
        className={cn(
          'inline-flex size-[18px] shrink-0 items-center justify-center rounded-sm border align-middle border-border-strong bg-surface transition-colors',
          'hover:border-text-tertiary data-[state=checked]:border-brand-primary data-[state=checked]:bg-brand-primary data-[state=indeterminate]:border-brand-primary data-[state=indeterminate]:bg-brand-primary',
          'disabled:cursor-not-allowed disabled:opacity-50',
          className,
        )}
        {...props}
      >
        <C.Indicator className="text-text-inverse">
          {props.checked === 'indeterminate' ? (
            <Minus className="size-3.5" strokeWidth={3} />
          ) : (
            <Check className="size-3.5" strokeWidth={3} />
          )}
        </C.Indicator>
      </C.Root>
    );
  },
);

export const Switch = forwardRef<HTMLButtonElement, ComponentPropsWithoutRef<typeof S.Root>>(
  function Switch({ className, ...props }, ref) {
    return (
      <S.Root
        ref={ref}
        className={cn(
          'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full bg-border-strong transition-colors data-[state=checked]:bg-success disabled:opacity-50',
          className,
        )}
        {...props}
      >
        <S.Thumb className="block size-4 translate-x-0.5 rounded-full bg-surface shadow-sm transition-transform data-[state=checked]:translate-x-[18px]" />
      </S.Root>
    );
  },
);
