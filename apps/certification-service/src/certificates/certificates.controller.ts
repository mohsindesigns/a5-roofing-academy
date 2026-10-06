import { Get, HttpCode, Post } from '@nestjs/common';
import { z } from 'zod';
import type { Principal } from '@a5/auth';
import { certification } from '@a5/contracts';
import {
  ApiController,
  CurrentPrincipal,
  RequirePermissions,
  ZBody,
  ZParam,
  ZQuery,
  ZResponse,
} from '@a5/nest-kit';
import { ApprovalsService } from './approvals.service.js';
import { CertificatesService } from './certificates.service.js';
import { LearnerService } from './learner.service.js';
import { ReportsService } from './reports.service.js';

const c = certification;
type Q<S extends z.ZodType> = z.infer<S>;

/** Learner self-service. Registered before the admin routes so `/certificates/me` is never read as an id. */
@ApiController('certificates/me', 'certificates')
export class LearnerCertificatesController {
  constructor(
    private readonly learner: LearnerService,
    private readonly certificates: CertificatesService,
  ) {}

  @Get()
  @RequirePermissions('certificates.view_own')
  @ZResponse(c.myCertificationsSchema)
  mine(@CurrentPrincipal() p: Principal) {
    return this.learner.mine(p);
  }

  @Get(':id')
  @RequirePermissions('certificates.view_own')
  @ZResponse(c.ownCertificateDetailSchema)
  detail(@CurrentPrincipal() p: Principal, @ZParam('id') id: string) {
    return this.certificates.ownDetail(p, id);
  }

  @Post(':id/download')
  @HttpCode(200)
  @RequirePermissions('certificates.view_own')
  @ZResponse(c.downloadLinkSchema)
  download(@CurrentPrincipal() p: Principal, @ZParam('id') id: string) {
    return this.certificates.download(p, id, 'owner');
  }
}

/** Manager and admin-center APIs. Static routes come first; `:id` routes last. */
@ApiController('certificates')
export class CertificatesController {
  constructor(
    private readonly certificates: CertificatesService,
    private readonly approvals: ApprovalsService,
    private readonly reports: ReportsService,
  ) {}

  @Get('dashboard')
  @RequirePermissions('certificates.view')
  @ZResponse(c.dashboardSchema)
  dashboard(@CurrentPrincipal() p: Principal) {
    return this.reports.dashboard(p);
  }

  @Get('team')
  @RequirePermissions('certificates.view')
  @ZResponse(c.teamStatusPageSchema)
  team(
    @CurrentPrincipal() p: Principal,
    @ZQuery(c.teamStatusQuerySchema) q: Q<typeof c.teamStatusQuerySchema>,
  ) {
    return this.reports.teamStatus(p, q);
  }

  @Get('eligibility')
  @RequirePermissions('certificates.view')
  @ZResponse(c.candidatePageSchema)
  eligibility(
    @CurrentPrincipal() p: Principal,
    @ZQuery(c.listCandidatesQuerySchema) q: Q<typeof c.listCandidatesQuerySchema>,
  ) {
    return this.reports.candidates(p, q);
  }

  @Get('approvals')
  @RequirePermissions('certificate_approvals.decide')
  @ZResponse(c.approvalPageSchema)
  approvalQueue(
    @CurrentPrincipal() p: Principal,
    @ZQuery(c.listApprovalsQuerySchema) q: Q<typeof c.listApprovalsQuerySchema>,
  ) {
    return this.approvals.list(p, q);
  }

  @Get('approvals/:id')
  @RequirePermissions('certificate_approvals.decide')
  @ZResponse(c.approvalSchema)
  approval(@CurrentPrincipal() p: Principal, @ZParam('id') id: string) {
    return this.approvals.get(p, id);
  }

  @Post('approvals/:id/decision')
  @HttpCode(200)
  @RequirePermissions('certificate_approvals.decide')
  @ZResponse(c.approvalSchema)
  decide(
    @CurrentPrincipal() p: Principal,
    @ZParam('id') id: string,
    @ZBody(c.decideApprovalRequestSchema) body: Q<typeof c.decideApprovalRequestSchema>,
  ) {
    return this.approvals.decide(p, id, body);
  }

  @Get('revocations')
  @RequirePermissions('certificates.view')
  @ZResponse(c.revocationPageSchema)
  revocations(
    @CurrentPrincipal() p: Principal,
    @ZQuery(c.listRevocationsQuerySchema) q: Q<typeof c.listRevocationsQuerySchema>,
  ) {
    return this.reports.revocations(p, q);
  }

  @Get('renewals')
  @RequirePermissions('certificates.view')
  @ZResponse(c.renewalPageSchema)
  renewals(
    @CurrentPrincipal() p: Principal,
    @ZQuery(c.listRenewalsQuerySchema) q: Q<typeof c.listRenewalsQuerySchema>,
  ) {
    return this.reports.renewals(p, q);
  }

  @Get()
  @RequirePermissions('certificates.view')
  @ZResponse(c.certificateSummaryPageSchema)
  list(
    @CurrentPrincipal() p: Principal,
    @ZQuery(c.listCertificatesQuerySchema) q: Q<typeof c.listCertificatesQuerySchema>,
  ) {
    return this.certificates.list(p, q);
  }

  /** Manual issuance for an eligible person (or an audited administrator override). */
  @Post()
  @RequirePermissions('certificates.issue')
  @ZResponse(c.certificateDetailSchema)
  issue(
    @CurrentPrincipal() p: Principal,
    @ZBody(c.issueCertificateRequestSchema) body: Q<typeof c.issueCertificateRequestSchema>,
  ) {
    return this.certificates.issueManually(p, body);
  }

  @Get(':id')
  @RequirePermissions('certificates.view')
  @ZResponse(c.certificateDetailSchema)
  detail(@CurrentPrincipal() p: Principal, @ZParam('id') id: string) {
    return this.certificates.detail(p, id);
  }

  @Get(':id/events')
  @RequirePermissions('certificates.view')
  @ZResponse(z.object({ items: z.array(c.certificateEventSchema) }))
  events(@CurrentPrincipal() p: Principal, @ZParam('id') id: string) {
    return this.certificates.timeline(p, id);
  }

  @Post(':id/download')
  @HttpCode(200)
  @RequirePermissions('certificates.view')
  @ZResponse(c.downloadLinkSchema)
  download(@CurrentPrincipal() p: Principal, @ZParam('id') id: string) {
    return this.certificates.download(p, id, 'admin');
  }

  @Post(':id/reissue')
  @RequirePermissions('certificates.reissue')
  @ZResponse(c.certificateDetailSchema)
  reissue(
    @CurrentPrincipal() p: Principal,
    @ZParam('id') id: string,
    @ZBody(c.reissueCertificateRequestSchema) body: Q<typeof c.reissueCertificateRequestSchema>,
  ) {
    return this.certificates.reissue(p, id, body);
  }

  @Post(':id/revoke')
  @HttpCode(200)
  @RequirePermissions('certificates.revoke')
  @ZResponse(c.certificateDetailSchema)
  revoke(
    @CurrentPrincipal() p: Principal,
    @ZParam('id') id: string,
    @ZBody(c.revokeCertificateRequestSchema) body: Q<typeof c.revokeCertificateRequestSchema>,
  ) {
    return this.certificates.revoke(p, id, body);
  }

  @Post(':id/pdf/retry')
  @HttpCode(200)
  @RequirePermissions('certificates.reissue')
  @ZResponse(c.certificateDetailSchema)
  retryPdf(@CurrentPrincipal() p: Principal, @ZParam('id') id: string) {
    return this.certificates.retryPdf(p, id);
  }
}
