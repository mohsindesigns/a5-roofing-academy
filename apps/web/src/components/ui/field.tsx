import { cloneElement, isValidElement, useId, type ReactElement, type ReactNode } from 'react';
import { cn } from '@/lib/cn';

interface FieldProps {
  label: ReactNode;
  /** The control; receives id, aria-invalid and aria-describedby. */
  children: ReactElement<Record<string, unknown>>;
  hint?: ReactNode;
  error?: string | undefined;
  required?: boolean;
  optional?: boolean;
  className?: string;
  /** Visually hide the label (still announced). */
  hideLabel?: boolean;
}

/** Label + control + hint + error with correct ARIA wiring. */
export function Field({
  label,
  children,
  hint,
  error,
  required,
  optional,
  className,
  hideLabel,
}: FieldProps) {
  const id = useId();
  const controlId = (children.props.id as string | undefined) ?? `${id}-control`;
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined;
  const control = isValidElement(children)
    ? cloneElement(children, {
        id: controlId,
        'aria-invalid': error ? true : undefined,
        'aria-describedby': describedBy,
        'aria-required': required || undefined,
      })
    : children;
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <label
        htmlFor={controlId}
        className={cn('text-sm font-medium text-text-primary', hideLabel && 'sr-only')}
      >
        {label}
        {required && (
          <span aria-hidden className="ml-0.5 text-danger">
            *
          </span>
        )}
        {optional && <span className="ml-1.5 font-normal text-text-tertiary">Optional</span>}
      </label>
      {control}
      {hint && !error && (
        <p id={hintId} className="text-xs text-text-tertiary">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} role="alert" className="text-xs font-medium text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

export function FieldGroup({
  title,
  description,
  children,
  className,
}: {
  title?: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <fieldset className={cn('grid gap-4', className)}>
      {title && (
        <legend className="mb-1">
          <span className="text-md font-semibold text-text-primary">{title}</span>
          {description && (
            <span className="mt-0.5 block text-sm text-text-secondary">{description}</span>
          )}
        </legend>
      )}
      {children}
    </fieldset>
  );
}
