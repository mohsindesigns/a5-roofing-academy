import { type ReactNode } from 'react';
import { Dialog as D } from 'radix-ui';
import { X } from 'lucide-react';
import { cn } from '@/lib/cn';
import { IconButton } from './button';

export const DialogRoot = D.Root;
export const DialogTrigger = D.Trigger;
export const DialogClose = D.Close;

interface DialogContentProps {
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  className?: string;
  /** Prevent closing by outside click while a mutation is in flight. */
  dismissible?: boolean;
}

const widths = {
  sm: 'max-w-[420px]',
  md: 'max-w-[560px]',
  lg: 'max-w-[720px]',
  xl: 'max-w-[960px]',
};

export function DialogContent({
  title,
  description,
  children,
  footer,
  size = 'md',
  className,
  dismissible = true,
}: DialogContentProps) {
  return (
    <D.Portal>
      <D.Overlay className="fixed inset-0 z-40 bg-[rgb(28_27_25/0.36)]" />
      <D.Content
        onPointerDownOutside={(e) => !dismissible && e.preventDefault()}
        onEscapeKeyDown={(e) => !dismissible && e.preventDefault()}
        className={cn(
          'fixed top-1/2 left-1/2 z-50 flex max-h-[calc(100dvh-32px)] w-[calc(100vw-24px)] -translate-x-1/2 -translate-y-1/2 flex-col rounded-lg bg-surface-elevated shadow-dialog',
          widths[size],
          className,
        )}
      >
        <div className="flex items-start justify-between gap-4 border-b border-divider px-5 pt-4 pb-3">
          <div className="min-w-0">
            <D.Title className="text-lg font-semibold text-text-primary">{title}</D.Title>
            {description ? (
              <D.Description className="mt-0.5 text-sm text-text-secondary">
                {description}
              </D.Description>
            ) : (
              <D.Description className="sr-only">
                {typeof title === 'string' ? title : 'Dialog'}
              </D.Description>
            )}
          </div>
          <D.Close asChild>
            <IconButton label="Close" size="sm" className="-mr-1.5">
              <X className="size-4" />
            </IconButton>
          </D.Close>
        </div>
        {children && <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>}
        {footer && (
          <div className="flex flex-wrap items-center justify-end gap-2 border-t border-divider px-5 py-3">
            {footer}
          </div>
        )}
      </D.Content>
    </D.Portal>
  );
}

/** Side sheet for detail views and longer forms (full screen on phones). */
export function SheetContent({
  title,
  description,
  children,
  footer,
  className,
}: Omit<DialogContentProps, 'size'>) {
  return (
    <D.Portal>
      <D.Overlay className="fixed inset-0 z-40 bg-[rgb(28_27_25/0.28)]" />
      <D.Content
        className={cn(
          'fixed inset-y-0 right-0 z-50 flex w-full flex-col bg-surface-elevated shadow-dialog sm:w-[min(560px,92vw)]',
          className,
        )}
      >
        <div className="flex items-start justify-between gap-4 border-b border-divider px-5 py-4">
          <div className="min-w-0">
            <D.Title className="text-lg font-semibold">{title}</D.Title>
            {description ? (
              <D.Description className="mt-0.5 text-sm text-text-secondary">
                {description}
              </D.Description>
            ) : (
              <D.Description className="sr-only">
                {typeof title === 'string' ? title : 'Panel'}
              </D.Description>
            )}
          </div>
          <D.Close asChild>
            <IconButton label="Close" size="sm">
              <X className="size-4" />
            </IconButton>
          </D.Close>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer && (
          <div className="flex items-center justify-end gap-2 border-t border-divider px-5 py-3">
            {footer}
          </div>
        )}
      </D.Content>
    </D.Portal>
  );
}
