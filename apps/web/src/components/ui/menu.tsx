import { type ReactNode } from 'react';
import { DropdownMenu as M } from 'radix-ui';
import { cn } from '@/lib/cn';

export const MenuRoot = M.Root;
export const MenuTrigger = M.Trigger;

export function MenuContent({
  children,
  align = 'end',
  className,
}: {
  children: ReactNode;
  align?: 'start' | 'end' | 'center';
  className?: string;
}) {
  return (
    <M.Portal>
      <M.Content
        align={align}
        sideOffset={6}
        className={cn(
          'z-50 min-w-[200px] rounded-lg border border-border bg-surface-elevated p-1 shadow-popover',
          className,
        )}
      >
        {children}
      </M.Content>
    </M.Portal>
  );
}

export function MenuItem({
  children,
  onSelect,
  icon,
  tone,
  disabled,
  asChild,
}: {
  children: ReactNode;
  onSelect?: (e: Event) => void;
  icon?: ReactNode;
  tone?: 'danger';
  disabled?: boolean;
  asChild?: boolean;
}) {
  return (
    <M.Item
      asChild={asChild}
      disabled={disabled}
      onSelect={onSelect}
      className={cn(
        'flex h-8 cursor-default items-center gap-2 rounded px-2 text-base outline-none select-none data-[disabled]:opacity-50 data-[highlighted]:bg-surface-hover',
        tone === 'danger' ? 'text-danger' : 'text-text-primary',
      )}
    >
      {asChild ? (
        children
      ) : (
        <>
          {icon && <span className="flex size-4 text-text-tertiary">{icon}</span>}
          {children}
        </>
      )}
    </M.Item>
  );
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return (
    <M.Label className="px-2 pt-1.5 pb-1 text-xs font-medium text-text-tertiary">
      {children}
    </M.Label>
  );
}

export function MenuSeparator() {
  return <M.Separator className="my-1 h-px bg-divider" />;
}
