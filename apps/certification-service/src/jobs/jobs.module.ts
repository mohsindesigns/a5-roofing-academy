import { Module } from '@nestjs/common';
import { EligibilityModule } from '../eligibility/eligibility.module.js';
import { IssuanceModule } from '../issuance/issuance.module.js';
import { JobsService } from './jobs.service.js';
import { LifecycleService } from './lifecycle.service.js';

@Module({
  imports: [EligibilityModule, IssuanceModule],
  providers: [JobsService, LifecycleService],
  exports: [JobsService, LifecycleService],
})
export class JobsModule {}
