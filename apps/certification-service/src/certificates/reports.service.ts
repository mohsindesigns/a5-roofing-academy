import { Inject, Injectable } from '@nestjs/common';
import type { Principal } from '@a5/auth';
import type { certification } from '@a5/contracts';
import { likePattern, paginate, sql, type Page, type SqlBool } from '@a5/database';
import { userScopeCondition } from '@a5/directory';
import { InjectDb } from '@a5/nest-kit';
import { CERTIFICATION_CONFIG, type CertificationConfig } from '../config.js';
import type { Db } from '../database/index.js';
import { addDays } from '../common/dates.js';
import { loadSettings } from '../common/settings.js';
import { summaryDto, type SummaryRow } from './dto.js';
import { certificateSummaryQuery } from './queries.js';

const TEAM_FILTERS: Record<certification.TeamFilter, string> = {
  certified: `t.state in ('certified', 'expiring', 'renewal_required')`,
  not_certified: `t.state in ('in_progress', 'eligible', 'pending_approval', 'expired', 'revoked')`,
  eligible: `t.state = 'eligible'`,
  pending_approval: `t.state = 'pending_approval'`,
  expiring: `t.cert_status = 'issued' and t.expires_at is not null and t.expires_at > now() and t.expires_at <= t.expiring_cutoff`,
  expired: `t.state = 'expired'`,
  revoked: `t.state = 'revoked'`,
};

interface TeamRow {
  user_id: string;
  display_name: string;
  employee_id: string | null;
  job_title: string | null;
  definition_id: string;
  definition_name: string;
  definition_code: string;
  candidate_status: certification.CandidateStatus | null;
  met_count: number;
  total_count: number;
  cert_id: string | null;
  certificate_number: string | null;
  cert_status: certification.CertificateStatus | null;
  issued_at: Date | null;
  expires_at: Date | null;
  state: certification.TeamState;
  total: number;
}

/** Read models for managers and the admin center: team status, dashboard, queues. */
@Injectable()
export class ReportsService {
  constructor(
    @InjectDb() private readonly db: Db,
    @Inject(CERTIFICATION_CONFIG) private readonly config: CertificationConfig,
  ) {}

