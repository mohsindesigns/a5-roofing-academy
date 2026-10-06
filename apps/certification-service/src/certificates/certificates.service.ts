import { Inject, Injectable } from '@nestjs/common';
import type { Principal } from '@a5/auth';
import { certification } from '@a5/contracts';
import { likePattern, paginate, sql, type Expression, type Page, type SqlBool } from '@a5/database';
import { userScopeCondition } from '@a5/directory';
import { certificationEvents } from '@a5/events';
import { QueueFactory } from '@a5/messaging';
import {
  ConflictError,
  EventBus,
  ForbiddenError,
  InjectDb,
  NotFoundError,
  PreconditionError,
  ValidationError,
} from '@a5/nest-kit';
import { uuidv7 } from '@a5/observability';
import type { ObjectStorage } from '@a5/storage';
import { CERTIFICATION_CONFIG, type CertificationConfig } from '../config.js';
import type { Db } from '../database/index.js';
import { AccessService } from '../common/access.js';
import { addDays } from '../common/dates.js';
import { InjectStorage } from '../common/storage.js';
import { personRef, recordCertificateEvent } from '../common/timeline.js';
import { EligibilityService } from '../eligibility/eligibility.service.js';
import { IssuanceService } from '../issuance/issuance.service.js';
import type { CertificateSnapshotData } from '../issuance/snapshot.js';
import { QUEUES, type PdfJobData } from '../jobs/queues.js';
import { effectiveStatus, summaryDto, type SummaryRow } from './dto.js';
import { certificateSummaryQuery } from './queries.js';

export interface CertificateListFilters {
  q?: string;
  status?: Array<'issued' | 'expired' | 'revoked' | 'superseded'>;
  definitionId?: string;
  userId?: string;
  teamId?: string;
  issuedFrom?: string;
  issuedTo?: string;
  expiringWithinDays?: number;
  sort?: string;
  page: number;
  pageSize: number;
}

const SORTS: Record<string, string> = {
  issuedAt: 'c.issued_at',
  expiresAt: 'c.expires_at',
  number: 'c.certificate_number',
  status: 'c.status',
};

@Injectable()
export class CertificatesService {
  constructor(
    @InjectDb() private readonly db: Db,
    @InjectStorage() private readonly storage: ObjectStorage,
    private readonly events: EventBus,
    private readonly access: AccessService,
    private readonly eligibility: EligibilityService,
    private readonly issuance: IssuanceService,
    private readonly queues: QueueFactory,
    @Inject(CERTIFICATION_CONFIG) private readonly config: CertificationConfig,
  ) {}

  // ------------------------------------------------------------------ queries

  private summaryQuery() {
    return certificateSummaryQuery(this.db);
  }

  /** Certificates visible to the caller through `certificates.view` (scoped by the user directory). */
  async list(
    p: Principal,
    f: CertificateListFilters,
  ): Promise<Page<certification.CertificateSummary>> {
    const now = new Date();
    let q = this.summaryQuery()
      .where('c.organization_id', '=', p.organizationId)
      .where(
        userScopeCondition(p.scopeFilter('certificates.view'), {
          userColumn: 'c.user_id',
          orgColumn: 'c.organization_id',
        }),
      );
    if (f.q) {
      const pattern = likePattern(f.q);
      q = q.where((eb) =>
        eb.or([
          eb('c.certificate_number', 'ilike', pattern),
          eb(sql`s.data->'recipient'->>'legalName'`, 'ilike', pattern),
          eb(
            'c.user_id',
            'in',
            eb.selectFrom('dir_users').select('id').where('display_name', 'ilike', pattern),
          ),
          eb(sql`(select employee_id from dir_users where id = c.user_id)`, 'ilike', pattern),
        ]),
      );
    }
    if (f.status?.length) {
      const conditions = f.status.map((s) => statusCondition(s, now));
      q = q.where(sql<SqlBool>`(${sql.join(conditions, sql` or `)})`);
    }
    if (f.definitionId) q = q.where('c.definition_id', '=', f.definitionId);
    if (f.userId) q = q.where('c.user_id', '=', f.userId);
    if (f.teamId)
      q = q.where('c.user_id', 'in', (eb) =>
        eb.selectFrom('dir_user_teams').select('user_id').where('team_id', '=', f.teamId!),
      );
    if (f.issuedFrom) q = q.where('c.issued_at', '>=', new Date(`${f.issuedFrom}T00:00:00Z`));
    if (f.issuedTo)
      q = q.where('c.issued_at', '<', addDays(new Date(`${f.issuedTo}T00:00:00Z`), 1));
    if (f.expiringWithinDays) {
      q = q
        .where('c.status', '=', 'issued')
        .where('c.expires_at', '>', now)
        .where('c.expires_at', '<=', addDays(now, f.expiringWithinDays));
    }
    const desc = f.sort ? f.sort.startsWith('-') : true;
    const sortColumn = SORTS[f.sort?.replace(/^-/, '') ?? 'issuedAt'] ?? SORTS.issuedAt!;
    q = q
      .orderBy(sql.ref(sortColumn), (ob) => (desc ? ob.desc().nullsLast() : ob.asc().nullsLast()))
      .orderBy('c.id', 'desc');
    const page = await paginate(q, f);
    return { ...page, items: page.items.map((r) => summaryDto(r as SummaryRow, now)) };
  }

