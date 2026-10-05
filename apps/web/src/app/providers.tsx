import { type ReactNode } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { Toaster, TooltipProvider } from '@/components/ui';
import { queryClient } from '@/lib/query-client';

export function Providers({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider delayDuration={350}>
        {children}
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}
