interface PgError {
  code?: string;
  constraint?: string;
}

function pgError(err: unknown): PgError | null {
  return typeof err === 'object' && err !== null && 'code' in err ? (err as PgError) : null;
}

export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  const e = pgError(err);
  return e?.code === '23505' && (constraint === undefined || e.constraint === constraint);
}

export function isForeignKeyViolation(err: unknown, constraint?: string): boolean {
  const e = pgError(err);
  return e?.code === '23503' && (constraint === undefined || e.constraint === constraint);
}

export function isSerializationFailure(err: unknown): boolean {
  const code = pgError(err)?.code;
  return code === '40001' || code === '40P01';
}

export function constraintName(err: unknown): string | undefined {
  return pgError(err)?.constraint;
}
