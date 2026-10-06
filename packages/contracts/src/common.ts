import { z } from 'zod';

export const ERROR_CODES = [
  'UNAUTHENTICATED',
  'SESSION_EXPIRED',
  'SESSION_REVOKED',
  'INVALID_CREDENTIALS',
  'ACCOUNT_LOCKED',
  'ACCOUNT_DISABLED',
  'FORBIDDEN',
  'NOT_FOUND',
  'VALIDATION_FAILED',
  'CONFLICT',
  'RATE_LIMITED',
  'PRECONDITION_FAILED',
  'TOKEN_INVALID',
  'PAYLOAD_TOO_LARGE',
  'UNSUPPORTED_MEDIA_TYPE',
  'SERVICE_UNAVAILABLE',
  'INTERNAL',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number] | (string & {});

export const fieldErrorSchema = z.object({ path: z.string(), message: z.string() });
export type FieldError = z.infer<typeof fieldErrorSchema>;

export const apiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    fields: z.array(fieldErrorSchema).optional(),
    details: z.record(z.string(), z.unknown()).optional(),
    requestId: z.string().optional(),
  }),
});
export type ApiErrorBody = z.infer<typeof apiErrorSchema>;

export const uuidSchema = z.uuid();
export const idParamSchema = z.object({ id: z.uuid() });

export const pageQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  q: z.string().trim().max(200).optional(),
  sort: z
    .string()
    .regex(/^-?[a-zA-Z_]+$/)
    .optional(),
});
export type PageQuery = z.infer<typeof pageQuerySchema>;

export function pageSchema<T extends z.ZodType>(item: T) {
  return z.object({
    items: z.array(item),
    page: z.int(),
    pageSize: z.int(),
    total: z.int(),
    pageCount: z.int(),
  });
}
export interface PageResult<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
  pageCount: number;
}

/** Query-string boolean ("true"/"false"). */
export const queryBoolean = z
  .enum(['true', 'false'])
  .transform((v) => v === 'true')
  .optional();

/** Comma separated list in a query string. */
export function queryList<T extends z.ZodType<unknown, string>>(item: T) {
  return z
    .string()
    .transform((v) =>
      v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    )
    .pipe(z.array(item))
    .optional();
}

export const isoDateTime = z.iso.datetime({ offset: true });
export const isoDate = z.iso.date();

export const personRefSchema = z.object({
  id: z.uuid(),
  displayName: z.string(),
});
export type PersonRef = z.infer<typeof personRefSchema>;

export const okSchema = z.object({ ok: z.literal(true) });

/** Names must not be blank and must be trimmed. */
export const nameString = (max = 120) => z.string().trim().min(1, 'Required').max(max);
export const optionalText = (max = 2000) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === '' ? null : v))
    .nullable()
    .optional();
