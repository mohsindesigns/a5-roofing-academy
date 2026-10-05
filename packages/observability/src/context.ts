import { AsyncLocalStorage } from 'node:async_hooks';

export interface RequestContext {
  requestId: string;
  /** Correlates work across services and events; defaults to the originating request id. */
  correlationId: string;
  /** Event that triggered this unit of work, when processing events. */
  causationId?: string | null;
  userId?: string | null;
  organizationId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn);
}

export function getContext(): RequestContext | undefined {
  return storage.getStore();
}

/** Mutate the active context (e.g. once authentication resolved the user). */
export function patchContext(patch: Partial<RequestContext>): void {
  const current = storage.getStore();
  if (current) Object.assign(current, patch);
}