  /**
   * One row per (person in scope, active certification) the person is involved in: certified,
   * expiring, expired, revoked, pending approval, eligible or still working toward it.
   */
  async teamStatus(
    p: Principal,
    f: { q?: string; definitionId?: string; teamId?: string; filter?: certification.TeamFilter; expiringWithinDays: number; page: number; pageSize: number },
  ): Promise<Page<certification.TeamStatusRow>> {
    const now = new Date();
    const cutoff = addDays(now, f.expiringWithinDays);
    const scope = userScopeCondition(p.scopeFilter('certificates.view'), { userColumn: 'u.id', orgColumn: 'u.organization_id' });
    const conditions = [sql<SqlBool>`u.organization_id = ${p.organizationId}`, sql<SqlBool>`d.organization_id = ${p.organizationId}`, scope];
    if (f.definitionId) conditions.push(sql<SqlBool>`d.id = ${f.definitionId}`);
    if (f.teamId) conditions.push(sql<SqlBool>`u.id in (select user_id from dir_user_teams where team_id = ${f.teamId})`);
    if (f.q) {
      const pattern = likePattern(f.q);
      conditions.push(sql<SqlBool>`(u.display_name ilike ${pattern} or u.employee_id ilike ${pattern})`);
    }
    const outer = f.filter ? sql`where ${sql.raw(TEAM_FILTERS[f.filter])}` : sql``;
    const offset = (f.page - 1) * f.pageSize;
    const result = await sql<TeamRow>`
      select t.*, count(*) over() as total from (
        select u.id as user_id, u.display_name, u.employee_id, u.job_title,
               d.id as definition_id, d.name as definition_name, d.code as definition_code,
               cand.status as candidate_status, coalesce(cand.met_count, 0) as met_count, coalesce(cand.total_count, 0) as total_count,
               cert.id as cert_id, cert.certificate_number, cert.status as cert_status, cert.issued_at, cert.expires_at,
               ${cutoff}::timestamptz as expiring_cutoff,
               case
                 when cert.id is not null and cert.status = 'issued' and (cert.expires_at is null or cert.expires_at > ${now}) then
                   case when r.id is not null then 'renewal_required'
                        when cert.expires_at is not null and cert.expires_at <= ${cutoff} then 'expiring'
                        else 'certified' end
                 when cert.id is not null and (cert.status = 'expired' or (cert.status = 'issued' and cert.expires_at <= ${now})) then 'expired'
                 when cert.id is not null and cert.status = 'revoked' then 'revoked'
                 when cand.status = 'pending_approval' then 'pending_approval'
                 when cand.status in ('eligible', 'approved') then 'eligible'
                 else 'in_progress'
               end as state
        from dir_users u
        cross join certification_definitions d
        left join certification_candidates cand on cand.definition_id = d.id and cand.user_id = u.id
        left join lateral (
          select ic.* from issued_certificates ic
          where ic.definition_id = d.id and ic.user_id = u.id and ic.status <> 'superseded'
          order by ic.issued_at desc limit 1
        ) cert on true
        left join certificate_renewals r on r.certificate_id = cert.id and r.status = 'open'
        where d.status = 'active'
          and ${sql.join(conditions, sql` and `)}
          and (cert.id is not null or cand.id is not null or exists (
            select 1 from certification_programs cp
            join learner_program_status s on s.program_id = cp.program_id and s.user_id = u.id and s.status <> 'withdrawn'
            where cp.definition_id = d.id))
          and (u.status = 'active' or cert.id is not null)
      ) t
      ${outer}
      order by t.display_name, t.definition_name, t.user_id
      limit ${f.pageSize} offset ${offset}
    `.execute(this.db);
    const total = result.rows.length ? Number(result.rows[0]!.total) : 0;
    return {
      items: result.rows.map((r) => ({
        user: { id: r.user_id, displayName: r.display_name, employeeId: r.employee_id, jobTitle: r.job_title },
        definition: { id: r.definition_id, name: r.definition_name, code: r.definition_code },
        state: r.state,
        candidateStatus: r.candidate_status,
        metCount: Number(r.met_count),
        totalCount: Number(r.total_count),
        certificate: r.cert_id
          ? { id: r.cert_id, certificateNumber: r.certificate_number!, status: r.cert_status!, issuedAt: new Date(r.issued_at!).toISOString(), expiresAt: r.expires_at ? new Date(r.expires_at).toISOString() : null }
          : null,
      })),
      page: f.page,
      pageSize: f.pageSize,
      total,
      pageCount: Math.max(1, Math.ceil(total / f.pageSize)),
    };
  }

