import type { certification } from '@a5/contracts';
import type { Selectable } from '@a5/database';
import type { IssuedCertificatesTable } from '../database/index.js';

export type CertificateRow = Selectable<IssuedCertificatesTable>;

export interface SummaryRow extends CertificateRow {
  definition_name: string;
  definition_code: string;
  recipient_name: string;
}

/** `expired` as soon as the expiration date passes, even before the nightly job records it. */
export function effectiveStatus(
  row: Pick<CertificateRow, 'status' | 'expires_at'>,
  now: Date,
): certification.CertificateStatus {
  if (row.status === 'issued' && row.expires_at && row.expires_at <= now) return 'expired';
  return row.status;
}

export function summaryDto(row: SummaryRow, now: Date): certification.CertificateSummary {
  return {
    id: row.id,
    certificateNumber: row.certificate_number,
    status: row.status,
    effectiveStatus: effectiveStatus(row, now),
    definition: { id: row.definition_id, name: row.definition_name, code: row.definition_code },
    recipient: { id: row.user_id, displayName: row.recipient_name },
    issuedAt: row.issued_at.toISOString(),
    expiresAt: row.expires_at?.toISOString() ?? null,
    mode: row.mode,
    pdfStatus: row.pdf_status,
    revokedAt: row.revoked_at?.toISOString() ?? null,
    supersededAt: row.superseded_at?.toISOString() ?? null,
  };
}
