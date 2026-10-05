import { z } from 'zod';

export const PRODUCERS = [
  'identity-service',
  'learning-service',
  'media-service',
  'assessment-service',
  'ai-coaching-service',
  'certification-service',
  'notification-service',
  'analytics-service',
  'audit-service',
  'gateway',
] as const;
export type Producer = (typeof PRODUCERS)[number];

/** Redis stream (without environment namespace) that carries a producer's events. */
export function streamFor(producer: Producer): string {
  return `events:${producer.replace(/-service$/, '')}`;
}

export const actorSchema = z.object({
  type: z.enum(['user', 'service', 'system']),
  id: z.string().nullable(),
});
export type EventActor = z.infer<typeof actorSchema>;

export const envelopeSchema = z.object({
  id: z.uuid(),
  type: z.string().min(3),
  version: z.int().min(1),
  occurredAt: z.iso.datetime({ offset: true }),
  producer: z.enum(PRODUCERS),
  organizationId: z.uuid().nullable(),
  actor: actorSchema,
  correlationId: z.string().nullable(),
  causationId: z.string().nullable(),
  subject: z.object({ type: z.string(), id: z.string() }).nullable(),
  payload: z.unknown(),
});

export interface EventEnvelope<P = unknown, T extends string = string> {
  id: string;
  type: T;
  version: number;
  occurredAt: string;
  producer: Producer;
  organizationId: string | null;
  actor: EventActor;
  correlationId: string | null;
  causationId: string | null;
  subject: { type: string; id: string } | null;
  payload: P;
}
