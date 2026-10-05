// API contracts for the audit domain. Shared by the service and the web app.
import { z } from 'zod';
import { isoDateTime } from './common.js';

export const AUDIT_ACTOR_TYPES = ['user', 'service', 'system'] as const;
export const auditActorTypeSchema = z.enum(AUDIT_ACTOR_TYPES);
export type AuditActorType = z.infer<typeof auditActorTypeSchema>;

export const auditActorSchema = z.object({
  type: auditActorTypeSchema,
  id: z.string().nullable(),
  displayName: z.string().nullable(),
});
export type AuditActor = z.infer<typeof auditActorSchema>;

/** One row of the audit trail (list view). */
export const auditLogSummarySchema = z.object({
  id: z.uuid(),
  organizationId: z.uuid().nullable(),
  occurredAt: isoDateTime,
  actor: auditActorSchema,
  action: z.string(),
  resourceType: z.string(),
  resourceId: z.string().nullable(),
  reason: z.string().nullable(),
  service: z.string(),
  ip: z.string().nullable(),
  /** True when the entry carries a before/after snapshot (fetch the detail to see it). */
  hasChanges: z.boolean(),
});
export type AuditLogSummary = z.infer<typeof auditLogSummarySchema>;

export const auditLogSchema = auditLogSummarySchema.extend({
  before: z.unknown().nullable(),
  after: z.unknown().nullable(),
  userAgent: z.string().nullable(),
  requestId: z.string().nullable(),
  correlationId: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()),
  recordedAt: isoDateTime,
});
export type AuditLog = z.infer<typeof auditLogSchema>;

const dateBound = z.iso.datetime({ offset: true }).or(z.iso.date());

/** Filters shared by the list, facets and export endpoints. */
export const auditFilterSchema = z.object({
  /** Inclusive lower bound (ISO date or date-time). */
  from: dateBound.optional(),
  /** Exclusive upper bound (ISO date or date-time). A date means "up to the end of that day". */
  to: dateBound.optional(),
  actorId: z.string().trim().min(1).max(100).optional(),
  actorType: auditActorTypeSchema.optional(),
  /** Action prefix, e.g. `user.` or `certificate.issued`. */
  action: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .regex(/^[a-z0-9_.]+$/i, 'Use letters, digits, dots and underscores')
    .optional(),
  resourceType: z.string().trim().min(1).max(100).optional(),
  resourceId: z.string().trim().min(1).max(200).optional(),
  service: z.string().trim().min(1).max(100).optional(),
  /** Free text over actor, action, resource and reason. */
  q: z.string().trim().min(1).max(200).optional(),
  /** Platform administrators only: another organization's trail. */
  organizationId: z.uuid().optional(),
});
export type AuditFilter = z.infer<typeof auditFilterSchema>;

export const listAuditLogsQuerySchema = auditFilterSchema.extend({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  /** Opaque keyset cursor from `nextCursor`. */
  cursor: z.string().max(200).optional(),
});
export type ListAuditLogsQuery = z.infer<typeof listAuditLogsQuerySchema>;

export const auditLogPageSchema = z.object({
  items: z.array(auditLogSummarySchema),
  nextCursor: z.string().nullable(),
});
export type AuditLogPage = z.infer<typeof auditLogPageSchema>;

export const resourceHistoryQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(200).optional(),
});
export type ResourceHistoryQuery = z.infer<typeof resourceHistoryQuerySchema>;

export const auditFacetsQuerySchema = z.object({
  from: dateBound.optional(),
  to: dateBound.optional(),
  organizationId: z.uuid().optional(),
});
export type AuditFacetsQuery = z.infer<typeof auditFacetsQuerySchema>;

export const facetValueSchema = z.object({ value: z.string(), count: z.int() });
export const auditFacetsSchema = z.object({
  from: isoDateTime,
  to: isoDateTime,
  actions: z.array(facetValueSchema),
  resourceTypes: z.array(facetValueSchema),
  services: z.array(facetValueSchema),
});
export type AuditFacets = z.infer<typeof auditFacetsSchema>;

/** CSV columns of `GET /api/v1/audit/export`, in order. */
export const AUDIT_EXPORT_COLUMNS = [
  'occurred_at',
  'action',
  'actor_type',
  'actor_id',
  'actor_display',
  'resource_type',
  'resource_id',
  'reason',
  'service',
  'ip',
  'user_agent',
  'request_id',
  'correlation_id',
  'before',
  'after',
  'id',
] as const;
