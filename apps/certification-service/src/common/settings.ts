import type { DbOrTrx } from '../database/index.js';

export interface EffectiveSettings {
  organizationCode: string | null;
  verificationBaseUrl: string | null;
  effectiveVerificationBaseUrl: string;
  recipientNameDisplay: 'full_name' | 'first_name_last_initial';
  showCertificateNumber: boolean;
  showExpirationDate: boolean;
  timezone: string;
  updatedAt: Date | null;
}

export const DEFAULT_TIMEZONE = 'America/Chicago';

/** Organization certification settings with defaults applied (no row means defaults). */
export async function loadSettings(
  db: DbOrTrx,
  organizationId: string,
  publicAppUrl: string,
): Promise<EffectiveSettings> {
  const row = await db
    .selectFrom('certification_settings')
    .selectAll()
    .where('organization_id', '=', organizationId)
    .executeTakeFirst();
  const base = row?.verification_base_url ?? null;
  return {
    organizationCode: row?.organization_code ?? null,
    verificationBaseUrl: base,
    effectiveVerificationBaseUrl: (base ?? publicAppUrl).replace(/\/+$/, ''),
    recipientNameDisplay: row?.recipient_name_display ?? 'full_name',
    showCertificateNumber: row?.show_certificate_number ?? true,
    showExpirationDate: row?.show_expiration_date ?? true,
    timezone: row?.timezone ?? DEFAULT_TIMEZONE,
    updatedAt: row?.updated_at ?? null,
  };
}

export function verificationUrl(
  settings: Pick<EffectiveSettings, 'effectiveVerificationBaseUrl'>,
  token: string,
): string {
  return `${settings.effectiveVerificationBaseUrl}/verify/${token}`;
}

/** Value of the {ORG} numbering token: configured code, else derived from the issuer ("A5 Roofing LLC" → "A5"). */
export function organizationCode(
  settings: Pick<EffectiveSettings, 'organizationCode'>,
  issuingOrganizationName: string,
): string {
  if (settings.organizationCode) return settings.organizationCode;
  const first = issuingOrganizationName.trim().split(/\s+/)[0] ?? '';
  const code = first
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 10);
  return code || 'ORG';
}
