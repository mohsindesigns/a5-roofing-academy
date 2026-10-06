import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { certificationEvents } from '@a5/events';
import { EventBus, InjectDb } from '@a5/nest-kit';
import type { ObjectStorage } from '@a5/storage';
import type { Db, DbOrTrx } from '../database/index.js';
import { InjectStorage, storageKeys } from '../common/storage.js';
import { recordCertificateEvent } from '../common/timeline.js';
import { renderSnapshotPdf } from '../rendering/snapshot-render.js';

export type PdfOutcome = 'generated' | 'already_ready' | 'missing';

/**
 * Render a certificate's PDF from its snapshot, store it with its SHA-256 and mark it ready.
 * Idempotent: a ready certificate whose file exists is left alone.
 */
export async function generateCertificatePdf(
  db: DbOrTrx,
  storage: ObjectStorage,
  certificateId: string,
  onReady?: (
    trx: DbOrTrx,
    info: {
      organizationId: string;
      definitionId: string;
      definitionName: string;
      userId: string;
      certificateNumber: string;
    },
  ) => Promise<void>,
  now: Date = new Date(),
): Promise<PdfOutcome> {
  const row = await db
    .selectFrom('issued_certificates as c')
    .innerJoin('certificate_snapshots as s', 's.certificate_id', 'c.id')
    .select([
      'c.id',
      'c.organization_id',
      'c.definition_id',
      'c.user_id',
      'c.certificate_number',
      'c.pdf_status',
      'c.pdf_storage_key',
      's.data',
    ])
    .where('c.id', '=', certificateId)
    .executeTakeFirst();
  if (!row) return 'missing';
  if (
    row.pdf_status === 'ready' &&
    row.pdf_storage_key &&
    (await storage.headObject(row.pdf_storage_key))
  )
    return 'already_ready';

  const pdf = await renderSnapshotPdf(storage, row.data);
  const key = storageKeys.certificateFile(row.organization_id, row.id, 'certificate.pdf');
  await storage.putObject(key, pdf, { contentType: 'application/pdf', contentLength: pdf.length });
  const sha256 = createHash('sha256').update(pdf).digest('hex');

  const apply = async (trx: DbOrTrx) => {
    const updated = await trx
      .updateTable('issued_certificates')
      .set({
        pdf_status: 'ready',
        pdf_storage_key: key,
        pdf_sha256: sha256,
        pdf_byte_size: pdf.length,
        pdf_generated_at: now,
        pdf_error: null,
      })
      .where('id', '=', row.id)
      .where('pdf_status', '<>', 'ready')
      .executeTakeFirst();
    if (Number(updated.numUpdatedRows) === 0) return;
    await recordCertificateEvent(trx, {
      organizationId: row.organization_id,
      certificateId: row.id,
      type: 'pdf_generated',
      data: { sha256, byteSize: pdf.length },
      occurredAt: now,
    });
    await onReady?.(trx, {
      organizationId: row.organization_id,
      definitionId: row.definition_id,
      definitionName: row.data.certification.name,
      userId: row.user_id,
      certificateNumber: row.certificate_number,
    });
  };
  if (db.isTransaction) await apply(db);
  else await db.transaction().execute(apply);
  return 'generated';
}

@Injectable()
export class PdfService {
  constructor(
    @InjectDb() private readonly db: Db,
    @InjectStorage() private readonly storage: ObjectStorage,
    private readonly events: EventBus,
  ) {}

  generate(certificateId: string): Promise<PdfOutcome> {
    return generateCertificatePdf(this.db, this.storage, certificateId, async (trx, info) => {
      await this.events.emit(
        trx as Db,
        certificationEvents.generated,
        {
          certificateId,
          definitionId: info.definitionId,
          definitionName: info.definitionName,
          userId: info.userId,
          certificateNumber: info.certificateNumber,
        },
        {
          organizationId: info.organizationId,
          subject: { type: 'certificate', id: certificateId },
          actor: { type: 'system', id: null },
        },
      );
    });
  }

  /** Record a failed attempt; the last attempt marks the PDF as failed for administrators. */
  async recordFailure(certificateId: string, error: unknown, final: boolean): Promise<void> {
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 500);
    await this.db.transaction().execute(async (trx) => {
      const row = await trx
        .updateTable('issued_certificates')
        .set((eb) => ({
          pdf_attempts: eb('pdf_attempts', '+', 1),
          pdf_error: message,
          ...(final && { pdf_status: 'failed' as const }),
        }))
        .where('id', '=', certificateId)
        .where('pdf_status', '<>', 'ready')
        .returning(['organization_id'])
        .executeTakeFirst();
      if (row && final) {
        await recordCertificateEvent(trx, {
          organizationId: row.organization_id,
          certificateId,
          type: 'pdf_failed',
          data: { error: message },
        });
      }
    });
  }
}
