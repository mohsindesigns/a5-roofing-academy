// API contracts for the notification domain. Shared by the service and the web app.
import { z } from 'zod';
import { isoDateTime, pageSchema, personRefSchema, queryBoolean } from './common.js';

// ------------------------------------------------------------------ vocabulary

export const NOTIFICATION_CHANNELS = ['in_app', 'email'] as const;
export const notificationChannelSchema = z.enum(NOTIFICATION_CHANNELS);
export type NotificationChannel = z.infer<typeof notificationChannelSchema>;

export const NOTIFICATION_PRIORITIES = ['low', 'normal', 'high'] as const;
export const notificationPrioritySchema = z.enum(NOTIFICATION_PRIORITIES);
export type NotificationPriority = z.infer<typeof notificationPrioritySchema>;

export const NOTIFICATION_CATEGORIES = ['account', 'training', 'assessments', 'ai_coaching', 'approvals', 'certifications'] as const;
export const notificationCategorySchema = z.enum(NOTIFICATION_CATEGORIES);
export type NotificationCategory = z.infer<typeof notificationCategorySchema>;

/** Every notification type the platform can send. Templates and rules are keyed by these. */
export const NOTIFICATION_TYPES = [
  'account.welcome',
  'account.invitation',
  'account.password_reset',
  'training.assigned',
  'training.overdue',
  'training.overdue.manager',
  'training.updated',
  'assessment.passed',
  'assessment.failed',
  'assessment.failed.manager',
  'approval.requested',
  'approval.approved',
  'approval.rejected',
  'ai.feedback_ready',
  'ai.review_available',
  'certificate.eligible',
  'certificate.approval_requested',
  'certificate.approval_rejected',
  'certificate.issued',
  'certificate.issued.manager',
  'certificate.generated',
  'certificate.expiring',
  'certificate.expired',
  'certificate.expired.manager',
  'certificate.revoked',
  'certificate.renewal_required',
] as const;
export const notificationTypeSchema = z.enum(NOTIFICATION_TYPES);
export type NotificationType = z.infer<typeof notificationTypeSchema>;

/**
 * Who receives a rule's notifications, relative to the person the event is about:
 * `subject` (that person), `managers` (managers of their teams plus direct managers),
 * `team_managers` (managers of their teams only), `trainers` (assigned trainers),
 * `enrolled_learners` (everyone enrolled in the event's program) or `role:<key>` (everyone
 * holding a role in the organization).
 */
export const RECIPIENT_KINDS = ['subject', 'managers', 'team_managers', 'trainers', 'enrolled_learners'] as const;
export const recipientSchema = z.union([
  z.enum(RECIPIENT_KINDS),
  z.string().regex(/^role:[a-z][a-z0-9_]{1,62}$/, 'Use role:<role key>, for example role:admin'),
]);
export type Recipient = z.infer<typeof recipientSchema>;

// ------------------------------------------------------------------ rule conditions

const conditionLiteral = z.union([z.string().max(200), z.number(), z.boolean(), z.null()]);
const conditionOperators = z
  .object({
    eq: conditionLiteral,
    ne: conditionLiteral,
    in: z.array(conditionLiteral).min(1).max(50),
    notIn: z.array(conditionLiteral).min(1).max(50),
    gt: z.number(),
    gte: z.number(),
    lt: z.number(),
    lte: z.number(),
  })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'Add at least one operator (eq, ne, in, notIn, gt, gte, lt, lte)');

/**
 * Conditions on the event payload, all of which must hold. Keys are payload field paths such as
 * `passed`, `kind` or `context.programId`. A literal means equality, an array means "one of",
 * an object combines operators: `{ "passed": false, "kind": ["quiz", "final"], "daysRemaining": { "lte": 30 } }`.
 */
export const ruleConditionsSchema = z
  .record(
    z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*){0,4}$/, 'Use a payload field path such as passed or context.programId'),
    z.union([conditionLiteral, z.array(conditionLiteral).min(1).max(50), conditionOperators]),
  )
  .refine((v) => Object.keys(v).length <= 10, 'Use at most 10 conditions');
export type RuleConditions = z.infer<typeof ruleConditionsSchema>;

// ------------------------------------------------------------------ inbox

