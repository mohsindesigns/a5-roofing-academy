import { sql, type Expression } from '@a5/database';

/**
 * Write value for a `jsonb` column that holds an array. node-postgres serializes JavaScript arrays
 * as PostgreSQL arrays, which is not valid JSON; objects are serialized correctly on their own.
 */
export function jsonb<T>(value: T): Expression<T> {
  return sql<T>`${JSON.stringify(value)}::jsonb`;
}
