import { ConflictError } from '@a5/nest-kit';

function sqlState(err: unknown): string | undefined {
  return typeof err === 'object' && err !== null && 'code' in err
    ? String((err as { code: unknown }).code)
    : undefined;
}

/**
 * Translate the integrity triggers' SQLSTATEs (see migration 0001) into API errors. The services
 * check state before writing, so these surface only on races; the database stays the last line of
 * defence.
 */
export function mapIntegrityError(err: unknown, noun = 'attempt'): unknown {
  switch (sqlState(err)) {
    case 'A5A01':
      return new ConflictError(
        'ATTEMPT_CLOSED',
        `This ${noun} has already been submitted, so its answers can no longer change.`,
      );
    case 'A5A02':
      return new ConflictError(
        'ATTEMPT_FINAL',
        `This ${noun} is already graded. Record a score override to change its result.`,
      );
    case 'A5I01':
      return new ConflictError(
        'RECORD_IMMUTABLE',
        'This record is part of the permanent assessment history and cannot be changed.',
      );
    default:
      return err;
  }
}

/** Run `fn`, rethrowing integrity-trigger failures as API errors. */
export async function withIntegrityErrors<T>(fn: () => Promise<T>, noun?: string): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw mapIntegrityError(err, noun);
  }
}
