import { Module } from '@nestjs/common';
import { IssuanceModule } from '../issuance/issuance.module.js';
import { EligibilityService } from './eligibility.service.js';
import { ProjectionsConsumer } from './projections.consumer.js';

@Module({
  imports: [IssuanceModule],
  providers: [EligibilityService, ProjectionsConsumer],
  exports: [EligibilityService, ProjectionsConsumer],
})
export class EligibilityModule {}