export const notificationSchema = z.object({
  id: z.uuid(),
  type: z.string(),
  category: notificationCategorySchema,
  title: z.string(),
  body: z.string(),
  /** Path inside the web app, e.g. `/training/<programId>`. */
  link: z.string().nullable(),
  data: z.record(z.string(), z.unknown()),
  priority: notificationPrioritySchema,
  readAt: isoDateTime.nullable(),
  createdAt: isoDateTime,
});
export type Notification = z.infer<typeof notificationSchema>;

export const listNotificationsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  /** Opaque cursor from `nextCursor` of the previous page. */
  cursor: z.string().max(200).optional(),
  unread: queryBoolean,
  category: notificationCategorySchema.optional(),
});
export type ListNotificationsQuery = z.infer<typeof listNotificationsQuerySchema>;

export const notificationPageSchema = z.object({
  items: z.array(notificationSchema),
  nextCursor: z.string().nullable(),
  unreadCount: z.int(),
});
export type NotificationPage = z.infer<typeof notificationPageSchema>;

export const unreadCountSchema = z.object({ count: z.int() });
export type UnreadCount = z.infer<typeof unreadCountSchema>;

export const markAllReadResponseSchema = z.object({ updated: z.int(), unreadCount: z.int() });
export type MarkAllReadResponse = z.infer<typeof markAllReadResponseSchema>;

/**
 * Server-sent events on `GET /api/v1/notifications/stream`:
 * - `event: unread` with `{ count }` on connect and whenever the unread count changes,
 * - `event: notification` (with `id:` set to the notification id) carrying a {@link Notification},
 * - `: heartbeat` comments every 25 seconds.
 * Reconnecting with `Last-Event-ID` replays notifications created after that id.
 */
export const streamUnreadEventSchema = unreadCountSchema;
export const streamNotificationEventSchema = notificationSchema;

// ------------------------------------------------------------------ preferences

export const preferenceChannelSchema = z.object({
  channel: notificationChannelSchema,
  enabled: z.boolean(),
});

export const preferenceSchema = z.object({
  type: notificationTypeSchema,
  label: z.string(),
  description: z.string(),
  category: notificationCategorySchema,
  channels: z.array(preferenceChannelSchema),
});
export type NotificationPreference = z.infer<typeof preferenceSchema>;

export const preferencesResponseSchema = z.object({ items: z.array(preferenceSchema) });
export type PreferencesResponse = z.infer<typeof preferencesResponseSchema>;

export const updatePreferencesRequestSchema = z.object({
  preferences: z
    .array(z.object({ type: notificationTypeSchema, channel: notificationChannelSchema, enabled: z.boolean() }))
    .min(1)
    .max(200),
});
export type UpdatePreferencesRequest = z.infer<typeof updatePreferencesRequestSchema>;

// ------------------------------------------------------------------ templates (admin)

export const templateVariableSchema = z.object({
  name: z.string(),
  description: z.string(),
  sample: z.string(),
});
export type TemplateVariable = z.infer<typeof templateVariableSchema>;

export const notificationTemplateSchema = z.object({
  id: z.uuid(),
  type: notificationTypeSchema,
  typeLabel: z.string(),
  category: notificationCategorySchema,
  channel: notificationChannelSchema,
  /** Email subject, or the in-app notification title. */
  subject: z.string(),
  body: z.string(),
  enabled: z.boolean(),
  /** True when subject and body equal the shipped default. */
  isDefault: z.boolean(),
  sensitive: z.boolean(),
  variables: z.array(templateVariableSchema),
  updatedAt: isoDateTime,
  updatedBy: personRefSchema.nullable(),
});
export type NotificationTemplate = z.infer<typeof notificationTemplateSchema>;

export const listTemplatesQuerySchema = z.object({
  type: notificationTypeSchema.optional(),
  channel: notificationChannelSchema.optional(),
  category: notificationCategorySchema.optional(),
});
export type ListTemplatesQuery = z.infer<typeof listTemplatesQuerySchema>;

export const templateListSchema = z.object({ items: z.array(notificationTemplateSchema) });

const templateSubject = z.string().trim().min(1, 'Required').max(200);
const templateBody = z.string().trim().min(1, 'Required').max(5000);

export const updateTemplateRequestSchema = z
  .object({ subject: templateSubject, body: templateBody, enabled: z.boolean() })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Change at least one field');
export type UpdateTemplateRequest = z.infer<typeof updateTemplateRequestSchema>;

