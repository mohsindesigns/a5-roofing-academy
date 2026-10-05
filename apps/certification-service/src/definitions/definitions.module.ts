import { Module } from '@nestjs/common';
import { EligibilityModule } from '../eligibility/eligibility.module.js';
import { DefinitionsController } from './definitions.controller.js';
import { DefinitionsService } from './definitions.service.js';

@Module({
  imports: [EligibilityModule],
  controllers: [DefinitionsController],
  providers: [DefinitionsService],
  exports: [DefinitionsService],
})
export class DefinitionsModule {}
