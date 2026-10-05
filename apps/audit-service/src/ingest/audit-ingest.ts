import { Inject, Injectable } from '@nestjs/common';
import { auditEvents, type AuditRecord, type EventEnvelope } from '@a5/events';
import { processOnce } from '@a5/messaging';
import { InjectDb, OnEvent } from '@a5/nest-kit';
import { AUDIT_CONFIG, type AuditConfig } from '../config.js';
import { jsonOrNull, type Db, type Trx } from '../database/index.js';
import { clip, redact, sanitizeSnapshot } from './sanitize.js';

export const AUDIT_HANDLER = 'audit.record';

/**
 * Consumes `audit.recorded` from every producer's stream and appends it to the trail. The event
 * id becomes the entry id; redelivery is absorbed by the inbox and, as a second guard, by
 * `on conflict (id, occurred_at) do nothing`.
 */
@Injectable()
export class AuditIngest {
  constructor(
    @InjectDb() private readonly db: Db,
    @Inject(AUDIT_CONFIG) private readonly config: AuditConfig,
  ) {}

  @OnEvent(auditEvents.recorded, { fromAllProducers: true })
  async onAuditRecorded(event: EventEnvelope): Promise<void> {
    await this.record(event);
  }

  /** Returns true when the entry was stored (false for a redelivered event). */
  async record(event: EventEnvelope): Promise<boolean> {
    const p = event.payload as AuditRecord;
    const limit = { maxBytes: this.config.maxSnapshotBytes };
    let stored = false;
    const processed = await processOnce(this.db, AUDIT_HANDLER, event, async (trx: Trx) => {
      const result = await trx
        .insertInto('audit_logs')
        .values({
          id: event.id,
          organization_id: event.organizationId,
          occurred_at: new Date(event.occurredAt),
          actor_type: event.actor.type,
          actor_id: clip(event.actor.id, 100),
          actor_display: clip(p.actorDisplay, 200),
          action: p.action.slice(0, 100),
          resource_type: p.resourceType.slice(0, 100),
          resource_id: clip(p.resourceId, 200),
          before: jsonOrNull(sanitizeSnapshot(p.before, limit)),
          after: jsonOrNull(sanitizeSnapshot(p.after, limit)),
          reason: clip(p.reason, 2000),
          ip: clip(p.ip, 64),
          user_agent: clip(p.userAgent, 512),
          request_id: clip(p.requestId, 128),
          correlation_id: clip(event.correlationId, 128),
          service: event.producer,
          metadata: JSON.stringify(redact(p.metadata ?? {})),
        })
        .onConflict((oc) => oc.columns(['id', 'occurred_at']).doNothing())
        .executeTakeFirst();
      stored = (result.numInsertedOrUpdatedRows ?? 0n) > 0n;
    });
    return processed && stored;
  }
}
