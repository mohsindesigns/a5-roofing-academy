import type { FieldValues, Path, UseFormSetError } from 'react-hook-form';
import { ApiError } from './api/errors';

/**
 * Attach server-side field errors to form fields. Returns a message for errors that are not tied
 * to a field (shown as a form-level notice), or null when everything was mapped.
 */
export function applyServerErrors<T extends FieldValues>(
  err: unknown,
  setError: UseFormSetError<T>,
  fields: readonly string[],
): string | null {
  if (!(err instanceof ApiError))
    return err instanceof Error ? err.message : 'The request could not be completed.';
  let unmapped = false;
  for (const f of err.fields) {
    const name = f.path.split('.')[0] ?? '';
    if (fields.includes(name)) setError(name as Path<T>, { type: 'server', message: f.message });
    else unmapped = true;
  }
  if (err.fields.length === 0 || unmapped) return err.message;
  return null;
}
