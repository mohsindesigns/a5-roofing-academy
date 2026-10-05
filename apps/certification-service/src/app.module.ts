import { DynamicModule, Module } from '@nestjs/common';
import { CoreModule, DatabaseModule, EventsModule, RedisModule } from '@a5/nest-kit';
import { DirectoryModule } from '@a5/directory';
import type { Logger } from '@a5/observability';
import type { ObjectStorage } from '@a5/storage';
import { AssetsModule } from './assets/assets.module.js';
import { CertificatesModule } from './certificates/certificates.module.js';
import { CommonModule } from './common/common.module.js';
import type { CertificationConfig } from './config.js';
import { migrations } from './database/migrations/index.js';
import { DefinitionsModule } from './definitions/definitions.module.js';
import { EligibilityModule } from './eligibility/eligibility.module.js';
import { IssuanceModule } from './issuance/issuance.module.js';
import { JobsModule } from './jobs/jobs.module.js';
import { SettingsModule } from './settings/settings.module.js';
import { SignatoriesModule } from './signatories/signatories.module.js';
import { TemplatesModule } from './templates/templates.module.js';
import { VerificationModule } from './verification/verification.module.js';

@Module({})
export class AppModule {
  /** `storage` overrides the configured driver (tests inject a temp-dir local storage). */
  static register(config: CertificationConfig, logger: Logger, options: { storage?: ObjectStorage } = {}): DynamicModule {
    return {
      module: AppModule,
      imports: [
        CoreModule.forRoot(config, logger),
        DatabaseModule.forRoot({ migrations, migrateOnStart: false }),
        RedisModule,
        EventsModule.forRoot(),
        DirectoryModule,
        CommonModule.register(config, options.storage),
        SettingsModule,
        SignatoriesModule,
        AssetsModule,
        TemplatesModule,
        IssuanceModule,
        EligibilityModule,
        DefinitionsModule,
        // Certificates register the learner `/certificates/me` routes before `/certificates/:id`.
        CertificatesModule,
        VerificationModule,
        JobsModule,
      ],
    };
  }
}
