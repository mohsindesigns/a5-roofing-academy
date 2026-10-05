import { Inject, Injectable } from '@nestjs/common';
import type { certification } from '@a5/contracts';
import type { Selectable } from '@a5/database';
import { certificationEvents } from '@a5/events';
import { AppError, EventBus, InjectDb, LOGGER } from '@a5/nest-kit';
import { uuidv7, type Logger } from '@a5/observability';
import type { CandidateStatus, CertificationCandidatesTable, CertificationDefinitionsTable, Db, DbOrTrx, IssueMode } from '../database/index.js';
import { IssuanceService } from '../issuance/issuance.service.js';
import { computeEligibility, computeRenewalEligibility, type EligibilityOutcome } from './calculator.js';
import { loadFacts } from './facts.js';
import { assessmentProgramIds, loadRuleNames } from './names.js';

type Definition = Selectable<CertificationDefinitionsTable>;
type CandidateRow = Selectable<CertificationCandidatesTable>;
type Progress = certification.Progress;

export interface EvaluateOptions {
  /** A learner fact changed (reopens a rejected candidate when newer than the rejection). */
  learnerActivity?: boolean;
  factsChangedAt?: Date;
  now?: Date;
}

export function progressDto(c: CandidateRow): Progress {
  return {
    definitionId: c.definition_id,
    userId: c.user_id,
    status: c.status,
    purpose: c.purpose,
    metCount: c.met_count,
    totalCount: c.total_count,
    requirements: c.requirements,
    evaluatedAt: c.evaluated_at?.toISOString() ?? null,
    eligibleAt: c.eligible_at?.toISOString() ?? null,
    onHold: c.hold_reason !== null,
    holdReason: c.hold_reason,
  };
}

/**
 * The eligibility engine. Evaluates a certification's rule tree for one person from local fact
 * projections, stores the per-requirement breakdown on the candidate, emits `certificate.eligible`
 * once per cycle, requests approvals and triggers automatic issuance.
 */
