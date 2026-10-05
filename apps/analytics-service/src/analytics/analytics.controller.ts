import { Get, HttpCode, Patch, Post } from '@nestjs/common';
import type { z } from 'zod';
import type { Principal } from '@a5/auth';
import { analytics } from '@a5/contracts';
import {
  ApiController,
  CurrentPrincipal,
  ForbiddenError,
  RequireAnyPermission,
  RequirePermissions,
  ZBody,
  ZParam,
  ZQuery,
  ZResponse,
} from '@a5/nest-kit';
import { scopeCovers } from '@a5/permissions';
import { AnalyticsScope } from '../common/scope.service.js';
import { SettingsService } from '../common/settings.service.js';
import { addDays, localDate } from '../rollups/rollup-builder.js';
import { RollupService } from '../rollups/rollup.service.js';
import { DashboardService } from './dashboard.service.js';

type DashboardQuery = z.infer<typeof analytics.dashboardQuerySchema>;

@ApiController('analytics')
export class AnalyticsController {
  constructor(
    private readonly dashboards: DashboardService,
    private readonly settings: SettingsService,
    private readonly rollups: RollupService,
    private readonly scope: AnalyticsScope,
  ) {}

  @Get('dashboards/team')
  @RequirePermissions('analytics.view')
  @ZResponse(analytics.teamDashboardSchema)
  team(@CurrentPrincipal() p: Principal, @ZQuery(analytics.dashboardQuerySchema) query: DashboardQuery) {
    return this.dashboards.team(p, query);
  }

  @Get('dashboards/company')
  @RequirePermissions('analytics.view')
  @ZResponse(analytics.companyDashboardSchema)
  company(@CurrentPrincipal() p: Principal, @ZQuery(analytics.dashboardQuerySchema) query: DashboardQuery) {
    return this.dashboards.company(p, query);
  }

  @Get('trends/:metric')
  @RequirePermissions('analytics.view')
  @ZResponse(analytics.trendResponseSchema)
  trend(
    @CurrentPrincipal() p: Principal,
    @ZParam('metric', analytics.trendMetricSchema) metric: analytics.TrendMetric,
    @ZQuery(analytics.dashboardQuerySchema) query: DashboardQuery,
  ) {
    return this.dashboards.trend(p, metric, query);
  }

  @Get('me/summary')
  @RequirePermissions('training.participate')
  @ZResponse(analytics.learnerSummarySchema)
  mySummary(@CurrentPrincipal() p: Principal, @ZQuery(analytics.learnerSummaryQuerySchema) query: { programId?: string }) {
    return this.dashboards.mySummary(p, query.programId);
  }

  @Get('learners/:userId/summary')
  @RequirePermissions('analytics.view')
  @ZResponse(analytics.learnerSummarySchema)
  learnerSummary(
    @CurrentPrincipal() p: Principal,
    @ZParam('userId') userId: string,
    @ZQuery(analytics.learnerSummaryQuerySchema) query: { programId?: string },
  ) {
    return this.dashboards.learnerSummary(p, userId, query.programId);
  }

  @Get('settings')
  @RequireAnyPermission('analytics.view', 'settings.view')
  @ZResponse(analytics.analyticsSettingsResponseSchema)
  getSettings(@CurrentPrincipal() p: Principal) {
    return this.settings.get(p.organizationId);
  }

  @Patch('settings')
  @RequirePermissions('settings.update')
  @ZResponse(analytics.analyticsSettingsResponseSchema)
  updateSettings(
    @CurrentPrincipal() p: Principal,
    @ZBody(analytics.updateAnalyticsSettingsRequestSchema) body: Partial<analytics.AnalyticsSettings>,
  ) {
    return this.settings.update(p, body);
  }

  @Post('rollups/refresh')
  @HttpCode(202)
  @RequirePermissions('analytics.view')
  @ZResponse(analytics.refreshRollupsResponseSchema, 'Queued')
  async refreshRollups(
    @CurrentPrincipal() p: Principal,
    @ZBody(analytics.refreshRollupsRequestSchema) body: { from?: string; to?: string },
  ) {
    const scope = p.scopeOf('analytics.view');
    if (!scope || !scopeCovers(scope, 'organization')) {
      throw new ForbiddenError('Rebuilding trend data needs organization-wide analytics access.');
    }
    const to = body.to ?? localDate(this.scope.now(), this.scope.timezone);
    const from = body.from ?? addDays(to, -89);
    const jobId = await this.rollups.enqueueRefresh(p.organizationId, from, to);
    return { jobId, from, to, status: 'queued' as const };
  }
}
