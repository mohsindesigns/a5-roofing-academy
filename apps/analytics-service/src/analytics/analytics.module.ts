import { Module } from '@nestjs/common';
import { RollupsModule } from '../rollups/rollups.module.js';
import { AnalyticsController } from './analytics.controller.js';
import { DashboardService } from './dashboard.service.js';

@Module({
  imports: [RollupsModule],
  controllers: [AnalyticsController],
  providers: [DashboardService],
})
export class AnalyticsModule {}
