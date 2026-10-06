import { uuidv7 } from '@a5/observability';
import type { DbOrTrx } from '../database/index.js';

export type CertificateEventType =
  | 'issued'
  | 'pdf_generated'
  | 'pdf_failed'
  | 'downloaded'
  | 'revoked'
  | 'reissued'
  | 'superseded'
  | 'expired'
  | 'expiry_reminder'
  | 'renewal_opened'
  | 'renewal_lapsed'
  | 'renewed';

/** Append an entry to the local, immutable timeline of a certificate. */
export async function recordCertificateEvent(
  db: DbOrTrx,
  entry: {
    organizationId: string;
    certificateId: string;
    type: CertificateEventType;
    actor?: { id: string | null; name: string | null } | null;
    data?: Record<string, unknown>;
    occurredAt?: Date;
  },
): Promise<void> {
  await db
    .insertInto('certificate_events')
    .values({
      id: uuidv7(entry.occurredAt?.getTime()),
      organization_id: entry.organizationId,
      certificate_id: entry.certificateId,
      type: entry.type,
      actor_id: entry.actor?.id ?? null,
      actor_name: entry.actor?.name ?? null,
      data: entry.data ?? {},
      ...(entry.occurredAt && { occurred_at: entry.occurredAt }),
    })
    .execute();
}

export function personRef(
  id: string | null,
  name: string | null,
): { id: string; displayName: string } | null {
  return id && name ? { id, displayName: name } : null;
}
