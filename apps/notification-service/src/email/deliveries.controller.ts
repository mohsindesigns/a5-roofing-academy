import { Get, Injectable } from '@nestjs/common';
import type { Principal } from '@a5/auth';
import { notification } from '@a5/contracts';
import { likePattern, paginate, type Page, type Selectable } from '@a5/database';
import { ApiController, CurrentPrincipal, InjectDb, NotFoundError, RequirePermissions, ZParam, ZQuery, ZResponse } from '@a5/nest-kit';
import type { Db, EmailDeliveriesTable } from '../database/index.js';

type DeliveryRow = Selectable<EmailDeliveriesTable>;

function toDto(row: DeliveryRow): notification.EmailDelivery {
  return {
    id: row.id,
    type: row.notification_type,
    userId: row.user_id,
    to: row.to_address,
    toName: row.to_name,
    subject: row.subject,
    status: row.status,
    attempts: row.attempts,
    providerMessageId: row.provider_message_id,
    error: row.last_error,
    sensitive: row.sensitive,
    scheduledAt: row.scheduled_at.toISOString(),
    lastAttemptAt: row.last_attempt_at?.toISOString() ?? null,
    sentAt: row.sent_at?.toISOString() ?? null,
    failedAt: row.failed_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
  };
}

/** Read-only log of outgoing email for administrators. Security email content is never shown. */
@Injectable()
export class DeliveriesService {
  constructor(@InjectDb() private readonly db: Db) {}

  async list(p: Principal, q: notification.ListEmailDeliveriesQuery): Promise<Page<notification.EmailDelivery>> {
    let query = this.db
      .selectFrom('email_deliveries')
      .select([
        'id',
        'organization_id',
        'user_id',
        'notification_type',
        'source_event_id',
        'to_address',
        'to_name',
        'subject',
        'sensitive',
        'status',
        'attempts',
        'provider_message_id',
        'last_error',
        'scheduled_at',
        'last_attempt_at',
        'sent_at',
        'failed_at',
        'created_at',
        'updated_at',
      ])
      .where('organization_id', '=', p.organizationId);
    if (q.status) query = query.where('status', '=', q.status);
    if (q.type) query = query.where('notification_type', '=', q.type);
    if (q.userId) query = query.where('user_id', '=', q.userId);
    if (q.q) {
      const pattern = likePattern(q.q);
      query = query.where((eb) => eb.or([eb('to_address', 'ilike', pattern), eb('to_name', 'ilike', pattern), eb('subject', 'ilike', pattern)]));
    }
    const page = await paginate(query.orderBy('created_at', 'desc').orderBy('id', 'desc'), { page: q.page, pageSize: q.pageSize });
    return {
      ...page,
      items: page.items.map((r) => toDto({ ...r, body_text: null, body_html: null, sealed_content: null } as DeliveryRow)),
    };
  }

  async get(p: Principal, id: string): Promise<notification.EmailDeliveryDetail> {
    const row = await this.db
      .selectFrom('email_deliveries')
      .selectAll()
      .where('id', '=', id)
      .where('organization_id', '=', p.organizationId)
      .executeTakeFirst();
    if (!row) throw new NotFoundError('Email delivery');
    return { ...toDto(row), text: row.sensitive ? null : row.body_text, html: row.sensitive ? null : row.body_html };
  }
}

@ApiController('notifications/email-deliveries')
@RequirePermissions('notifications.manage')
export class DeliveriesController {
  constructor(private readonly deliveries: DeliveriesService) {}

  @Get()
  @ZResponse(notification.emailDeliveryPageSchema)
  list(@CurrentPrincipal() p: Principal, @ZQuery(notification.listEmailDeliveriesQuerySchema) q: notification.ListEmailDeliveriesQuery) {
    return this.deliveries.list(p, q);
  }

  @Get(':id')
  @ZResponse(notification.emailDeliveryDetailSchema)
  get(@CurrentPrincipal() p: Principal, @ZParam('id') id: string) {
    return this.deliveries.get(p, id);
  }
}
