import { Module } from '@nestjs/common';
import { ExportsService } from './exports.service.js';
import {
  ReportExportsController,
  ReportFilesController,
  ReportsController,
} from './reports.controller.js';
import { ReportsService } from './reports.service.js';

@Module({
  // Specific prefixes first so `/reports/exports` and `/reports/files` never match `/reports/:report`.
  controllers: [ReportFilesController, ReportExportsController, ReportsController],
  providers: [ReportsService, ExportsService],
  exports: [ReportsService, ExportsService],
})
export class ReportsModule {}
