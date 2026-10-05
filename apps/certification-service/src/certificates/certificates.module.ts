import { Module } from '@nestjs/common';
import { EligibilityModule } from '../eligibility/eligibility.module.js';
import { IssuanceModule } from '../issuance/issuance.module.js';
import { ApprovalsService } from './approvals.service.js';
import { CertificatesController, LearnerCertificatesController } from './certificates.controller.js';
import { CertificatesService } from './certificates.service.js';
import { LearnerService } from './learner.service.js';
import { ReportsService } from './reports.service.js';

@Module({
  imports: [EligibilityModule, IssuanceModule],
  // The learner controller must register first so `/certificates/me` is not matched by `/certificates/:id`.
  controllers: [LearnerCertificatesController, CertificatesController],
  providers: [CertificatesService, ApprovalsService, ReportsService, LearnerService],
  exports: [CertificatesService],
})
export class CertificatesModule {}
