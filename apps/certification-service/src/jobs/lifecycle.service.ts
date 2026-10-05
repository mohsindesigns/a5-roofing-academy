import { Injectable } from '@nestjs/common';
import { sql } from '@a5/database';
import { certificationEvents } from '@a5/events';
import { EventBus, InjectDb } from '@a5/nest-kit';
import { uuidv7 } from '@a5/observability';
import type { Db } from '../database/index.js';
import { addDays, daysBetween } from '../common/dates.js';
import { recordCertificateEvent } from '../common/timeline.js';
import { markDirty } from '../eligibility/dirty.js';
import { EligibilityService } from '../eligibility/eligibility.service.js';

const SYSTEM = { actor: { type: 'system' as const, id: null } };

export interface LifecycleSummary {
  expired: number;
  renewalsOpened: number;
  reminders: number;
}

/**
 * Daily lifecycle: expire certificates, open renewal windows and send expiry reminders. Every step
 * is idempotent (conditional updates, unique rows), so re-running a day never repeats an effect.
 */
@Injectable()
export class LifecycleService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly events: EventBus,
    private readonly eligibility: EligibilityService,
  ) {}

  /** Open renewal windows first, then expire, so a certificate never skips its renewal record. */
  async runDaily(now = new Date()): Promise<LifecycleSummary> {
    const renewalsOpened = await this.openRenewalWindows(now);
    const expired = await this.expire(now);
    const reminders = await this.sendReminders(now);
    return { expired, renewalsOpened, reminders };
  }

  /** Start the renewal window of certificates whose window (expiry − windowDays) has begun. */
  async openRenewalWindows(now = new Date()): Promise<number> {
    const due = await this.db
      .selectFrom('issued_certificates as c')
      .innerJoin('certification_definitions as d', 'd.id', 'c.definition_id')
      .select(['c.id', 'c.organization_id', 'c.definition_id', 'c.user_id', 'c.issued_at', 'c.expires_at', 'c.certificate_number', 'd.name', 'd.renewal_policy'])
      .where('c.status', '=', 'issued')
      .where('d.status', '=', 'active')
      .where('c.expires_at', 'is not', null)
      .where('c.expires_at', '>', now)
      .where(sql<boolean>`c.expires_at - make_interval(days => (d.renewal_policy->>'windowDays')::int) <= ${now}`)
      .where(sql<boolean>`(d.renewal_policy->>'windowDays')::int > 0`)
      .where((eb) => eb.not(eb.exists(eb.selectFrom('certificate_renewals as n').select('n.id').whereRef('n.certificate_id', '=', 'c.id'))))
      .limit(500)
      .execute();
    let opened = 0;
    for (const c of due) {
      const windowStart = new Date(Math.max(addDays(c.expires_at!, -c.renewal_policy.windowDays).getTime(), c.issued_at.getTime()));
      if (await this.openRenewal(c, windowStart, 'open', now)) opened++;
    }
    return opened;
  }

  private async openRenewal(
    c: { id: string; organization_id: string; definition_id: string; user_id: string; expires_at: Date | null; name: string; certificate_number: string },
    windowStart: Date,
    status: 'open' | 'lapsed',
    now: Date,
  ): Promise<boolean> {
    const renewalId = uuidv7();
    const created = await this.db.transaction().execute(async (trx) => {
      const inserted = await trx
        .insertInto('certificate_renewals')
        .values({
          id: renewalId,
          organization_id: c.organization_id,
          certificate_id: c.id,
          definition_id: c.definition_id,
          user_id: c.user_id,
          status,
          window_opened_at: windowStart,
          due_at: c.expires_at,
          completed_at: null,
          new_certificate_id: null,
        })
        .onConflict((oc) => oc.column('certificate_id').doNothing())
        .returning('id')
        .executeTakeFirst();
      if (!inserted) return false;
      // A new cycle: the renewal requirements are counted from the moment the window opened.
      await trx
        .updateTable('certification_candidates')
        .set((eb) => ({
          status: 'in_progress',
          purpose: 'renewal',
          renewal_id: renewalId,
          cycle: eb('cycle', '+', 1),
          eligible_at: null,
          rejected_at: null,
          issue_error: null,
        }))
        .where('definition_id', '=', c.definition_id)
        .where('user_id', '=', c.user_id)
        .where('certificate_id', '=', c.id)
        .execute();
      await recordCertificateEvent(trx, {
        organizationId: c.organization_id,
        certificateId: c.id,
        type: 'renewal_opened',
        data: { renewalId, dueAt: c.expires_at?.toISOString() ?? null },
        occurredAt: now,
      });
      await this.events.emit(
        trx,
        certificationEvents.renewalRequired,
        {
          certificateId: c.id,
          definitionId: c.definition_id,
          definitionName: c.name,
          userId: c.user_id,
          renewalId,
          dueAt: (c.expires_at ?? now).toISOString(),
        },
        { organizationId: c.organization_id, subject: { type: 'certificate', id: c.id }, ...SYSTEM },
      );
      await markDirty(trx, { organizationId: c.organization_id, userIds: [c.user_id], definitionIds: [c.definition_id], learnerActivity: false });
      return true;
    });
    if (created) await this.eligibility.processDirty({ userId: c.user_id, definitionId: c.definition_id });
    return created;
  }

  /** Mark certificates past their expiration date as expired. */
  async expire(now = new Date()): Promise<number> {
    const due = await this.db
      .selectFrom('issued_certificates as c')
      .innerJoin('certification_definitions as d', 'd.id', 'c.definition_id')
      .select(['c.id', 'c.organization_id', 'c.definition_id', 'c.user_id', 'c.expires_at', 'c.certificate_number', 'd.name', 'd.status as definition_status'])
      .where('c.status', '=', 'issued')
      .where('c.expires_at', '<=', now)
      .orderBy('c.expires_at')
      .limit(500)
      .execute();
    let expired = 0;
    for (const c of due) {
      const done = await this.db.transaction().execute(async (trx) => {
        const updated = await trx
          .updateTable('issued_certificates')
          .set({ status: 'expired', expired_at: now })
          .where('id', '=', c.id)
          .where('status', '=', 'issued')
          .executeTakeFirst();
        if (Number(updated.numUpdatedRows) === 0) return false;
        await trx.updateTable('certificate_renewals').set({ status: 'lapsed' }).where('certificate_id', '=', c.id).where('status', '=', 'open').execute();
        await recordCertificateEvent(trx, {
          organizationId: c.organization_id,
          certificateId: c.id,
          type: 'expired',
          data: { expiredAt: c.expires_at!.toISOString() },
          occurredAt: now,
        });
        await this.events.emit(
          trx,
          certificationEvents.expired,
          { certificateId: c.id, definitionId: c.definition_id, definitionName: c.name, userId: c.user_id, expiredAt: c.expires_at!.toISOString() },
          { organizationId: c.organization_id, subject: { type: 'certificate', id: c.id }, ...SYSTEM },
        );
        await this.events.audit(
          trx,
          { action: 'certificate.expired', resourceType: 'certificate', resourceId: c.id, actorDisplay: null, after: { certificateNumber: c.certificate_number } },
          { organizationId: c.organization_id, ...SYSTEM },
        );
        return true;
      });
      if (!done) continue;
      expired++;
      // Windows of zero days (or certificates that never had one) still need a recertification path.
      if (c.definition_status === 'active') {
        const existing = await this.db.selectFrom('certificate_renewals').select('id').where('certificate_id', '=', c.id).executeTakeFirst();
        if (!existing) await this.openRenewal(c, c.expires_at!, 'lapsed', now);
      }
    }
    return expired;
  }

  /**
   * Reminders at the configured offsets. Each (certificate, offset) is recorded once; when several
   * offsets were passed at once (a late run, a short validity) only the most urgent one is announced.
   */
  async sendReminders(now = new Date()): Promise<number> {
    const rows = await this.db
      .selectFrom('issued_certificates as c')
      .innerJoin('certification_definitions as d', 'd.id', 'c.definition_id')
      .select(['c.id', 'c.organization_id', 'c.definition_id', 'c.user_id', 'c.expires_at', 'd.name', 'd.renewal_policy'])
      .where('c.status', '=', 'issued')
      .where('d.status', '=', 'active')
      .where('c.expires_at', '>', now)
      .where(sql<boolean>`c.expires_at <= ${now}::timestamptz + interval '366 days'`)
      .execute();
    let sent = 0;
    for (const c of rows) {
      const remaining = daysBetween(now, c.expires_at!);
      const reached = c.renewal_policy.reminderOffsets.filter((o) => remaining <= o).sort((a, b) => a - b);
      const target = reached[0];
      if (target === undefined) continue;
      const announced = await this.db.transaction().execute(async (trx) => {
        let targetInserted = false;
        for (const offset of reached) {
          const inserted = await trx
            .insertInto('certificate_reminders')
            .values({ certificate_id: c.id, offset_days: offset, days_remaining: remaining, sent: offset === target })
            .onConflict((oc) => oc.columns(['certificate_id', 'offset_days']).doNothing())
            .returning('offset_days')
            .executeTakeFirst();
          if (inserted && offset === target) targetInserted = true;
        }
        if (!targetInserted) return false;
        await recordCertificateEvent(trx, {
          organizationId: c.organization_id,
          certificateId: c.id,
          type: 'expiry_reminder',
          data: { offsetDays: target, daysRemaining: remaining },
          occurredAt: now,
        });
        await this.events.emit(
          trx,
          certificationEvents.expiring,
          {
            certificateId: c.id,
            definitionId: c.definition_id,
            definitionName: c.name,
            userId: c.user_id,
            expiresAt: c.expires_at!.toISOString(),
            daysRemaining: remaining,
          },
          { organizationId: c.organization_id, subject: { type: 'certificate', id: c.id }, ...SYSTEM },
        );
        return true;
      });
      if (announced) sent++;
    }
    return sent;
  }
}
