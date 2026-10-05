import { type ReactNode } from 'react';
import { Tooltip as T } from 'radix-ui';

export const TooltipProvider = T.Provider;

export function Tooltip({
  content,
  children,
  side = 'top',
}: {
  content: ReactNode;
  children: ReactNode;
  side?: 'top' | 'right' | 'bottom' | 'left';
}) {
  return (
    <T.Root delayDuration={350}>
      <T.Trigger asChild>{children}</T.Trigger>
      <T.Portal>
        <T.Content
          side={side}
          sideOffset={6}
          className="z-50 max-w-[260px] rounded bg-brand-primary px-2 py-1 text-xs text-text-inverse shadow-popover"
        >
          {content}
        </T.Content>
      </T.Portal>
    </T.Root>
  );
}
