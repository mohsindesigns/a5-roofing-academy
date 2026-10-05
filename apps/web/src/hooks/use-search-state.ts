import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router';

/**
 * List filters stored in the URL so they survive reloads, can be shared and work with the
 * back button. Changing any filter except `page` resets to page 1.
 */
export function useSearchState<T extends Record<string, string | undefined>>(defaults: T) {
  const [params, setParams] = useSearchParams();
  const state = useMemo(() => {
    const out: Record<string, string | undefined> = { ...defaults };
    for (const key of Object.keys(defaults)) {
      const v = params.get(key);
      if (v !== null) out[key] = v;
    }
    return out as T;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params]);
  const set = useCallback(
    (patch: Partial<T>) => {
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          for (const [k, v] of Object.entries(patch)) {
            if (v === undefined || v === '' || v === defaults[k]) next.delete(k);
            else next.set(k, String(v));
          }
          if (!('page' in patch)) next.delete('page');
          return next;
        },
        { replace: true },
      );
    },
    [setParams, defaults],
  );
  return [state, set] as const;
}
