import { Injectable } from '@nestjs/common';
import type { Principal } from '@a5/auth';
import type { certification } from '@a5/contracts';
import { InjectDb } from '@a5/nest-kit';
import type { Db } from '../database/index.js';
import { addDays } from '../common/dates.js';
import { EligibilityService } from '../eligibility/eligibility.service.js';
import { summaryDto, type SummaryRow } from './dto.js';
import { certificateSummaryQuery } from './queries.js';

type MyState = 'active' | 'expiring' | 'renewal_required' | 'pending_approval' | 'eligible' | 'in_progress' | 'expired' | 'revoked';

/** "My certifications": every certification the person holds or is working toward. */
@Injectable()
export class LearnerService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly eligibility: EligibilityService,
  ) {}

  async mine(p: Principal): Promise<certification.MyCertifications> {
    const now = new Date();
    const [certs, candidates, renewals, definitions, enrolled] = await Promise.all([
      certificateSummaryQuery(this.db).where('c.user_id', '=', p.userId).where('c.organization_id', '=', p.organizationId).orderBy('c.issued_at', 'desc').execute(),
      this.db.selectFrom('certification_candidates').selectAll().where('user_id', '=', p.userId).execute(),
      this.db
        .selectFrom('certificate_renewals')
        .selectAll()
        .where('user_id', '=', p.userId)
        .where('status', 'in', ['open', 'lapsed'])
        .execute(),
      this.db.selectFrom('certification_definitions').selectAll().where('organization_id', '=', p.organizationId).where('status', '<>', 'draft').execute(),
      this.db
        .selectFrom('learner_program_status')
        .select('program_id')
        .where('user_id', '=', p.userId)
        .where('status', '<>', 'withdrawn')
        .execute(),
    ]);
    const enrolledPrograms = new Set(enrolled.map((e) => e.program_id));
    const programsByDefinition = await this.programsByDefinition(definitions.map((d) => d.id));
    const certificates = (certs as SummaryRow[]).map((c) => summaryDto(c, now));

    const items: certification.MyCertifications['items'] = [];
    for (const d of definitions) {
      const mine = (certs as SummaryRow[]).filter((c) => c.definition_id === d.id);
      const latest = mine.find((c) => c.status !== 'superseded') ?? mine[0];
      const candidate = candidates.find((c) => c.definition_id === d.id);
      const involved =
        Boolean(latest) ||
        Boolean(candidate) ||
        (programsByDefinition.get(d.id) ?? []).some((pid) => enrolledPrograms.has(pid));
      if (!involved) continue;
      if (d.status === 'archived' && !latest) continue;

      const renewal = latest ? renewals.find((r) => r.certificate_id === latest.id) : undefined;
      const state = this.stateOf(latest, candidate?.status, Boolean(renewal), d.renewal_policy.reminderOffsets, now);
      const needsProgress = state === 'in_progress' || state === 'eligible' || state === 'pending_approval' || state === 'renewal_required' || (state === 'expired' && Boolean(renewal));
      const progress = needsProgress && d.status === 'active' ? await this.eligibility.progress(d.id, p.userId, now) : null;
      items.push({
        definition: { id: d.id, name: d.name, code: d.code, publicDescription: d.public_description, badge: d.badge },
        state,
        certificate: latest ? summaryDto(latest, now) : null,
        progress,
        renewal: renewal
          ? {
              id: renewal.id,
              certificateId: renewal.certificate_id,
              status: renewal.status,
              windowOpenedAt: renewal.window_opened_at.toISOString(),
              dueAt: renewal.due_at?.toISOString() ?? null,
              completedAt: renewal.completed_at?.toISOString() ?? null,
              newCertificateId: renewal.new_certificate_id,
            }
          : null,
        verificationUrl: latest && d.public_verification_enabled && latest.status === 'issued' ? await this.verificationUrl(latest.id) : null,
      });
    }
    return { items, certificates };
  }

  private async programsByDefinition(ids: string[]) {
    const map = new Map<string, string[]>();
    if (ids.length === 0) return map;
    const rows = await this.db.selectFrom('certification_programs').select(['definition_id', 'program_id']).where('definition_id', 'in', ids).execute();
    for (const r of rows) map.set(r.definition_id, [...(map.get(r.definition_id) ?? []), r.program_id]);
    return map;
  }

  private async verificationUrl(certificateId: string): Promise<string | null> {
    const s = await this.db.selectFrom('certificate_snapshots').select('data').where('certificate_id', '=', certificateId).executeTakeFirst();
    return s?.data.verificationUrl ?? null;
  }

  private stateOf(
    latest: SummaryRow | undefined,
    candidateStatus: certification.CandidateStatus | undefined,
    renewalOpen: boolean,
    reminderOffsets: number[],
    now: Date,
  ): MyState {
    if (latest) {
      const expired = latest.status === 'expired' || (latest.status === 'issued' && latest.expires_at !== null && latest.expires_at <= now);
      if (expired) return 'expired';
      if (latest.status === 'revoked') return 'revoked';
      if (latest.status === 'issued') {
        if (renewalOpen) return 'renewal_required';
        const horizon = Math.max(0, ...reminderOffsets);
        if (latest.expires_at && horizon > 0 && latest.expires_at <= addDays(now, horizon)) return 'expiring';
        return 'active';
      }
    }
    if (candidateStatus === 'pending_approval') return 'pending_approval';
    if (candidateStatus === 'eligible' || candidateStatus === 'approved') return 'eligible';
    return 'in_progress';
  }
}
