import { claimInbox, type InboxSchema, type Kysely, type Transaction } from '@a5/database';
import type { EventEnvelope } from '@a5/events';

/**
 * Run an event handler's database effects exactly once per (event, handler). Returns false when
 * the event was already processed by this handler.
 */
export async function processOnce<DB extends InboxSchema>(
  db: Kysely<DB>,
  handler: string,
  event: EventEnvelope,
  fn: (trx: Transaction<DB>) => Promise<void>,
): Promise<boolean> {
  return db.transaction().execute(async (trx) => {
    const claimed = await claimInbox(
      trx as unknown as Transaction<InboxSchema>,
      event.id,
      handler,
      event.type,
    );
    if (!claimed) return false;
    await fn(trx);
    return true;
  });
}
