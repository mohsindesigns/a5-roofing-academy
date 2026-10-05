import type { z } from 'zod';
import { writeOutbox, type Kysely, type OutboxSchema, type Transaction } from '@a5/database';
import { buildEvent, streamFor, type EventDefinition, type EventEnvelope } from '@a5/events';
import type { EmitOptions } from '@a5/nest-kit';
import { uuidv7 } from '@a5/observability';

type OutboxExecutor = Transaction<OutboxSchema> | Kysely<OutboxSchema>;

/**
 * Writes domain events to the outbox inside the caller's transaction. `EventBus` (nest-kit)
 * satisfies it in the service; tools without the Nest container (seed) use `OutboxEventWriter`.
 */
export interface EventWriter {
  emit<T extends string, S extends z.ZodType>(
    trx: OutboxExecutor,
    def: EventDefinition<T, S>,
    payload: z.input<S>,
    options?: EmitOptions,
  ): Promise<EventEnvelope<z.infer<S>, T>>;
}

export class OutboxEventWriter implements EventWriter {
  async emit<T extends string, S extends z.ZodType>(
    trx: OutboxExecutor,
    def: EventDefinition<T, S>,
    payload: z.input<S>,
    options: EmitOptions = {},
  ): Promise<EventEnvelope<z.infer<S>, T>> {
    const event = buildEvent(def, payload, {
      id: uuidv7(),
      producer: 'media-service',
      organizationId: options.organizationId ?? null,
      actor: options.actor ?? { type: 'system', id: null },
      subject: options.subject ?? null,
    });
    await writeOutbox(trx, [
      {
        id: event.id,
        type: event.type,
        version: event.version,
        stream: streamFor('media-service'),
        envelope: event,
        published_at: null,
        last_error: null,
      },
    ]);
    return event;
  }
}
