import { Inject, Injectable } from '@nestjs/common';
import { certification } from '@a5/contracts';
import { isUniqueViolation } from '@a5/database';
import { certificationEvents } from '@a5/events';
import { DistributedLock, LockNotAcquiredError, QueueFactory } from '@a5/messaging';
import { ConflictError, EventBus, InjectDb, LOGGER, NotFoundError, PreconditionError } from '@a5/nest-kit';
import { randomToken, uuidv7, type Logger } from '@a5/observability';
import type { ObjectStorage } from '@a5/storage';
import { CERTIFICATION_CONFIG, type CertificationConfig } from '../config.js';
import type { CertificationDefinitionsTable, Db, IssueMode, IssuedCertificatesTable } from '../database/index.js';
import type { Selectable } from '@a5/database';
import { assetsByIds, currentSignatures, currentStampImages, inEffect, type AssetRow, type CurrentImage } from '../common/artwork-repo.js';
import { calendarDate, computeExpiry } from '../common/dates.js';
import { RecipientResolver } from '../common/recipients.js';
import { loadSettings, organizationCode, verificationUrl } from '../common/settings.js';
import { InjectStorage, extensionFor, storageKeys } from '../common/storage.js';
import { recordCertificateEvent } from '../common/timeline.js';
import { QUEUES, type PdfJobData } from '../jobs/queues.js';
import { signatureSlotOf } from '../rendering/layout.js';
import { placeholderValues } from '../rendering/values.js';
import { SNAPSHOT_SCHEMA_VERSION, type CertificateSnapshotData, type SnapshotImage } from './snapshot.js';

type Definition = Selectable<CertificationDefinitionsTable>;
type CertificateRow = Selectable<IssuedCertificatesTable>;

export interface IssueActor {
  userId: string | null;
  displayName: string | null;
}

export interface IssueParams {
  definitionId: string;
  userId: string;
  mode: IssueMode;
  actor: IssueActor;
  /** Manual issuance despite unmet requirements (recorded on the certificate and audited). */
  overrideReason?: string | null;
  reissue?: { originalCertificateId: string; reasonCode: 'corrected_name' | 'corrected_data' | 'administrative'; note: string };
  renewalId?: string | null;
  /** Clears a hold placed on the candidate (e.g. after a revocation). */
  clearHold?: boolean;
  /** Issue date; defaults to now (seeds use historical dates). */
  issuedAt?: Date;
  /** Seeds only: name to print instead of the identity value (historical corrections). */
  recipientNameOverride?: string;
}

export interface IssueResult {
  certificateId: string;
  certificateNumber: string;
}

const LOCK_TTL_MS = 60_000;

/**
 * Certificate issuance. Runs under a distributed lock per (certification, person) and commits the
 * number allocation, certificate, immutable snapshot, timeline and outbox events in one transaction.
 * The partial unique index on active certificates backs the lock, and the sequence row lock keeps
 * numbers unique and gap-free under concurrency.
 */