  async dashboard(p: Principal): Promise<certification.Dashboard> {
    const now = new Date();
    const settings = await loadSettings(this.db, p.organizationId, this.config.publicAppUrl);
    const filter = p.scopeFilter('certificates.view');
    const certScope = userScopeCondition(filter, { userColumn: 'c.user_id', orgColumn: 'c.organization_id' });
    const [certs, approvals, eligible, revocations, renewals] = await Promise.all([
      this.db
        .selectFrom('issued_certificates as c')
        .select([
          sql<number>`count(*)`.as('issued'),
          sql<number>`count(*) filter (where c.status = 'issued' and (c.expires_at is null or c.expires_at > ${now}))`.as('active'),
          sql<number>`count(*) filter (where c.status = 'issued' and c.expires_at > ${now} and c.expires_at <= ${addDays(now, 30)})`.as('e30'),
          sql<number>`count(*) filter (where c.status = 'issued' and c.expires_at > ${now} and c.expires_at <= ${addDays(now, 60)})`.as('e60'),
          sql<number>`count(*) filter (where c.status = 'issued' and c.expires_at > ${now} and c.expires_at <= ${addDays(now, 90)})`.as('e90'),
          sql<number>`count(*) filter (where c.pdf_status = 'failed')`.as('pdf_failed'),
        ])
        .where('c.organization_id', '=', p.organizationId)
        .where(certScope)
        .executeTakeFirstOrThrow(),
      this.db
        .selectFrom('certificate_approvals as a')
        .select((eb) => eb.fn.countAll<number>().as('n'))
        .where('a.organization_id', '=', p.organizationId)
        .where('a.status', '=', 'pending')
        .where(userScopeCondition(filter, { userColumn: 'a.user_id', orgColumn: 'a.organization_id' }))
        .executeTakeFirstOrThrow(),
      this.db
        .selectFrom('certification_candidates as k')
        .innerJoin('certification_definitions as d', 'd.id', 'k.definition_id')
        .select((eb) => eb.fn.countAll<number>().as('n'))
        .where('k.organization_id', '=', p.organizationId)
        .where('d.status', '=', 'active')
        .where('k.status', 'in', ['eligible', 'approved'])
        .where(userScopeCondition(filter, { userColumn: 'k.user_id', orgColumn: 'k.organization_id' }))
        .executeTakeFirstOrThrow(),
      this.db
        .selectFrom('certificate_revocations as r')
        .innerJoin('issued_certificates as c', 'c.id', 'r.certificate_id')
        .select((eb) => eb.fn.countAll<number>().as('n'))
        .where('c.organization_id', '=', p.organizationId)
        .where(sql<SqlBool>`r.revoked_at >= (date_trunc('month', ${now}::timestamptz at time zone ${settings.timezone}) at time zone ${settings.timezone})`)
        .where(certScope)
        .executeTakeFirstOrThrow(),
      this.db
        .selectFrom('certificate_renewals as n')
        .innerJoin('issued_certificates as c', 'c.id', 'n.certificate_id')
        .select((eb) => eb.fn.countAll<number>().as('n'))
        .where('c.organization_id', '=', p.organizationId)
        .where('n.status', 'in', ['open', 'lapsed'])
        .where(certScope)
        .executeTakeFirstOrThrow(),
    ]);
    return {
      issued: Number(certs.issued),
      active: Number(certs.active),
      expiring: { within30: Number(certs.e30), within60: Number(certs.e60), within90: Number(certs.e90) },
      pendingApprovals: Number(approvals.n),
      eligible: Number(eligible.n),
      revokedThisMonth: Number(revocations.n),
      renewalsOpen: Number(renewals.n),
      pdfFailed: Number(certs.pdf_failed),
    };
  }

  /** People who met the requirements but have no certificate yet (eligibility queue). */
  async candidates(
    p: Principal,
    f: { q?: string; status?: certification.CandidateStatus[]; definitionId?: string; page: number; pageSize: number },
  ): Promise<Page<certification.Candidate>> {
    let q = this.db
      .selectFrom('certification_candidates as k')
      .innerJoin('certification_definitions as d', 'd.id', 'k.definition_id')
      .leftJoin('dir_users as u', 'u.id', 'k.user_id')
      .select([
        'k.id',
        'k.user_id',
        'k.status',
        'k.purpose',
        'k.met_count',
        'k.total_count',
        'k.eligible_at',
        'k.evaluated_at',
        'k.hold_reason',
        'k.issue_error',
        'd.id as definition_id',
        'd.name as definition_name',
        'd.code as definition_code',
        'u.display_name',
        'u.employee_id',
      ])
      .where('k.organization_id', '=', p.organizationId)
      .where('d.status', '=', 'active')
      .where('k.status', 'in', f.status?.length ? f.status : ['eligible', 'approved'])
      .where(userScopeCondition(p.scopeFilter('certificates.view'), { userColumn: 'k.user_id', orgColumn: 'k.organization_id' }));
    if (f.definitionId) q = q.where('k.definition_id', '=', f.definitionId);
    if (f.q) q = q.where((eb) => eb.or([eb('u.display_name', 'ilike', likePattern(f.q!)), eb('u.employee_id', 'ilike', likePattern(f.q!))]));
    const page = await paginate(q.orderBy('k.eligible_at').orderBy('k.id'), f);
    return {
      ...page,
      items: page.items.map((r) => ({
        id: r.id,
        user: { id: r.user_id, displayName: r.display_name ?? 'Unknown person', employeeId: r.employee_id },
        definition: { id: r.definition_id, name: r.definition_name, code: r.definition_code },
        status: r.status,
        purpose: r.purpose,
        metCount: r.met_count,
        totalCount: r.total_count,
        eligibleAt: r.eligible_at?.toISOString() ?? null,
        evaluatedAt: r.evaluated_at?.toISOString() ?? null,
        onHold: r.hold_reason !== null,
        holdReason: r.hold_reason,
        issueError: r.issue_error,
      })),
    };
  }

