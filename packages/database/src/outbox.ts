import { sql, type Generated, type Insertable, type Kysely, type Transaction } from 'kysely';

/** Rows of `outbox_events`; written in the same transaction as the state change. */
export interface OutboxEventsTable {
  id: string;
  type: string;
  version: number;
  stream: string;
  envelope: unknown;
  created_at: Generated<Date>;
  published_at: Date | null;
  attempts: Generated<number>;
  last_error: string | null;
}

/** Rows of `inbox_events`; one per (event, handler) to make consumers effectively-once. */
export interface InboxEventsTable {
  event_id: string;
  handler: string;
  event_type: string;
  processed_at: Generated<Date>;
}

export interface OutboxSchema {
  outbox_events: OutboxEventsTable;
}

export interface InboxSchema {
  inbox_events: InboxEventsTable;
}

export const OUTBOX_NOTIFY_CHANNEL = 'a5_outbox';

export async function createOutboxTable(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table outbox_events (
      id uuid primary key,
      type text not null,
      version integer not null,
      stream text not null,
      envelope jsonb not null,
      created_at timestamptz not null default now(),
      published_at timestamptz,
      attempts integer not null default 0,
      last_error text
    )
  `.execute(db);
  await sql`
    create index outbox_events_unpublished_idx on outbox_events (created_at)
    where published_at is null
  `.execute(db);
  await sql`create index outbox_events_published_idx on outbox_events (published_at)`.execute(db);
}

export async function createInboxTable(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table inbox_events (
      event_id uuid not null,
      handler text not null,
      event_type text not null,
      processed_at timestamptz not null default now(),
      primary key (event_id, handler)
    )
  `.execute(db);
  await sql`create index inbox_events_processed_idx on inbox_events (processed_at)`.execute(db);
}

export type OutboxRow = Insertable<OutboxEventsTable>;

/**
 * Insert events into the outbox inside the caller's transaction and wake the relay.
 * NOTIFY is transactional: listeners are only woken if the transaction commits.
 */
export async function writeOutbox(
  trx: Transaction<OutboxSchema> | Kysely<OutboxSchema>,
  rows: OutboxRow[],
): Promise<void> {
  if (rows.length === 0) return;
  await trx.insertInto('outbox_events').values(rows).execute();
  await sql`select pg_notify(${OUTBOX_NOTIFY_CHANNEL}, '')`.execute(trx);
}

/**
 * Claim an event for a handler. Returns false when the handler already processed it, in which case
 * the caller must skip its side effects. Must run inside the handler's transaction.
 */
export async function claimInbox(
  trx: Transaction<InboxSchema>,
  eventId: string,
  handler: string,
  eventType: string,
): Promise<boolean> {
  const result = await trx
    .insertInto('inbox_events')
    .values({ event_id: eventId, handler, event_type: eventType })
    .onConflict((oc) => oc.columns(['event_id', 'handler']).doNothing())
    .executeTakeFirst();
  return (result.numInsertedOrUpdatedRows ?? 0n) > 0n;
}