export const previewTemplateRequestSchema = z.object({
  /** Unsaved subject/body to preview; defaults to the stored template. */
  subject: templateSubject.optional(),
  body: templateBody.optional(),
  /** Overrides for sample variable values. */
  data: z.record(z.string(), z.string().max(500)).optional(),
});
export type PreviewTemplateRequest = z.infer<typeof previewTemplateRequestSchema>;

export const templatePreviewSchema = z.object({
  channel: notificationChannelSchema,
  subject: z.string(),
  text: z.string(),
  /** Full HTML document for email templates; null for in-app templates. */
  html: z.string().nullable(),
  link: z.string().nullable(),
});
export type TemplatePreview = z.infer<typeof templatePreviewSchema>;

// ------------------------------------------------------------------ rules (admin)

export const notificationRuleSchema = z.object({
  id: z.uuid(),
  key: z.string(),
  type: notificationTypeSchema,
  typeLabel: z.string(),
  description: z.string(),
  category: notificationCategorySchema,
  eventType: z.string(),
  recipients: z.array(recipientSchema),
  /** Recipient kinds that make sense for this event. */
  allowedRecipients: z.array(z.string()),
  channels: z.array(notificationChannelSchema),
  supportedChannels: z.array(notificationChannelSchema),
  /** Fixed conditions that define the notification (not editable). */
  fixedConditions: ruleConditionsSchema,
  conditions: ruleConditionsSchema,
  delayMinutes: z.int(),
  priority: notificationPrioritySchema,
  enabled: z.boolean(),
  mandatory: z.boolean(),
  updatedAt: isoDateTime,
  updatedBy: personRefSchema.nullable(),
});
export type NotificationRule = z.infer<typeof notificationRuleSchema>;

export const listRulesQuerySchema = z.object({
  eventType: z.string().max(100).optional(),
  category: notificationCategorySchema.optional(),
  enabled: queryBoolean,
});
export type ListRulesQuery = z.infer<typeof listRulesQuerySchema>;

export const ruleListSchema = z.object({ items: z.array(notificationRuleSchema) });

export const updateRuleRequestSchema = z
  .object({
    recipients: z.array(recipientSchema).min(1).max(10),
    channels: z.array(notificationChannelSchema).min(1).max(2),
    conditions: ruleConditionsSchema,
    delayMinutes: z.int().min(0).max(10_080),
    priority: notificationPrioritySchema,
    enabled: z.boolean(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Change at least one field');
export type UpdateRuleRequest = z.infer<typeof updateRuleRequestSchema>;

// ------------------------------------------------------------------ email delivery log (admin)

export const EMAIL_DELIVERY_STATUSES = ['queued', 'sent', 'failed'] as const;
export const emailDeliveryStatusSchema = z.enum(EMAIL_DELIVERY_STATUSES);
export type EmailDeliveryStatus = z.infer<typeof emailDeliveryStatusSchema>;

export const emailDeliverySchema = z.object({
  id: z.uuid(),
  type: z.string(),
  userId: z.uuid().nullable(),
  to: z.string(),
  toName: z.string().nullable(),
  subject: z.string(),
  status: emailDeliveryStatusSchema,
  attempts: z.int(),
  providerMessageId: z.string().nullable(),
  error: z.string().nullable(),
  /** Content of security emails (activation, password reset) is never stored. */
  sensitive: z.boolean(),
  scheduledAt: isoDateTime,
  lastAttemptAt: isoDateTime.nullable(),
  sentAt: isoDateTime.nullable(),
  failedAt: isoDateTime.nullable(),
  createdAt: isoDateTime,
});
export type EmailDelivery = z.infer<typeof emailDeliverySchema>;

export const emailDeliveryDetailSchema = emailDeliverySchema.extend({
  text: z.string().nullable(),
  html: z.string().nullable(),
});
export type EmailDeliveryDetail = z.infer<typeof emailDeliveryDetailSchema>;

export const listEmailDeliveriesQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  status: emailDeliveryStatusSchema.optional(),
  type: notificationTypeSchema.optional(),
  /** Recipient address or name contains. */
  q: z.string().trim().max(200).optional(),
  userId: z.uuid().optional(),
});
export type ListEmailDeliveriesQuery = z.infer<typeof listEmailDeliveriesQuerySchema>;

export const emailDeliveryPageSchema = pageSchema(emailDeliverySchema);