  async revocations(p: Principal, f: { q?: string; definitionId?: string; page: number; pageSize: number }) {
    let q = certificateSummaryQuery(this.db)
      .innerJoin('certificate_revocations as r', 'r.certificate_id', 'c.id')
      .select(['r.revoked_at as rev_at', 'r.reason as rev_reason', 'r.public_note as rev_note', 'r.revoked_by as rev_by', 'r.revoked_by_name as rev_by_name'])
      .where('c.organization_id', '=', p.organizationId)
      .where(userScopeCondition(p.scopeFilter('certificates.view'), { userColumn: 'c.user_id', orgColumn: 'c.organization_id' }));
    if (f.definitionId) q = q.where('c.definition_id', '=', f.definitionId);
    if (f.q) q = q.where((eb) => eb.or([eb('c.certificate_number', 'ilike', likePattern(f.q!)), eb(sql`s.data->'recipient'->>'legalName'`, 'ilike', likePattern(f.q!))]));
    const page = await paginate(q.orderBy('r.revoked_at', 'desc').orderBy('c.id'), f);
    const now = new Date();
    return {
      ...page,
      items: page.items.map((r) => ({
        certificate: summaryDto(r as unknown as SummaryRow, now),
        revokedAt: r.rev_at.toISOString(),
        reason: r.rev_reason,
        publicNote: r.rev_note,
        revokedBy: r.rev_by && r.rev_by_name ? { id: r.rev_by, displayName: r.rev_by_name } : null,
      })),
    };
  }

  async renewals(p: Principal, f: { q?: string; status?: Array<'open' | 'completed' | 'lapsed' | 'cancelled'>; definitionId?: string; page: number; pageSize: number }) {
    let q = certificateSummaryQuery(this.db)
      .innerJoin('certificate_renewals as n', 'n.certificate_id', 'c.id')
      .leftJoin('certification_candidates as k', (j) => j.onRef('k.renewal_id', '=', 'n.id'))
      .select([
        'n.id as renewal_id',
        'n.status as renewal_status',
        'n.window_opened_at',
        'n.due_at',
        'n.completed_at',
        'n.new_certificate_id',
        'k.status as cand_status',
        'k.met_count',
        'k.total_count',
      ])
      .where('c.organization_id', '=', p.organizationId)
      .where('n.status', 'in', f.status?.length ? f.status : ['open', 'lapsed'])
      .where(userScopeCondition(p.scopeFilter('certificates.view'), { userColumn: 'c.user_id', orgColumn: 'c.organization_id' }));
    if (f.definitionId) q = q.where('c.definition_id', '=', f.definitionId);
    if (f.q) q = q.where((eb) => eb.or([eb('c.certificate_number', 'ilike', likePattern(f.q!)), eb(sql`s.data->'recipient'->>'legalName'`, 'ilike', likePattern(f.q!))]));
    const page = await paginate(q.orderBy('n.due_at').orderBy('n.id'), f);
    const now = new Date();
    return {
      ...page,
      items: page.items.map((r) => ({
        id: r.renewal_id,
        certificateId: r.id,
        status: r.renewal_status,
        windowOpenedAt: r.window_opened_at.toISOString(),
        dueAt: r.due_at?.toISOString() ?? null,
        completedAt: r.completed_at?.toISOString() ?? null,
        newCertificateId: r.new_certificate_id,
        certificate: summaryDto(r as unknown as SummaryRow, now),
        progress: r.cand_status ? { status: r.cand_status, metCount: r.met_count ?? 0, totalCount: r.total_count ?? 0 } : null,
      })),
    };
  }
}
