import { Injectable } from '@nestjs/common';
import type { notification } from '@a5/contracts';
import { sql, type Selectable } from '@a5/database';
import { InjectDb, ValidationError } from '@a5/nest-kit';
import { NOTIFICATION_TYPE_DEFS, getTypeDef } from '../catalog/notification-types.js';
import type { Db, DbOrTrx, NotificationsTable } from '../database/index.js';

type NotificationRow = Selectable<NotificationsTable>;
type NotificationDto = notification.Notification;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

export function toNotificationDto(row: NotificationRow): NotificationDto {
  return {
    id: row.id,
    type: row.type,
    category: getTypeDef(row.type)?.category ?? 'account',
    title: row.title,
    body: row.body,
    link: row.link,
    data: row.data ?? {},
    priority: row.priority,
    readAt: row.read_at ? row.read_at.toISOString() : null,
    createdAt: row.available_at.toISOString(),
  };
}

/** Keyset cursor over (available_at, id), with microsecond precision kept as text. */
export function encodeCursor(at: string, id: string): string {
  return Buffer.from(`${at}|${id}`, 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): { at: string; id: string } {
  const [at, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  if (!at || !id || !TIMESTAMP.test(at) || !UUID.test(id)) {
    throw new ValidationError([
      { path: 'cursor', message: 'This cursor is invalid. Reload the list and try again.' },
    ]);
  }
  return { at, id };
}

const cursorAt = sql<string>`to_char(n.available_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

export interface ListOptions {
  limit: number;
  cursor?: string;
  unread?: boolean;
  category?: notification.NotificationCategory;
}

@Injectable()
export class NotificationsRepository {
  constructor(@InjectDb() private readonly db: Db) {}

  async unreadCount(userId: string, db: DbOrTrx = this.db): Promise<number> {
    const row = await db
      .selectFrom('notifications')
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .where('user_id', '=', userId)
      .where('read_at', 'is', null)
      .where('available_at', '<=', sql<Date>`now()`)
      .executeTakeFirst();
    return Number(row?.count ?? 0);
  }

  async unreadCounts(userIds: readonly string[]): Promise<Map<string, number>> {
    const ids = [...new Set(userIds)];
    const counts = new Map(ids.map((id) => [id, 0]));
    if (ids.length === 0) return counts;
    const rows = await this.db
      .selectFrom('notifications')
      .select(['user_id', (eb) => eb.fn.countAll<number>().as('count')])
      .where('user_id', 'in', ids)
      .where('read_at', 'is', null)
      .where('available_at', '<=', sql<Date>`now()`)
      .groupBy('user_id')
      .execute();
    for (const r of rows) counts.set(r.user_id, Number(r.count));
    return counts;
  }

  async list(
    userId: string,
    organizationId: string,
    options: ListOptions,
  ): Promise<{ items: NotificationDto[]; nextCursor: string | null }> {
    let query = this.db
      .selectFrom('notifications as n')
      .selectAll('n')
      .select(cursorAt.as('cursor_at'))
      .where('n.user_id', '=', userId)
      .where('n.organization_id', '=', organizationId)
      .where('n.available_at', '<=', sql<Date>`now()`);
    if (options.unread) query = query.where('n.read_at', 'is', null);
    if (options.category) {
      const types = NOTIFICATION_TYPE_DEFS.filter((d) => d.category === options.category).map(
        (d) => d.key,
      );
      query = query.where('n.type', 'in', types);
    }
    if (options.cursor) {
      const c = decodeCursor(options.cursor);
      query = query.where(
        sql<boolean>`(n.available_at, n.id) < (${c.at}::timestamptz, ${c.id}::uuid)`,
      );
    }
    const rows = await query
      .orderBy('n.available_at', 'desc')
      .orderBy('n.id', 'desc')
      .limit(options.limit + 1)
      .execute();
    const page = rows.slice(0, options.limit);
    const last = page[page.length - 1];
    return {
      items: page.map(toNotificationDto),
      nextCursor:
        rows.length > options.limit && last ? encodeCursor(last.cursor_at, last.id) : null,
    };
  }

  /** Notifications that became available after the given one (SSE `Last-Event-ID` replay), oldest first. */
  async listAfter(userId: string, lastId: string, limit: number): Promise<NotificationDto[]> {
    const rows = await this.db
      .selectFrom('notifications as n')
      .selectAll('n')
      .where('n.user_id', '=', userId)
      .where('n.available_at', '<=', sql<Date>`now()`)
      // Compare in SQL so the anchor keeps its microsecond precision.
      .where(
        sql<boolean>`(n.available_at, n.id) > (select a.available_at, a.id from notifications a where a.id = ${lastId}::uuid and a.user_id = ${userId}::uuid)`,
      )
      .orderBy('n.available_at', 'asc')
      .orderBy('n.id', 'asc')
      .limit(limit)
      .execute();
    return rows.map(toNotificationDto);
  }

  async find(userId: string, id: string): Promise<NotificationRow | undefined> {
    return this.db
      .selectFrom('notifications')
      .selectAll()
      .where('id', '=', id)
      .where('user_id', '=', userId)
      .where('available_at', '<=', sql<Date>`now()`)
      .executeTakeFirst();
  }

  async findById(id: string): Promise<NotificationRow | undefined> {
    return this.db.selectFrom('notifications').selectAll().where('id', '=', id).executeTakeFirst();
  }

  async markRead(userId: string, id: string): Promise<NotificationRow | undefined> {
    return this.db
      .updateTable('notifications')
      .set({ read_at: sql<Date>`now()` })
      .where('id', '=', id)
      .where('user_id', '=', userId)
      .where('read_at', 'is', null)
      .where('available_at', '<=', sql<Date>`now()`)
      .returningAll()
      .executeTakeFirst();
  }

  async markAllRead(userId: string, organizationId: string): Promise<number> {
    const result = await this.db
      .updateTable('notifications')
      .set({ read_at: sql<Date>`now()` })
      .where('user_id', '=', userId)
      .where('organization_id', '=', organizationId)
      .where('read_at', 'is', null)
      .where('available_at', '<=', sql<Date>`now()`)
      .executeTakeFirst();
    return Number(result.numUpdatedRows ?? 0n);
  }
}