  private async loadRow(id: string, organizationId: string): Promise<SummaryRow> {
    const row = await this.summaryQuery()
      .where('c.id', '=', id)
      .where('c.organization_id', '=', organizationId)
      .executeTakeFirst();
    if (!row) throw new NotFoundError('Certificate');
    return row as SummaryRow;
  }

  private async snapshotOf(certificateId: string): Promise<CertificateSnapshotData> {
    const s = await this.db
      .selectFrom('certificate_snapshots')
      .select('data')
      .where('certificate_id', '=', certificateId)
      .executeTakeFirstOrThrow();
    return s.data;
  }

  private async detailParts(row: SummaryRow) {
    const [snapshot, revocation, replaces, replacedBy, renewal, definition] = await Promise.all([
      this.snapshotOf(row.id),
      this.db
        .selectFrom('certificate_revocations')
        .selectAll()
        .where('certificate_id', '=', row.id)
        .executeTakeFirst(),
      this.db
        .selectFrom('certificate_reissues as r')
        .innerJoin('issued_certificates as o', 'o.id', 'r.original_certificate_id')
        .select(['o.id', 'o.certificate_number', 'r.reason_code', 'r.note'])
        .where('r.new_certificate_id', '=', row.id)
        .executeTakeFirst(),
      this.db
        .selectFrom('issued_certificates as n')
        .select(['n.id', 'n.certificate_number', 'n.mode', 'n.issued_at'])
        .where('n.id', '=', row.superseded_by_id ?? '00000000-0000-0000-0000-000000000000')
        .executeTakeFirst(),
      this.db
        .selectFrom('certificate_renewals')
        .selectAll()
        .where('certificate_id', '=', row.id)
        .executeTakeFirst(),
      this.db
        .selectFrom('certification_definitions')
        .select('public_verification_enabled')
        .where('id', '=', row.definition_id)
        .executeTakeFirstOrThrow(),
    ]);
    return {
      snapshot,
      revocation,
      replaces,
      replacedBy,
      renewal,
      publicVerificationEnabled: definition.public_verification_enabled,
    };
  }

  async detail(p: Principal, id: string): Promise<certification.CertificateDetail> {
    const row = await this.loadRow(id, p.organizationId);
    await this.access.assertAdmits(
      p,
      'certificates.view',
      { userId: row.user_id, organizationId: row.organization_id },
      'Certificate',
    );
    return this.buildDetail(row);
  }

  /** The owner's view: no internal notes, override reasons or issuer. */
  async ownDetail(p: Principal, id: string) {
    const row = await this.loadRow(id, p.organizationId);
    if (row.user_id !== p.userId) throw new NotFoundError('Certificate');
    const full = await this.buildDetail(row);
    const { overrideReason: _override, issuedBy: _issuedBy, ...rest } = full;
    return {
      ...rest,
      revocation: full.revocation
        ? { revokedAt: full.revocation.revokedAt, publicNote: full.revocation.publicNote }
        : null,
    };
  }

