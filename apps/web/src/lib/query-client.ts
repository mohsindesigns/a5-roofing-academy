import { QueryClient } from '@tanstack/react-query';
import { ApiError } from './api/errors';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      gcTime: 10 * 60_000,
      refetchOnWindowFocus: true,
      // Retry transient failures only; 4xx responses are definitive.
      retry: (count, error) => {
        if (error instanceof ApiError)
          return (error.status === 0 || error.status >= 500) && count < 2;
        return count < 1;
      },
    },
    mutations: { retry: false },
  },
});
