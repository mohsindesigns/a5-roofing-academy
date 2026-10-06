import { Inject, Injectable } from '@nestjs/common';
import type { Principal } from '@a5/auth';
import type { certification } from '@a5/contracts';
import { EventBus, InjectDb } from '@a5/nest-kit';
import { CERTIFICATION_CONFIG, type CertificationConfig } from '../config.js';
import type { Db } from '../database/index.js';
import { DEFAULT_TIMEZONE, loadSettings, type EffectiveSettings } from '../common/settings.js';

type UpdateInput = {
  organizationCode?: string | null;
  verificationBaseUrl?: string | null;
  recipientNameDisplay?: 'full_name' | 'first_name_last_initial';
  showCertificateNumber?: boolean;
  showExpirationDate?: boolean;
  timezone?: string;
};

@Injectable()
export class SettingsService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly events: EventBus,
    @Inject(CERTIFICATION_CONFIG) private readonly config: CertificationConfig,
  ) {}

  load(organizationId: string): Promise<EffectiveSettings> {
    return loadSettings(this.db, organizationId, this.config.publicAppUrl);
  }

  async get(p: Principal): Promise<certification.CertificationSettings> {
    return toDto(await this.load(p.organizationId));
  }

  async update(p: Principal, input: UpdateInput): Promise<certification.CertificationSettings> {
    const before = await this.load(p.organizationId);
    await this.db.transaction().execute(async (trx) => {
      await trx
        .insertInto('certification_settings')
        .values({
          organization_id: p.organizationId,
          organization_code:
            input.organizationCode !== undefined ? input.organizationCode : before.organizationCode,
          verification_base_url:
            input.verificationBaseUrl !== undefined
              ? input.verificationBaseUrl
              : before.verificationBaseUrl,
          recipient_name_display: input.recipientNameDisplay ?? before.recipientNameDisplay,
          show_certificate_number: input.showCertificateNumber ?? before.showCertificateNumber,
          show_expiration_date: input.showExpirationDate ?? before.showExpirationDate,
          timezone: input.timezone ?? before.timezone ?? DEFAULT_TIMEZONE,
          updated_by: p.userId,
        })
        .onConflict((oc) =>
          oc.column('organization_id').doUpdateSet((eb) => ({
            organization_code: eb.ref('excluded.organization_code'),
            verification_base_url: eb.ref('excluded.verification_base_url'),
            recipient_name_display: eb.ref('excluded.recipient_name_display'),
            show_certificate_number: eb.ref('excluded.show_certificate_number'),
            show_expiration_date: eb.ref('excluded.show_expiration_date'),
            timezone: eb.ref('excluded.timezone'),
            updated_by: eb.ref('excluded.updated_by'),
          })),
        )
        .execute();
      await this.events.audit(trx, {
        action: 'certification_settings.updated',
        resourceType: 'certification_settings',
        resourceId: p.organizationId,
        actorDisplay: p.displayName,
        before: toDto(before),
        after: input,
      });
    });
    return this.get(p);
  }
}

function toDto(s: EffectiveSettings): certification.CertificationSettings {
  return {
    organizationCode: s.organizationCode,
    verificationBaseUrl: s.verificationBaseUrl,
    effectiveVerificationBaseUrl: s.effectiveVerificationBaseUrl,
    recipientNameDisplay: s.recipientNameDisplay,
    showCertificateNumber: s.showCertificateNumber,
    showExpirationDate: s.showExpirationDate,
    timezone: s.timezone,
    updatedAt: s.updatedAt?.toISOString() ?? null,
  };
}