  private async buildDetail(row: SummaryRow): Promise<certification.CertificateDetail> {
    const now = new Date();
    const parts = await this.detailParts(row);
    const { snapshot } = parts;
    return {
      ...summaryDto(row, now),
      recipientName: snapshot.recipient.legalName,
      employeeId: snapshot.recipient.employeeId,
      issuer: snapshot.certification.issuingOrganizationName,
      programNames: snapshot.programs.map((pr) => pr.title).filter((t): t is string => Boolean(t)),
      completionDate: snapshot.dates.completionDate,
      signatories: snapshot.signatories.map((s) => ({
        slot: s.slot,
        name: s.name,
        title: s.title,
      })),
      template: {
        id: snapshot.template.templateId,
        versionId: snapshot.template.versionId,
        version: snapshot.template.version,
      },
      issuedBy: personRef(row.issued_by, row.issued_by_name),
      overrideReason: row.override_reason,
      verificationUrl: snapshot.verificationUrl,
      publicVerificationEnabled: parts.publicVerificationEnabled,
      pdfGeneratedAt: row.pdf_generated_at?.toISOString() ?? null,
      pdfSha256: row.pdf_sha256,
      revocation: parts.revocation
        ? {
            revokedAt: parts.revocation.revoked_at.toISOString(),
            reason: parts.revocation.reason,
            publicNote: parts.revocation.public_note,
            revokedBy: personRef(parts.revocation.revoked_by, parts.revocation.revoked_by_name),
          }
        : null,
      replaces: parts.replaces
        ? {
            id: parts.replaces.id,
            certificateNumber: parts.replaces.certificate_number,
            reasonCode: parts.replaces.reason_code,
            note: parts.replaces.note,
          }
        : null,
      replacedBy: parts.replacedBy
        ? {
            id: parts.replacedBy.id,
            certificateNumber: parts.replacedBy.certificate_number,
            kind: parts.replacedBy.mode === 'renewal' ? 'renewal' : 'reissue',
            at: row.superseded_at?.toISOString() ?? parts.replacedBy.issued_at.toISOString(),
          }
        : null,
      renewal: parts.renewal
        ? {
            id: parts.renewal.id,
            certificateId: parts.renewal.certificate_id,
            status: parts.renewal.status,
            windowOpenedAt: parts.renewal.window_opened_at.toISOString(),
            dueAt: parts.renewal.due_at?.toISOString() ?? null,
            completedAt: parts.renewal.completed_at?.toISOString() ?? null,
            newCertificateId: parts.renewal.new_certificate_id,
          }
        : null,
    };
  }

  async timeline(p: Principal, id: string) {
    const row = await this.loadRow(id, p.organizationId);
    await this.access.assertAdmits(
      p,
      'certificates.view',
      { userId: row.user_id, organizationId: row.organization_id },
      'Certificate',
    );
    const events = await this.db
      .selectFrom('certificate_events')
      .selectAll()
      .where('certificate_id', '=', id)
      .orderBy('occurred_at')
      .orderBy('id')
      .execute();
    return {
      items: events.map((e) => ({
        id: e.id,
        type: e.type,
        occurredAt: e.occurred_at.toISOString(),
        actor: { id: e.actor_id, displayName: e.actor_name },
        data: e.data,
      })),
    };
  }

  // ------------------------------------------------------------------ issuing

  /**
   * Manual issuance. Requires `certificates.issue` for the person, and satisfied requirements
   * unless an authorized administrator supplies an override reason.
   */
  async issueManually(
    p: Principal,
    input: { definitionId: string; userId: string; override?: { reason: string } },
  ) {
    await this.access.assertAdmits(
      p,
      'certificates.issue',
      { userId: input.userId, organizationId: p.organizationId },
      'Person',
    );
    const def = await this.db
      .selectFrom('certification_definitions')
      .selectAll()
      .where('id', '=', input.definitionId)
      .where('organization_id', '=', p.organizationId)
      .executeTakeFirst();
    if (!def) throw new NotFoundError('Certification');
    if (def.status !== 'active')
      throw new PreconditionError(
        'CERTIFICATION_NOT_ACTIVE',
        `"${def.name}" is not active. Activate it before issuing certificates.`,
      );

    const candidate = await this.db
      .selectFrom('certification_candidates')
      .selectAll()
      .where('definition_id', '=', def.id)
      .where('user_id', '=', input.userId)
      .executeTakeFirst();
    const outcome = await this.eligibility.compute(
      this.db,
      def,
      input.userId,
      candidate ?? null,
      new Date(),
    );
    const unmet = outcome.requirements.filter((r) => !r.satisfied).map((r) => r.description);
    const blocked = !outcome.satisfied || Boolean(candidate?.hold_reason);
    if (blocked && !input.override) {
      throw new PreconditionError(
        'NOT_ELIGIBLE',
        candidate?.hold_reason
          ? `${candidate.hold_reason}. An administrator can issue with an override reason or reopen the candidate.`
          : `Requirements are not met yet: ${unmet.slice(0, 3).join('; ') || 'no requirements configured'}${unmet.length > 3 ? ` and ${unmet.length - 3} more` : ''}. Issuing is blocked until they are complete.`,
        { unmet },
      );
    }
    if (blocked && input.override && !p.can('certifications.update')) {
      throw new ForbiddenError(
        'Only administrators who can update certifications may override unmet requirements.',
      );
    }
    const renewal = candidate?.purpose === 'renewal';
    const result = await this.issuance.issue({
      definitionId: def.id,
      userId: input.userId,
      mode: renewal ? 'renewal' : 'manual',
      renewalId: renewal ? candidate!.renewal_id : null,
      actor: { userId: p.userId, displayName: p.displayName },
      overrideReason: blocked ? input.override!.reason : null,
      clearHold: true,
    });
    return this.detail(p, result.certificateId);
  }

