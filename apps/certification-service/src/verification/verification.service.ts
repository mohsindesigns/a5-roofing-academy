import { Inject, Injectable } from '@nestjs/common';
import type { certification } from '@a5/contracts';
import { AppError, InjectDb } from '@a5/nest-kit';
import { CERTIFICATION_CONFIG, type CertificationConfig } from '../config.js';
import type { Db } from '../database/index.js';
import { calendarDate } from '../common/dates.js';
import { loadSettings } from '../common/settings.js';

const UNAVAILABLE = () =>
  new AppError(
    404,
    'NOT_AVAILABLE',
    'This certificate could not be found or is not available for public verification.',
  );

/** "Jordan Ellis" → "Jordan E." when the organization prefers not to publish full names. */
function displayName(
  full: string,
  firstName: string,
  lastName: string,
  mode: 'full_name' | 'first_name_last_initial',
): string {
  if (mode === 'full_name') return full;
  const initial = lastName.trim().charAt(0);
  return initial ? `${firstName.trim()} ${initial.toUpperCase()}.` : firstName.trim();
}

/**
 * Public verification. Everything returned is built field by field from an allow-list: no contact
 * details, scores, transcripts, internal notes or reasons ever reach this DTO.
 */
@Injectable()
export class VerificationService {
  constructor(
    @InjectDb() private readonly db: Db,
    @Inject(CERTIFICATION_CONFIG) private readonly config: CertificationConfig,
  ) {}

  async verify(token: string, now = new Date()): Promise<certification.PublicVerification> {
    const row = await this.db
      .selectFrom('issued_certificates as c')
      .innerJoin('certification_definitions as d', 'd.id', 'c.definition_id')
      .innerJoin('certificate_snapshots as s', 's.certificate_id', 'c.id')
      .leftJoin('certificate_revocations as r', 'r.certificate_id', 'c.id')
      .select([
        'c.organization_id',
        'c.status',
        'c.certificate_number',
        'c.issued_at',
        'c.expires_at',
        'd.public_verification_enabled',
        's.data as snapshot',
        'r.revoked_at',
        'r.public_note',
      ])
      .where('c.verification_token', '=', token)
      .executeTakeFirst();
    if (!row || !row.public_verification_enabled) throw UNAVAILABLE();

    const settings = await loadSettings(this.db, row.organization_id, this.config.publicAppUrl);
    const tz = settings.timezone;
    let status: certification.PublicVerification['status'] = 'valid';
    if (row.status === 'revoked') status = 'revoked';
    else if (row.status === 'superseded') status = 'superseded';
    else if (row.status === 'expired' || (row.expires_at && row.expires_at <= now))
      status = 'expired';

    const recipient = row.snapshot.recipient;
    return {
      status,
      recipientName: displayName(
        recipient.legalName,
        recipient.firstName,
        recipient.lastName,
        settings.recipientNameDisplay,
      ),
      certificationName: row.snapshot.certification.name,
      issuer: row.snapshot.certification.issuingOrganizationName,
      issuedAt: calendarDate(row.issued_at, tz),
      expiresAt:
        row.expires_at && settings.showExpirationDate ? calendarDate(row.expires_at, tz) : null,
      certificateNumber: settings.showCertificateNumber ? row.certificate_number : null,
      revokedAt: status === 'revoked' && row.revoked_at ? calendarDate(row.revoked_at, tz) : null,
      revocationNote: status === 'revoked' ? (row.public_note ?? null) : null,
      checkedAt: now.toISOString(),
    };
  }
}
