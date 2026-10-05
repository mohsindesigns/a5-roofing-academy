import { Module } from '@nestjs/common';
import { RollupService } from './rollup.service.js';

@Module({
  providers: [RollupService],
  exports: [RollupService],
})
export class RollupsModule {}