  async reissue(
    p: Principal,
    id: string,
    input: { reasonCode: 'corrected_name' | 'corrected_data' | 'administrative'; note: string },
  ) {
    const row = await this.loadRow(id, p.organizationId);
    await this.access.assertAdmits(
      p,
      'certificates.reissue',
      { userId: row.user_id, organizationId: row.organization_id },
      'Certificate',
    );
    if (row.status !== 'issued') {
      throw new ConflictError(
        'CERTIFICATE_NOT_ACTIVE',
        `Only an active certificate can be reissued. This one is ${effectiveStatus(row, new Date())}.`,
      );
    }
    const result = await this.issuance.issue({
      definitionId: row.definition_id,
      userId: row.user_id,
      mode: 'reissue',
      actor: { userId: p.userId, displayName: p.displayName },
      reissue: { originalCertificateId: row.id, reasonCode: input.reasonCode, note: input.note },
    });
    return this.detail(p, result.certificateId);
  }

  async revoke(
    p: Principal,
    id: string,
    input: { reason: string; publicNote?: string | null; confirmation: string },
  ) {
    const row = await this.loadRow(id, p.organizationId);
    await this.access.assertAdmits(
      p,
      'certificates.revoke',
      { userId: row.user_id, organizationId: row.organization_id },
      'Certificate',
    );
    const phrase = certification.revocationPhrase(row.certificate_number);
    if (input.confirmation.trim().toUpperCase() !== phrase.toUpperCase()) {
      throw new ValidationError([
        { path: 'confirmation', message: `Type "${phrase}" to confirm.` },
      ]);
    }
    const now = new Date();
    await this.db.transaction().execute(async (trx) => {
      const current = await trx
        .selectFrom('issued_certificates')
        .selectAll()
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirstOrThrow();
      if (current.status === 'revoked')
        throw new ConflictError('ALREADY_REVOKED', 'This certificate is already revoked.');
      if (current.status === 'superseded') {
        throw new ConflictError(
          'CERTIFICATE_SUPERSEDED',
          'This certificate was replaced by a newer one. Revoke the current certificate instead.',
        );
      }
      await trx
        .updateTable('issued_certificates')
        .set({ status: 'revoked', revoked_at: now })
        .where('id', '=', id)
        .execute();
      await trx
        .insertInto('certificate_revocations')
        .values({
          id: uuidv7(now.getTime()),
          certificate_id: id,
          reason: input.reason,
          public_note: input.publicNote ?? null,
          revoked_at: now,
          revoked_by: p.userId,
          revoked_by_name: p.displayName,
        })
        .execute();
      // The person stays on hold: revocation must be undone deliberately, never by automatic re-issuance.
      await trx
        .updateTable('certification_candidates')
        .set({
          status: 'in_progress',
          purpose: 'initial',
          renewal_id: null,
          eligible_at: null,
          hold_reason: `Certificate ${row.certificate_number} was revoked`,
          held_at: now,
        })
        .where('definition_id', '=', current.definition_id)
        .where('user_id', '=', current.user_id)
        .where('certificate_id', '=', id)
        .execute();
      await trx
        .updateTable('certificate_renewals')
        .set({ status: 'cancelled' })
        .where('certificate_id', '=', id)
        .where('status', 'in', ['open', 'lapsed'])
        .execute();
      await recordCertificateEvent(trx, {
        organizationId: row.organization_id,
        certificateId: id,
        type: 'revoked',
        actor: { id: p.userId, name: p.displayName },
        data: { reason: input.reason, publicNote: input.publicNote ?? null },
        occurredAt: now,
      });
      await this.events.emit(
        trx,
        certificationEvents.revoked,
        {
          certificateId: id,
          definitionId: row.definition_id,
          definitionName: row.definition_name,
          userId: row.user_id,
          certificateNumber: row.certificate_number,
          reason: input.reason,
        },
        { organizationId: row.organization_id, subject: { type: 'certificate', id } },
      );
      await this.events.audit(trx, {
        action: 'certificate.revoked',
        resourceType: 'certificate',
        resourceId: id,
        actorDisplay: p.displayName,
        before: { status: current.status },
        after: { status: 'revoked', certificateNumber: row.certificate_number },
        reason: input.reason,
      });
    });
    return this.detail(p, id);
  }