@Injectable()
export class IssuanceService {
  constructor(
    @InjectDb() private readonly db: Db,
    @InjectStorage() private readonly storage: ObjectStorage,
    private readonly locks: DistributedLock,
    private readonly queues: QueueFactory,
    private readonly events: EventBus,
    private readonly recipients: RecipientResolver,
    @Inject(CERTIFICATION_CONFIG) private readonly config: CertificationConfig,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  async issue(params: IssueParams): Promise<IssueResult> {
    let result: IssueResult;
    try {
      result = await this.locks.withLock(`cert:${params.definitionId}:${params.userId}`, LOCK_TTL_MS, () => this.issueLocked(params), {
        waitMs: this.config.certification.issueLockWaitMs,
      });
    } catch (err) {
      if (err instanceof LockNotAcquiredError) {
        throw new ConflictError('ISSUANCE_IN_PROGRESS', 'A certificate for this person is being issued right now. Refresh in a moment.');
      }
      throw err;
    }
    await this.enqueuePdf(result.certificateId);
    return result;
  }

  async enqueuePdf(certificateId: string): Promise<void> {
    try {
      await this.queues.add<PdfJobData>(QUEUES.pdf, 'render', { certificateId }, { jobId: certificateId });
    } catch (err) {
      // The sweeper re-enqueues certificates whose PDF stays pending.
      this.logger.warn({ err, certificateId }, 'could not enqueue certificate PDF; the sweeper will retry');
    }
  }

  private async issueLocked(params: IssueParams): Promise<IssueResult> {
    const now = params.issuedAt ?? new Date();
    const def = await this.db.selectFrom('certification_definitions').selectAll().where('id', '=', params.definitionId).executeTakeFirst();
    if (!def) throw new NotFoundError('Certification');
    if (def.status !== 'active' && !(params.mode === 'reissue' && def.status === 'archived')) {
      throw new PreconditionError('CERTIFICATION_NOT_ACTIVE', `"${def.name}" is not active. Activate it before issuing certificates.`);
    }

    const active = await this.db
      .selectFrom('issued_certificates')
      .selectAll()
      .where('definition_id', '=', def.id)
      .where('user_id', '=', params.userId)
      .where('status', '=', 'issued')
      .executeTakeFirst();
    let supersede: CertificateRow | null = null;
    if (params.mode === 'reissue') {
      if (!active || active.id !== params.reissue?.originalCertificateId) {
        throw new ConflictError('CERTIFICATE_NOT_ACTIVE', 'Only the active certificate can be reissued. Reload to see its current status.');
      }
      if (active.expires_at && active.expires_at <= now) {
        throw new PreconditionError('CERTIFICATE_EXPIRED', 'This certificate has expired. Issue a new certificate instead of reissuing it.');
      }
      supersede = active;
    } else if (params.mode === 'renewal') {
      supersede = active ?? null;
    } else if (active) {
      throw new ConflictError('ALREADY_CERTIFIED', `This person already holds an active certificate (${active.certificate_number}). Reissue it to correct details.`, {
        certificateId: active.id,
      });
    }
    const renewal = params.renewalId
      ? await this.db.selectFrom('certificate_renewals').selectAll().where('id', '=', params.renewalId).executeTakeFirst()
      : null;
    if (params.renewalId && (!renewal || renewal.definition_id !== def.id || renewal.user_id !== params.userId || renewal.status === 'completed' || renewal.status === 'cancelled')) {
      throw new ConflictError('RENEWAL_CLOSED', 'This renewal is no longer open.');
    }
    if (supersede && params.mode === 'renewal' && renewal && supersede.id !== renewal.certificate_id) supersede = null;

    const settings = await loadSettings(this.db, def.organization_id, this.config.publicAppUrl);
    const artwork = await this.resolveArtwork(def, now, settings.timezone);
    const recipient = await this.recipients.resolve(params.userId, def.organization_id);
    const legalName = params.recipientNameOverride ?? recipient.legalName;

    let expiresAt: Date | null;
    if (params.mode === 'reissue') {
      expiresAt = supersede!.expires_at;
    } else {
      const base = params.mode === 'renewal' && supersede?.expires_at && supersede.expires_at > now ? supersede.expires_at : now;
      expiresAt = computeExpiry(def.validity_policy, base);
    }
    if (expiresAt && expiresAt <= now) {
      throw new PreconditionError('VALIDITY_ENDED', 'The fixed expiration date of this certification has passed. Update its validity before issuing.');
    }

    const programs = await this.db
      .selectFrom('certification_programs as cp')
      .leftJoin('program_catalog as pc', 'pc.program_id', 'cp.program_id')
      .select(['cp.program_id', 'pc.title'])
      .where('cp.definition_id', '=', def.id)
      .orderBy('pc.title')
      .execute();
    const completion = programs.length
      ? await this.db
          .selectFrom('learner_program_status')
          .select((eb) => eb.fn.max('completed_at').as('completed_at'))
          .where('user_id', '=', params.userId)
          .where('program_id', 'in', programs.map((p) => p.program_id))
          .executeTakeFirst()
      : undefined;
    const completionDate = (completion?.completed_at as Date | null | undefined) ?? null;

    const certificateId = uuidv7(now.getTime());
    const token = randomToken(32);
    const url = verificationUrl(settings, token);
    const prefix = storageKeys.certificatePrefix(def.organization_id, certificateId);

    // Copy every image into the certificate's own prefix before committing: later signature, stamp or
    // template image changes can never alter what this certificate shows.
    const copy = async (asset: AssetRow, name: string): Promise<SnapshotImage> => {
      const key = storageKeys.certificateFile(def.organization_id, certificateId, `${name}.${extensionFor(asset.content_type)}`);
      await this.storage.copyObject(asset.storage_key, key);
      return { key, contentType: asset.content_type, sha256: asset.sha256, width: asset.width, height: asset.height };
    };

    try {
      const signatories = await Promise.all(
        artwork.slots.map(async (s) => ({
          slot: s.slot,
          signatoryId: s.id,
          name: s.name,
          title: s.title,
          department: s.department,
          signatureVersionId: s.signature?.versionId ?? null,
          image: s.signature ? await copy(s.signature.asset, `signature-${s.slot}`) : null,
        })),
      );
      const stamp = artwork.stamp
        ? {
            stampId: artwork.stamp.id,
            name: artwork.stamp.name,
            kind: artwork.stamp.kind,
            imageVersionId: artwork.stamp.image.versionId,
            image: await copy(artwork.stamp.image.asset, 'stamp'),
          }
        : null;
      const assets: Record<string, SnapshotImage> = {};
      for (const [id, asset] of artwork.assets) assets[id] = await copy(asset, `asset-${id}`);

      const customVariables = Object.fromEntries(def.custom_variables.map((v) => [v.key, v.value]));

      return await this.db.transaction().execute(async (trx) => {
        if (supersede) {
          const updated = await trx
            .updateTable('issued_certificates')
            .set({ status: 'superseded', superseded_at: now })
            .where('id', '=', supersede.id)
            .where('status', '=', 'issued')
            .executeTakeFirst();
          if (Number(updated.numUpdatedRows) === 0) {
            throw new ConflictError('CERTIFICATE_CHANGED', 'The certificate changed while this request was running. Reload and try again.');
          }
        }

        await trx.insertInto('certificate_number_sequences').values({ definition_id: def.id }).onConflict((oc) => oc.column('definition_id').doNothing()).execute();
        const seq = await trx
          .updateTable('certificate_number_sequences')
          .set((eb) => ({ last_value: eb('last_value', '+', 1) }))
          .where('definition_id', '=', def.id)
          .returning('last_value')
          .executeTakeFirstOrThrow();
        const certificateNumber = certification.formatCertificateNumber(def.number_pattern, {
          org: organizationCode(settings, def.issuing_organization_name),
          code: def.code,
          issuedAt: now,
          seq: Number(seq.last_value),
        });

        await trx
          .insertInto('certification_candidates')
          .values({
            id: uuidv7(),
            organization_id: def.organization_id,
            definition_id: def.id,
            user_id: params.userId,
            status: 'in_progress',
            purpose: 'initial',
            cycle: 1,
            renewal_id: null,
            requirements: [],
            met_count: 0,
            total_count: 0,
            auto_requirements_met: false,
            evaluated_at: null,
            eligible_at: null,
            eligible_cycle: null,
            rejected_at: null,
            hold_reason: null,
            held_at: null,
            issue_error: null,
            certificate_id: null,
          })
          .onConflict((oc) => oc.columns(['definition_id', 'user_id']).doNothing())
          .execute();
        const candidate = await trx
          .updateTable('certification_candidates')
          .set({
            status: 'issued',
            purpose: 'initial',
            certificate_id: certificateId,
            issue_error: null,
            renewal_id: null,
            ...((params.clearHold || params.mode === 'manual') && { hold_reason: null, held_at: null }),
          })
          .where('definition_id', '=', def.id)
          .where('user_id', '=', params.userId)
          .returning(['id', 'eligible_at'])
          .executeTakeFirstOrThrow();

        // A manual issuance can overtake an open approval request; it no longer needs a decision.
        await trx
          .updateTable('certificate_approvals')
          .set({ status: 'cancelled', decided_at: now, comment: 'A certificate was issued.' })
          .where('candidate_id', '=', candidate.id)
          .where('status', '=', 'pending')
          .execute();

        const snapshot: CertificateSnapshotData = {
          schemaVersion: SNAPSHOT_SCHEMA_VERSION,
          certificateId,
          certificateNumber,
          verificationUrl: url,
          recipient: {
            userId: params.userId,
            legalName,
            firstName: recipient.firstName,
            lastName: recipient.lastName,
            employeeId: recipient.employeeId,
            source: recipient.source,
          },
          certification: {
            definitionId: def.id,
            name: def.name,
            code: def.code,
            publicDescription: def.public_description,
            issuingOrganizationName: def.issuing_organization_name,
            revision: def.revision,
          },
          programs: programs.map((p) => ({ id: p.program_id, title: p.title })),
          dates: {
            issuedAt: now.toISOString(),
            expiresAt: expiresAt?.toISOString() ?? null,
            completionDate: completionDate ? calendarDate(completionDate, settings.timezone) : null,
            timezone: settings.timezone,
          },
          template: { templateId: artwork.template.id, versionId: artwork.template.versionId, version: artwork.template.version, design: artwork.template.design },
          signatories,
          stamp,
          assets,
          customVariables,
          placeholders: placeholderValues({
            certificateName: def.name,
            recipientName: legalName,
            employeeId: recipient.employeeId,
            programNames: programs.map((p) => p.title).filter((t): t is string => Boolean(t)),
            completionDate: completionDate ?? candidate.eligible_at ?? null,
            issuedAt: now,
            expiresAt,
            certificateNumber,
            verificationUrl: url,
            organizationName: def.issuing_organization_name,
            signatories: signatories.map((s) => ({ slot: s.slot, name: s.name, title: s.title })),
            customVariables,
            timezone: settings.timezone,
          }),
        };

        await trx
          .insertInto('issued_certificates')
          .values({
            id: certificateId,
            organization_id: def.organization_id,
            definition_id: def.id,
            user_id: params.userId,
            candidate_id: candidate.id,
            certificate_number: certificateNumber,
            verification_token: token,
            status: 'issued',
            mode: params.mode,
            issued_at: now,
            expires_at: expiresAt,
            issued_by: params.actor.userId,
            issued_by_name: params.actor.displayName,
            override_reason: params.overrideReason ?? null,
            template_id: artwork.template.id,
            template_version_id: artwork.template.versionId,
            pdf_status: 'pending',
            pdf_storage_key: null,
            pdf_sha256: null,
            pdf_byte_size: null,
            pdf_generated_at: null,
            pdf_error: null,
            expired_at: null,
            revoked_at: null,
            superseded_at: null,
            superseded_by_id: null,
            created_at: now,
          })
          .execute();
        await trx.insertInto('certificate_snapshots').values({ certificate_id: certificateId, schema_version: SNAPSHOT_SCHEMA_VERSION, data: snapshot }).execute();

        const actor = { id: params.actor.userId, name: params.actor.displayName };
        if (supersede) {
          await trx.updateTable('issued_certificates').set({ superseded_by_id: certificateId }).where('id', '=', supersede.id).execute();
          await recordCertificateEvent(trx, {
            organizationId: def.organization_id,
            certificateId: supersede.id,
            type: 'superseded',
            actor,
            data: { by: certificateId, certificateNumber, reason: params.mode },
            occurredAt: now,
          });
        }
        if (params.reissue) {
          await trx
            .insertInto('certificate_reissues')
            .values({
              id: uuidv7(now.getTime()),
              original_certificate_id: params.reissue.originalCertificateId,
              new_certificate_id: certificateId,
              reason_code: params.reissue.reasonCode,
              note: params.reissue.note,
              reissued_at: now,
              reissued_by: params.actor.userId,
              reissued_by_name: params.actor.displayName,
            })
            .execute();
        }
        if (renewal) {
          await trx
            .updateTable('certificate_renewals')
            .set({ status: 'completed', completed_at: now, new_certificate_id: certificateId })
            .where('id', '=', renewal.id)
            .execute();
        }
        await recordCertificateEvent(trx, {
          organizationId: def.organization_id,
          certificateId,
          type: params.mode === 'reissue' ? 'reissued' : params.mode === 'renewal' ? 'renewed' : 'issued',
          actor,
          data: {
            certificateNumber,
            mode: params.mode,
            ...(params.overrideReason && { overrideReason: params.overrideReason }),
            ...(supersede && { replaces: supersede.id, replacesNumber: supersede.certificate_number }),
            ...(params.reissue && { reasonCode: params.reissue.reasonCode, note: params.reissue.note }),
          },
          occurredAt: now,
        });

        const eventOptions = {
          organizationId: def.organization_id,
          subject: { type: 'certificate', id: certificateId },
          ...(params.actor.userId ? { actor: { type: 'user' as const, id: params.actor.userId } } : {}),
        };
        await this.events.emit(
          trx,
          certificationEvents.issued,
          {
            certificateId,
            definitionId: def.id,
            definitionName: def.name,
            userId: params.userId,
            certificateNumber,
            issuedAt: now.toISOString(),
            expiresAt: expiresAt?.toISOString() ?? null,
            mode: params.mode,
          },
          eventOptions,
        );
        if (params.reissue) {
          await this.events.emit(
            trx,
            certificationEvents.reissued,
            {
              certificateId,
              definitionId: def.id,
              definitionName: def.name,
              userId: params.userId,
              originalCertificateId: params.reissue.originalCertificateId,
              reason: params.reissue.reasonCode,
            },
            eventOptions,
          );
        }
        await this.events.audit(
          trx,
          {
            action: params.mode === 'reissue' ? 'certificate.reissued' : 'certificate.issued',
            resourceType: 'certificate',
            resourceId: certificateId,
            actorDisplay: params.actor.displayName,
            after: { certificateNumber, definitionId: def.id, userId: params.userId, mode: params.mode, expiresAt: expiresAt?.toISOString() ?? null },
            ...(supersede && { before: { certificateId: supersede.id, certificateNumber: supersede.certificate_number } }),
            reason: params.overrideReason ?? params.reissue?.note ?? null,
            metadata: { templateVersionId: artwork.template.versionId, recipientSource: recipient.source },
          },
          eventOptions,
        );
        return { certificateId, certificateNumber };
      });
    } catch (err) {
      await this.storage.deletePrefix(prefix).catch((cleanupErr: unknown) => this.logger.warn({ err: cleanupErr, prefix }, 'failed to clean up certificate files'));
      if (isUniqueViolation(err, 'issued_certificates_one_active_uq')) {
        throw new ConflictError('ALREADY_CERTIFIED', 'This person already holds an active certificate for this certification.');
      }
      throw err;
    }
  }

  /** Template version, signatories (with current signatures), stamp and template images to snapshot. */
  private async resolveArtwork(def: Definition, now: Date, timezone: string) {
    const today = calendarDate(now, timezone);
    let templateId = def.template_id;
    if (!templateId) {
      const fallback = await this.db
        .selectFrom('certificate_templates')
        .select('id')
        .where('organization_id', '=', def.organization_id)
        .where('is_default', '=', true)
        .executeTakeFirst();
      templateId = fallback?.id ?? null;
    }
    if (!templateId) throw new PreconditionError('NO_TEMPLATE', `Assign a certificate template to "${def.name}" before issuing.`);
    const template = await this.db
      .selectFrom('certificate_templates as t')
      .innerJoin('certificate_template_versions as v', (j) => j.onRef('v.template_id', '=', 't.id').onRef('v.version', '=', 't.current_version'))
      .select(['t.id', 'v.id as version_id', 'v.version', 'v.design'])
      .where('t.id', '=', templateId)
      .executeTakeFirstOrThrow();
    const design = template.design;

    const slotRows = await this.db
      .selectFrom('certification_signatory_slots as s')
      .innerJoin('signatories as g', 'g.id', 's.signatory_id')
      .select(['s.slot', 'g.id', 'g.name', 'g.title', 'g.department', 'g.active', 'g.effective_from', 'g.effective_to'])
      .where('s.definition_id', '=', def.id)
      .orderBy('s.slot')
      .execute();
    const allowed = slotRows.length
      ? await this.db
          .selectFrom('signatory_certifications')
          .select(['signatory_id', 'definition_id'])
          .where('signatory_id', 'in', slotRows.map((s) => s.id))
          .execute()
      : [];
    const signatures = await currentSignatures(this.db, slotRows.map((s) => s.id));
    for (const n of [1, 2] as const) {
      const used = design.elements.some((el) => (el.type === 'signature' && signatureSlotOf(el) === n) || el.content.includes(`signatory_${n}_`));
      const row = slotRows.find((s) => s.slot === n);
      if (!used) continue;
      if (!row) throw new PreconditionError('SIGNATORY_MISSING', `The certificate template shows signatory ${n}, but "${def.name}" has none assigned.`);
      const restricted = allowed.filter((a) => a.signatory_id === row.id);
      if (!inEffect(row, today) || (restricted.length > 0 && !restricted.some((a) => a.definition_id === def.id))) {
        throw new PreconditionError('SIGNATORY_UNAVAILABLE', `${row.name} cannot sign "${def.name}" today. Assign an active signatory.`);
      }
      if (design.elements.some((el) => el.type === 'signature' && signatureSlotOf(el) === n) && !signatures.get(row.id)) {
        throw new PreconditionError('SIGNATURE_MISSING', `${row.name} has no signature image. Upload one before issuing.`);
      }
    }

    let stamp: { id: string; name: string; kind: string; image: CurrentImage } | null = null;
    if (design.elements.some((el) => el.type === 'stamp')) {
      if (!def.stamp_id) throw new PreconditionError('STAMP_MISSING', `The certificate template shows a stamp, but "${def.name}" has none assigned.`);
      const row = await this.db.selectFrom('stamps').selectAll().where('id', '=', def.stamp_id).executeTakeFirstOrThrow();
      const restricted = await this.db.selectFrom('stamp_certifications').select('definition_id').where('stamp_id', '=', row.id).execute();
      if (!inEffect(row, today) || (restricted.length > 0 && !restricted.some((r) => r.definition_id === def.id))) {
        throw new PreconditionError('STAMP_UNAVAILABLE', `The stamp "${row.name}" cannot be used for "${def.name}" today.`);
      }
      const image = (await currentStampImages(this.db, [row.id])).get(row.id);
      if (!image) throw new PreconditionError('STAMP_IMAGE_MISSING', `Upload an image for the stamp "${row.name}" before issuing.`);
      stamp = { id: row.id, name: row.name, kind: row.kind, image };
    }

    const assetIds = certification.designAssetIds(design);
    const assets = await assetsByIds(this.db, def.organization_id, assetIds);
    if (assets.size !== assetIds.length) throw new PreconditionError('TEMPLATE_IMAGE_MISSING', 'An image used by the certificate template is missing. Edit the template.');

    return {
      template: { id: template.id, versionId: template.version_id, version: template.version, design },
      slots: slotRows.map((s) => ({ ...s, signature: signatures.get(s.id) ?? null })),
      stamp,
      assets,
    };
  }
}
