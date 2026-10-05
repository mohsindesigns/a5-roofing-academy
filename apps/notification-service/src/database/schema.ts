import type { ColumnType, Generated, InboxSchema, OutboxSchema } from '@a5/database';
import type { DirectorySchema } from '@a5/directory';

export type Channel = 'in_app' | 'email';
export type Priority = 'low' | 'normal' | 'high';
export type DeliveryStatus = 'queued' | 'sent' | 'failed';

/** JSONB column: objects are written as JSON text, read back parsed. */
type Json<T> = ColumnType<T, string, string>;

export interface NotificationTemplatesTable {
  id: string;
  organization_id: string;
  type: string;
  channel: Channel;
  /** Email subject or in-app title. */
  subject: string;
  body: string;
  enabled: Generated<boolean>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  updated_by: string | null;
}

export interface NotificationRulesTable {
  id: string;
  organization_id: string;
  key: string;
  event_type: string;
  notification_type: string;
  recipients: string[];
  channels: Channel[];
  conditions: Json<Record<string, unknown>>;
  delay_minutes: Generated<number>;
  priority: Generated<Priority>;
  enabled: Generated<boolean>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  updated_by: string | null;
}

export interface NotificationsTable {
  id: string;
  organization_id: string;
  user_id: string;
  type: string;
  title: string;
  body: string;
  link: string | null;
  data: Json<Record<string, unknown>>;
  priority: Generated<Priority>;
  source_event_id: string | null;
  available_at: Generated<Date>;
  read_at: Date | null;
  created_at: Generated<Date>;
}

export interface EmailDeliveriesTable {
  id: string;
  organization_id: string;
  user_id: string;
  notification_type: string;
  source_event_id: string | null;
  to_address: string;
  to_name: string | null;
  subject: string;
  /** Rendered content; null for security emails, whose content is only kept sealed until delivery. */
  body_text: string | null;
  body_html: string | null;
  sealed_content: string | null;
  sensitive: Generated<boolean>;
  status: Generated<DeliveryStatus>;
  attempts: Generated<number>;
  provider_message_id: string | null;
  last_error: string | null;
  scheduled_at: Generated<Date>;
  last_attempt_at: Date | null;
  sent_at: Date | null;
  failed_at: Date | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface NotificationPreferencesTable {
  user_id: string;
  organization_id: string;
  type: string;
  channel: Channel;
  enabled: boolean;
  updated_at: Generated<Date>;
}

/** Who is enrolled in which program (from learning events), for program-wide announcements. */
export interface ProgramLearnersTable {
  program_id: string;
  user_id: string;
  organization_id: string;
  enrollment_id: string;
  enrolled_at: Date;
  withdrawn_at: Date | null;
  /** occurredAt of the last applied event; older events are ignored. */
  event_at: Date;
}

export interface NotificationDatabase extends DirectorySchema, InboxSchema, OutboxSchema {
  notification_templates: NotificationTemplatesTable;
  notification_rules: NotificationRulesTable;
  notifications: NotificationsTable;
  email_deliveries: EmailDeliveriesTable;
  notification_preferences: NotificationPreferencesTable;
  program_learners: ProgramLearnersTable;
}