  // ------------------------------------------------------------------ PDF

  /**
   * Short-lived signed download link. The owner (certificates.view_own) or someone whose
   * `certificates.view` scope covers the owner may download; every download is audited.
   */
  async download(p: Principal, id: string, mode: 'owner' | 'admin') {
    const row = await this.loadRow(id, p.organizationId);
    if (mode === 'owner') {
      if (row.user_id !== p.userId) throw new NotFoundError('Certificate');
      if (row.status === 'revoked')
        throw new PreconditionError(
          'CERTIFICATE_REVOKED',
          'This certificate was revoked and can no longer be downloaded.',
        );
    } else {
      await this.access.assertAdmits(
        p,
        'certificates.view',
        { userId: row.user_id, organizationId: row.organization_id },
        'Certificate',
      );
    }
    if (row.pdf_status !== 'ready' || !row.pdf_storage_key) {
      throw new PreconditionError(
        row.pdf_status === 'failed' ? 'PDF_FAILED' : 'PDF_NOT_READY',
        row.pdf_status === 'failed'
          ? 'The certificate PDF could not be generated. An administrator has been notified; try again later.'
          : 'Your certificate PDF is still being prepared. Try again in a moment.',
      );
    }
    const ttl = this.config.certification.downloadUrlTtlSeconds;
    const fileName = `${row.certificate_number}.pdf`;
    const url = await this.storage.signedGetUrl(row.pdf_storage_key, {
      expiresInSeconds: ttl,
      downloadName: fileName,
      contentType: 'application/pdf',
    });
    await this.db.transaction().execute(async (trx) => {
      await recordCertificateEvent(trx, {
        organizationId: row.organization_id,
        certificateId: id,
        type: 'downloaded',
        actor: { id: p.userId, name: p.displayName },
        data: { by: mode },
      });
      await this.events.emit(
        trx,
        certificationEvents.downloaded,
        {
          certificateId: id,
          definitionId: row.definition_id,
          definitionName: row.definition_name,
          userId: row.user_id,
          downloadedBy: p.userId,
        },
        { organizationId: row.organization_id, subject: { type: 'certificate', id } },
      );
      await this.events.audit(trx, {
        action: 'certificate.downloaded',
        resourceType: 'certificate',
        resourceId: id,
        actorDisplay: p.displayName,
        metadata: { certificateNumber: row.certificate_number, by: mode },
      });
    });
    return { url, expiresAt: new Date(Date.now() + ttl * 1000).toISOString(), fileName };
  }

  /** Re-queue a certificate whose PDF failed (or is still pending). */
  async retryPdf(p: Principal, id: string) {
    const row = await this.loadRow(id, p.organizationId);
    await this.access.assertAdmits(
      p,
      'certificates.reissue',
      { userId: row.user_id, organizationId: row.organization_id },
      'Certificate',
    );
    if (row.pdf_status === 'ready')
      throw new PreconditionError('PDF_READY', 'The PDF has already been generated.');
    await this.db
      .updateTable('issued_certificates')
      .set({ pdf_status: 'pending', pdf_error: null, pdf_attempts: 0 })
      .where('id', '=', id)
      .execute();
    await this.requeuePdf(id);
    return this.detail(p, id);
  }

  /** Enqueue the PDF job, replacing a finished job that still occupies the certificate's job id. */
  async requeuePdf(certificateId: string): Promise<void> {
    const queue = this.queues.queue<PdfJobData>(QUEUES.pdf);
    const existing = await queue.getJob(certificateId);
    if (existing) {
      const state = await existing.getState();
      if (
        state === 'active' ||
        state === 'waiting' ||
        state === 'delayed' ||
        state === 'prioritized'
      )
        return;
      await existing.remove().catch(() => undefined);
    }
    await this.queues.add<PdfJobData>(
      QUEUES.pdf,
      'render',
      { certificateId },
      { jobId: certificateId },
    );
  }
}

function statusCondition(
  status: 'issued' | 'expired' | 'revoked' | 'superseded',
  now: Date,
): Expression<SqlBool> {
  switch (status) {
    case 'issued':
      return sql<SqlBool>`(c.status = 'issued' and (c.expires_at is null or c.expires_at > ${now}))`;
    case 'expired':
      return sql<SqlBool>`(c.status = 'expired' or (c.status = 'issued' and c.expires_at <= ${now}))`;
    default:
      return sql<SqlBool>`c.status = ${status}`;
  }
}
