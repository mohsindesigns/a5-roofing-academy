import type { z } from 'zod';
import type { EventDefinition } from './catalog.js';
import { getEventDefinition } from './catalog.js';
import { envelopeSchema, type EventActor, type EventEnvelope, type Producer } from './envelope.js';

export interface EventMeta {
  id: string;
  producer: Producer;
  organizationId: string | null;
  actor: EventActor;
  correlationId?: string | null;
  causationId?: string | null;
  subject?: { type: string; id: string } | null;
  occurredAt?: Date;
}

/** Build a validated envelope. Throws when the payload does not match the contract. */
export function buildEvent<T extends string, S extends z.ZodType>(
  def: EventDefinition<T, S>,
  payload: z.input<S>,
  meta: EventMeta,
): EventEnvelope<z.infer<S>, T> {
  const parsed = def.payload.parse(payload) as z.infer<S>;
  return {
    id: meta.id,
    type: def.type,
    version: def.version,
    occurredAt: (meta.occurredAt ?? new Date()).toISOString(),
    producer: meta.producer,
    organizationId: meta.organizationId,
    actor: meta.actor,
    correlationId: meta.correlationId ?? null,
    causationId: meta.causationId ?? null,
    subject: meta.subject ?? null,
    payload: parsed,
  };
}

export class EventContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EventContractError';
  }
}

/**
 * Validate an inbound envelope and its payload. Unknown type/version combinations are returned as
 * `null` so consumers can skip events they do not understand (forward compatibility).
 */
export function parseEnvelope(raw: unknown): EventEnvelope | null {
  const env = envelopeSchema.safeParse(raw);
  if (!env.success) throw new EventContractError(`Malformed envelope: ${env.error.message}`);
  const def = getEventDefinition(env.data.type, env.data.version);
  if (!def) return null;
  const payload = def.payload.safeParse(env.data.payload);
  if (!payload.success) {
    throw new EventContractError(
      `Payload of ${env.data.type}@${env.data.version} violates contract: ${payload.error.message}`,
    );
  }
  return { ...(env.data as EventEnvelope), payload: payload.data };
}