@Injectable()
export class EligibilityService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly events: EventBus,
    private readonly issuance: IssuanceService,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  /** Evaluate (definition, user) pairs whose facts changed. Returns how many were processed. */
  async processDirty(filter: { userId?: string; definitionId?: string; limit?: number } = {}): Promise<number> {
    let q = this.db.selectFrom('eligibility_dirty').selectAll().orderBy('marked_at').limit(filter.limit ?? 200);
    if (filter.userId) q = q.where('user_id', '=', filter.userId);
    if (filter.definitionId) q = q.where('definition_id', '=', filter.definitionId);
    const rows = await q.execute();
    for (const row of rows) {
      try {
        await this.evaluate(row.definition_id, row.user_id, { learnerActivity: row.learner_activity, factsChangedAt: row.marked_at });
        await this.db
          .deleteFrom('eligibility_dirty')
          .where('definition_id', '=', row.definition_id)
          .where('user_id', '=', row.user_id)
          .where('marked_at', '=', row.marked_at)
          .execute();
      } catch (err) {
        this.logger.error({ err, definitionId: row.definition_id, userId: row.user_id }, 'eligibility evaluation failed; will retry');
      }
    }
    return rows.length;
  }

  private async definition(db: DbOrTrx, id: string): Promise<Definition | undefined> {
    return db.selectFrom('certification_definitions').selectAll().where('id', '=', id).executeTakeFirst();
  }

  /** Compute the breakdown for a candidate state without writing anything. */
  async compute(db: DbOrTrx, def: Definition, userId: string, candidate: CandidateRow | null, now: Date): Promise<EligibilityOutcome> {
    const purpose = candidate?.purpose ?? 'initial';
    const rule = purpose === 'renewal' ? def.renewal_policy.requirements : def.eligibility_rule;
    const renewal =
      purpose === 'renewal' && candidate?.renewal_id
        ? await db.selectFrom('certificate_renewals').select('window_opened_at').where('id', '=', candidate.renewal_id).executeTakeFirst()
        : null;
    const programIds = (await db.selectFrom('certification_programs').select('program_id').where('definition_id', '=', def.id).execute()).map((r) => r.program_id);
    const facts = await loadFacts(db, {
      userId,
      candidateId: candidate?.id ?? null,
      cycle: candidate?.cycle ?? 1,
      since: renewal?.window_opened_at ?? null,
      now,
      programIds,
      referencedProgramIds: assessmentProgramIds(rule),
    });
    const names = await loadRuleNames(db, [rule]);
    return purpose === 'renewal' ? computeRenewalEligibility(rule, facts, names) : computeEligibility(rule, facts, names);
  }

  /** Read-only progress for the progress API (live, not the stored breakdown). */
  async progress(definitionId: string, userId: string, now = new Date()): Promise<Progress | null> {
    const def = await this.definition(this.db, definitionId);
    if (!def) return null;
    const candidate = await this.db
      .selectFrom('certification_candidates')
      .selectAll()
      .where('definition_id', '=', definitionId)
      .where('user_id', '=', userId)
      .executeTakeFirst();
    const outcome = await this.compute(this.db, def, userId, candidate ?? null, now);
    return {
      definitionId,
      userId,
      status: candidate?.status ?? 'in_progress',
      purpose: candidate?.purpose ?? 'initial',
      metCount: outcome.metCount,
      totalCount: outcome.totalCount,
      requirements: outcome.requirements,
      evaluatedAt: now.toISOString(),
      eligibleAt: candidate?.eligible_at?.toISOString() ?? null,
      onHold: Boolean(candidate?.hold_reason),
      holdReason: candidate?.hold_reason ?? null,
    };
  }

  /**
   * Re-evaluate one (certification, person) pair and apply the state machine:
   * in_progress → eligible → pending_approval → approved → issued. Idempotent.
   */
  async evaluate(definitionId: string, userId: string, opts: EvaluateOptions = {}): Promise<Progress | null> {
    const now = opts.now ?? new Date();
    const def = await this.definition(this.db, definitionId);
    if (!def || def.status !== 'active') return null;
    const pending: { issue: { mode: IssueMode; renewalId: string | null } | null } = { issue: null };

    const candidate = await this.db.transaction().execute(async (trx) => {
      await trx
        .insertInto('certification_candidates')
        .values({
          id: uuidv7(),
          organization_id: def.organization_id,
          definition_id: def.id,
          user_id: userId,
          status: 'in_progress',
          purpose: 'initial',
          cycle: 1,
          renewal_id: null,
          requirements: [],
          met_count: 0,
          total_count: 0,
          auto_requirements_met: false,
          evaluated_at: null,
          eligible_at: null,
          eligible_cycle: null,
          rejected_at: null,
          hold_reason: null,
          held_at: null,
          issue_error: null,
          certificate_id: null,
        })
        .onConflict((oc) => oc.columns(['definition_id', 'user_id']).doNothing())
        .execute();
      let cand = await trx
        .selectFrom('certification_candidates')
        .selectAll()
        .where('definition_id', '=', def.id)
        .where('user_id', '=', userId)
        .forUpdate()
        .executeTakeFirstOrThrow();

      // An issued candidate stays issued until expiry, revocation or a renewal window starts a new cycle.
      if (cand.status === 'issued') return cand;

      if (cand.status === 'rejected' && opts.learnerActivity && cand.rejected_at && opts.factsChangedAt && opts.factsChangedAt > cand.rejected_at) {
        cand = await trx
          .updateTable('certification_candidates')
          .set((eb) => ({ status: 'in_progress', cycle: eb('cycle', '+', 1), rejected_at: null, eligible_at: null }))
          .where('id', '=', cand.id)
          .returningAll()
          .executeTakeFirstOrThrow();
      }

      const outcome = await this.compute(trx, def, userId, cand, now);
      const requiresApproval = def.approval_policy !== 'none';
      let status: CandidateStatus = cand.status;
      let eligibleCycle = cand.eligible_cycle;
      let eligibleAt = cand.eligible_at;

      if (cand.hold_reason) {
        status = outcome.autoSatisfied ? 'eligible' : 'in_progress';
      } else if (cand.status === 'rejected') {
        status = 'rejected';
      } else if (!outcome.autoSatisfied) {
        status = 'in_progress';
        eligibleAt = null;
        // Facts regressed (e.g. a score override): withdraw an open approval request.
        await trx
          .updateTable('certificate_approvals')
          .set({ status: 'cancelled', decided_at: now, comment: 'Requirements are no longer met.' })
          .where('candidate_id', '=', cand.id)
          .where('cycle', '=', cand.cycle)
          .where('status', '=', 'pending')
          .execute();
      } else {
        eligibleAt ??= now;
        if (cand.eligible_cycle !== cand.cycle) {
          eligibleCycle = cand.cycle;
          await this.events.emit(
            trx,
            certificationEvents.eligible,
            { candidateId: cand.id, definitionId: def.id, definitionName: def.name, userId, requiresApproval },
            { organizationId: def.organization_id, subject: { type: 'certification_candidate', id: cand.id } },
          );
        }
        if (requiresApproval && !outcome.satisfied) {
          status = 'pending_approval';
          await this.ensureApproval(trx, def, cand, now);
        } else {
          status = requiresApproval ? 'approved' : 'eligible';
          if (def.automatic_issuance) {
            pending.issue = { mode: cand.purpose === 'renewal' ? 'renewal' : requiresApproval ? 'approval' : 'automatic', renewalId: cand.renewal_id };
          }
        }
      }

      return trx
        .updateTable('certification_candidates')
        .set({
          status,
          requirements: outcome.requirements,
          met_count: outcome.metCount,
          total_count: outcome.totalCount,
          auto_requirements_met: outcome.autoSatisfied,
          evaluated_at: now,
          eligible_at: eligibleAt,
          eligible_cycle: eligibleCycle,
        })
        .where('id', '=', cand.id)
        .returningAll()
        .executeTakeFirstOrThrow();
    });

    if (pending.issue) return this.issueAutomatically(def, userId, pending.issue);
    return progressDto(candidate);
  }

  /** Approval request for the candidate's current cycle, created (or reopened) once. */
  private async ensureApproval(trx: DbOrTrx, def: Definition, cand: CandidateRow, now: Date): Promise<void> {
    const kind = def.approval_policy as 'manager' | 'trainer' | 'manual_review';
    const existing = await trx
      .selectFrom('certificate_approvals')
      .select(['id', 'status'])
      .where('candidate_id', '=', cand.id)
      .where('cycle', '=', cand.cycle)
      .executeTakeFirst();
    let approvalId: string | null = null;
    if (!existing) {
      approvalId = uuidv7();
      await trx
        .insertInto('certificate_approvals')
        .values({
          id: approvalId,
          organization_id: def.organization_id,
          candidate_id: cand.id,
          definition_id: def.id,
          user_id: cand.user_id,
          cycle: cand.cycle,
          kind,
          status: 'pending',
          requested_at: now,
          decided_at: null,
          decided_by: null,
          decided_by_name: null,
          comment: null,
        })
        .execute();
    } else if (existing.status === 'cancelled') {
      approvalId = existing.id;
      await trx
        .updateTable('certificate_approvals')
        .set({ status: 'pending', requested_at: now, decided_at: null, decided_by: null, decided_by_name: null, comment: null, kind })
        .where('id', '=', existing.id)
        .execute();
    }
    if (approvalId) {
      await this.events.emit(
        trx,
        certificationEvents.approvalRequested,
        { approvalId, definitionId: def.id, definitionName: def.name, userId: cand.user_id },
        { organizationId: def.organization_id, subject: { type: 'certificate_approval', id: approvalId } },
      );
    }
  }

  private async issueAutomatically(def: Definition, userId: string, issue: { mode: IssueMode; renewalId: string | null }): Promise<Progress | null> {
    try {
      await this.issuance.issue({
        definitionId: def.id,
        userId,
        mode: issue.mode,
        renewalId: issue.renewalId,
        actor: { userId: null, displayName: null },
      });
    } catch (err) {
      if (!(err instanceof AppError && err.code === 'ALREADY_CERTIFIED')) {
        const message = err instanceof AppError ? err.message : 'Automatic issuance failed. Retry from the eligibility queue.';
        this.logger.warn({ err, definitionId: def.id, userId }, 'automatic issuance failed');
        await this.db
          .updateTable('certification_candidates')
          .set({ issue_error: message })
          .where('definition_id', '=', def.id)
          .where('user_id', '=', userId)
          .where('status', '<>', 'issued')
          .execute();
      }
    }
    const row = await this.db
      .selectFrom('certification_candidates')
      .selectAll()
      .where('definition_id', '=', def.id)
      .where('user_id', '=', userId)
      .executeTakeFirst();
    return row ? progressDto(row) : null;
  }
}
