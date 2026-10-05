/** Poll until `check` returns a truthy value or the timeout elapses. */
export async function waitFor<T>(
  check: () => Promise<T | null | undefined | false> | T | null | undefined | false,
  { timeoutMs = 5_000, intervalMs = 25, message = 'condition' } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (err) {
      lastError = err;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Timed out waiting for ${message}${lastError ? `: ${String(lastError)}` : ''}`);
}
