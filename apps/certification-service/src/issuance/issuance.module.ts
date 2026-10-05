import { Module } from '@nestjs/common';
import { IssuanceService } from './issuance.service.js';
import { PdfService } from './pdf.service.js';

@Module({
  providers: [IssuanceService, PdfService],
  exports: [IssuanceService, PdfService],
})
export class IssuanceModule {}
