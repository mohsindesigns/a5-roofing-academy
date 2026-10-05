import type { ColumnType, Generated, InboxSchema } from '@a5/database';

export type ActorType = 'user' | 'service' | 'system';

/** JSONB snapshot column: written as JSON text, read back parsed, never updated. */
type Snapshot = ColumnType<unknown, string | null, never>;

/**
 * Append-only audit trail, range-partitioned by month on `occurred_at`. The primary key includes
 * the partition key; uniqueness of `id` (the event id) comes from the inbox plus
 * `on conflict (id, occurred_at) do nothing`. Update types are `never`: rows are never changed.
 */
export interface AuditLogsTable {
  id: string;
  organization_id: string | null;
  occurred_at: Date;
  actor_type: ActorType;
  actor_id: string | null;
  actor_display: string | null;
  action: string;
  resource_type: string;
  resource_id: string | null;
  before: Snapshot;
  after: Snapshot;
  reason: string | null;
  ip: string | null;
  user_agent: string | null;
  request_id: string | null;
  correlation_id: string | null;
  service: string;
  metadata: ColumnType<Record<string, unknown>, string, never>;
  recorded_at: Generated<Date>;
}

export interface AuditDatabase extends InboxSchema {
  audit_logs: AuditLogsTable;
}
