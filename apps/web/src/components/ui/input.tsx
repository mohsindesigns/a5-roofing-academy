import {
  forwardRef,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '@/lib/cn';

const control =
  'w-full rounded border bg-surface text-text-primary placeholder:text-text-tertiary transition-colors ' +
  'border-border-strong hover:border-text-tertiary focus:border-information focus:outline-none focus:ring-2 focus:ring-information/20 ' +
  'disabled:cursor-not-allowed disabled:bg-surface-sunken disabled:text-text-tertiary ' +
  'aria-[invalid=true]:border-danger aria-[invalid=true]:focus:ring-danger/20';

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  leading?: ReactNode;
  trailing?: ReactNode;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, leading, trailing, ...props },
  ref,
) {
  if (!leading && !trailing) {
    return (
      <input
        ref={ref}
        className={cn(control, 'h-[var(--a5-control-height)] px-3 text-base', className)}
        {...props}
      />
    );
  }
  return (
    <div className="relative flex items-center">
      {leading && (
        <span className="pointer-events-none absolute left-2.5 flex text-text-tertiary">
          {leading}
        </span>
      )}
      <input
        ref={ref}
        className={cn(
          control,
          'h-[var(--a5-control-height)] text-base',
          leading ? 'pl-8' : 'pl-3',
          trailing ? 'pr-9' : 'pr-3',
          className,
        )}
        {...props}
      />
      {trailing && <span className="absolute right-2 flex">{trailing}</span>}
    </div>
  );
});

export const Textarea = forwardRef<
  HTMLTextAreaElement,
  TextareaHTMLAttributes<HTMLTextAreaElement>
>(function Textarea({ className, rows = 4, ...props }, ref) {
  return (
    <textarea
      ref={ref}
      rows={rows}
      className={cn(control, 'px-3 py-2 text-base leading-[22px]', className)}
      {...props}
    />
  );
});

/** Native select: fully accessible, works with mobile pickers, styled to match. */
export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(
  function Select({ className, children, ...props }, ref) {
    return (
      <div className="relative">
        <select
          ref={ref}
          className={cn(
            control,
            'h-[var(--a5-control-height)] appearance-none pl-3 pr-8 text-base',
            className,
          )}
          {...props}
        >
          {children}
        </select>
        <ChevronDown
          aria-hidden
          className="pointer-events-none absolute top-1/2 right-2.5 size-4 -translate-y-1/2 text-text-tertiary"
        />
      </div>
    );
  },
);
