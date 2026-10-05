import { ProviderError, isAbortError, type ProviderName } from './types.js';

export interface RetryPolicy {
  maxRetries: number;
  baseDelayMs: number;
  /** Upper bound of a single backoff delay. */
  maxDelayMs?: number;
  onRetry?: (err: ProviderError, attempt: number, delayMs: number) => void;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
      },
      { once: true },
    );
  });
}

/** Exponential backoff with full jitter: base · 2^attempt, randomized, capped. */
export function backoffDelay(attempt: number, baseDelayMs: number, maxDelayMs = 8_000): number {
  const ceiling = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
  return Math.round(ceiling / 2 + Math.random() * (ceiling / 2));
}

/** Retry an operation on retryable provider errors. Non-retryable errors are thrown immediately. */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  policy: RetryPolicy,
  signal?: AbortSignal,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      if (
        !(err instanceof ProviderError) ||
        !err.retryable ||
        attempt >= policy.maxRetries ||
        signal?.aborted
      )
        throw err;
      const delay = backoffDelay(attempt, policy.baseDelayMs, policy.maxDelayMs);
      policy.onRetry?.(err, attempt + 1, delay);
      await sleep(delay, signal);
    }
  }
}

/** AbortSignal that fires after `timeoutMs` or when `parent` aborts, whichever comes first. */
export function timeoutSignal(timeoutMs: number, parent?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return parent ? AbortSignal.any([timeout, parent]) : timeout;
}

/** Map an abort caused by our own timeout to a retryable provider timeout. */
export function abortToProviderError(
  provider: ProviderName,
  err: unknown,
  signal: AbortSignal | undefined,
): ProviderError | null {
  if (!isAbortError(err) && !(signal?.aborted ?? false)) return null;
  const reason = signal?.reason as { name?: string } | undefined;
  if (reason?.name === 'TimeoutError')
    return new ProviderError(
      provider,
      'timeout',
      'The AI provider did not respond in time.',
      undefined,
      { cause: err },
    );
  return new ProviderError(provider, 'aborted', 'The request was cancelled.', undefined, {
    cause: err,
    retryable: false,
  });
}
