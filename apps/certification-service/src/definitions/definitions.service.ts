import { Inject, Injectable } from '@nestjs/common';
import type { Principal } from '@a5/auth';
import { certification } from '@a5/contracts';
import { isUniqueViolation, likePattern, paginate, sql, type Page, type Selectable } from '@a5/database';
import { ConflictError, EventBus, InjectDb, NotFoundError, PreconditionError, ValidationError } from '@a5/nest-kit';
import { uuidv7 } from '@a5/observability';
import { leaves, type Rule } from '@a5/rules';
import { CERTIFICATION_CONFIG, type CertificationConfig } from '../config.js';
import type { CertificationDefinitionsTable, Db, DbOrTrx, RenewalPolicyColumn, Trx } from '../database/index.js';
import { AccessService } from '../common/access.js';
import { assetsByIds, currentSignatures, currentStampImages, inEffect } from '../common/artwork-repo.js';
import { calendarDate } from '../common/dates.js';
import { loadSettings, organizationCode } from '../common/settings.js';
import { personRef } from '../common/timeline.js';
import { describeRequirements, isEmptyRule, normalizeApprovalRule, unsupportedLeafTypes } from '../eligibility/calculator.js';
import { markDefinitionsDirty } from '../eligibility/dirty.js';
import { EligibilityService } from '../eligibility/eligibility.service.js';
import { loadRuleNames } from '../eligibility/names.js';
import { signatureSlotOf } from '../rendering/layout.js';
import { missingCustomVariables } from '../templates/templates.service.js';

type Definition = Selectable<CertificationDefinitionsTable>;
type CreateInput = certification.CreateCertificationRequest;
type UpdateInput = certification.UpdateCertificationRequest;

interface DefinitionState {
  name: string;
  code: string;
  publicDescription: string | null;
  programIds: string[];
  validity: certification.ValidityPolicy;
  renewal: RenewalPolicyColumn;
  eligibilityRule: Rule;
  approvalPolicy: certification.ApprovalPolicy;
  automaticIssuance: boolean;
  issuingOrganizationName: string;
  templateId: string | null;
  badge: certification.Badge;
  publicVerificationEnabled: boolean;
  numberPattern: string;
  signatories: Array<{ slot: 1 | 2; signatoryId: string }>;
  stampId: string | null;
  customVariables: certification.CustomVariable[];
}

@Injectable()
export class DefinitionsService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly events: EventBus,
    private readonly eligibility: EligibilityService,
    private readonly access: AccessService,
    @Inject(CERTIFICATION_CONFIG) private readonly config: CertificationConfig,
  ) {}

  async list(p: Principal, f: { q?: string; status?: Array<'draft' | 'active' | 'archived'>; page: number; pageSize: number }): Promise<Page<certification.CertificationSummary>> {
    let q = this.db.selectFrom('certification_definitions').selectAll().where('organization_id', '=', p.organizationId);
    if (f.q) q = q.where((eb) => eb.or([eb('name', 'ilike', likePattern(f.q!)), eb('code', 'ilike', likePattern(f.q!))]));
    if (f.status?.length) q = q.where('status', 'in', f.status);
    const page = await paginate(q.orderBy('name').orderBy('id'), f);
    const extras = await this.summaryExtras(page.items.map((d) => d.id));
    return { ...page, items: page.items.map((d) => this.summary(d, extras)) };
  }

  private async summaryExtras(ids: string[]) {
    if (ids.length === 0) return { programs: new Map<string, string[]>(), counts: new Map<string, { active: number; inProgress: number; pendingApproval: number; eligible: number }>() };
    const [programs, candidates, active] = await Promise.all([
      this.db.selectFrom('certification_programs').select(['definition_id', 'program_id']).where('definition_id', 'in', ids).execute(),
      this.db
        .selectFrom('certification_candidates')
        .select([
          'definition_id',
          sql<number>`count(*) filter (where status = 'in_progress')`.as('in_progress'),
          sql<number>`count(*) filter (where status = 'pending_approval')`.as('pending'),
          sql<number>`count(*) filter (where status in ('eligible', 'approved'))`.as('eligible'),
        ])
        .where('definition_id', 'in', ids)
        .groupBy('definition_id')
        .execute(),
      this.db
        .selectFrom('issued_certificates')
        .select(['definition_id', (eb) => eb.fn.countAll<number>().as('n')])
        .where('definition_id', 'in', ids)
        .where('status', '=', 'issued')
        .groupBy('definition_id')
        .execute(),
    ]);
    const programMap = new Map<string, string[]>();
    for (const r of programs) programMap.set(r.definition_id, [...(programMap.get(r.definition_id) ?? []), r.program_id]);
    const counts = new Map(
      ids.map((id) => {
        const c = candidates.find((x) => x.definition_id === id);
        return [
          id,
          {
            active: Number(active.find((a) => a.definition_id === id)?.n ?? 0),
            inProgress: Number(c?.in_progress ?? 0),
            pendingApproval: Number(c?.pending ?? 0),
            eligible: Number(c?.eligible ?? 0),
          },
        ] as const;
      }),
    );
    return { programs: programMap, counts };
  }

  private summary(d: Definition, extras: Awaited<ReturnType<DefinitionsService['summaryExtras']>>): certification.CertificationSummary {
    const rule = d.eligibility_rule;
    return {
      id: d.id,
      name: d.name,
      code: d.code,
      status: d.status,
      publicDescription: d.public_description,
      approvalPolicy: d.approval_policy,
      automaticIssuance: d.automatic_issuance,
      validity: d.validity_policy,
      templateId: d.template_id,
      programIds: extras.programs.get(d.id) ?? [],
      badge: d.badge,
      requirementCount: isEmptyRule(rule) ? 0 : rule.type === 'all' ? rule.rules.length : 1,
      counts: extras.counts.get(d.id) ?? { active: 0, inProgress: 0, pendingApproval: 0, eligible: 0 },
      updatedAt: d.updated_at.toISOString(),
    };
  }

  async load(db: DbOrTrx, p: Principal, id: string, forUpdate = false): Promise<Definition> {
    let q = db.selectFrom('certification_definitions').selectAll().where('id', '=', id).where('organization_id', '=', p.organizationId);
    if (forUpdate) q = q.forUpdate();
    const row = await q.executeTakeFirst();
    if (!row) throw new NotFoundError('Certification');
    return row;
  }

  async get(p: Principal, id: string): Promise<certification.CertificationDetail> {
    const d = await this.load(this.db, p, id);
    const extras = await this.summaryExtras([id]);
    const [names, template, slots, stamp, programs, sequence, settings] = await Promise.all([
      loadRuleNames(this.db, [d.eligibility_rule, d.renewal_policy.requirements]),
      d.template_id
        ? this.db.selectFrom('certificate_templates').select(['id', 'name', 'current_version']).where('id', '=', d.template_id).executeTakeFirst()
        : Promise.resolve(undefined),
      this.db
        .selectFrom('certification_signatory_slots as s')
        .innerJoin('signatories as g', 'g.id', 's.signatory_id')
        .select(['s.slot', 'g.id', 'g.name', 'g.title', 'g.active'])
        .where('s.definition_id', '=', id)
        .orderBy('s.slot')
        .execute(),
      d.stamp_id ? this.db.selectFrom('stamps').select(['id', 'name', 'active']).where('id', '=', d.stamp_id).executeTakeFirst() : Promise.resolve(undefined),
      this.db
        .selectFrom('certification_programs as cp')
        .leftJoin('program_catalog as pc', 'pc.program_id', 'cp.program_id')
        .select(['cp.program_id', 'pc.title'])
        .where('cp.definition_id', '=', id)
        .execute(),
      this.db.selectFrom('certificate_number_sequences').select('last_value').where('definition_id', '=', id).executeTakeFirst(),
      loadSettings(this.db, p.organizationId, this.config.publicAppUrl),
    ]);
    return {
      ...this.summary(d, extras),
      renewal: d.renewal_policy,
      eligibilityRule: d.eligibility_rule,
      requirements: describeRequirements(d.eligibility_rule, names),
      renewalRequirements: describeRequirements(d.renewal_policy.requirements, names),
      issuingOrganizationName: d.issuing_organization_name,
      publicVerificationEnabled: d.public_verification_enabled,
      numberPattern: d.number_pattern,
      numberPreview: certification.formatCertificateNumber(d.number_pattern, {
        org: organizationCode(settings, d.issuing_organization_name),
        code: d.code,
        issuedAt: new Date(),
        seq: Number(sequence?.last_value ?? 0) + 1,
      }),
      template: template ? { id: template.id, name: template.name, currentVersion: template.current_version } : null,
      signatories: slots.map((s) => ({ slot: s.slot, id: s.id, name: s.name, title: s.title, active: s.active })),
      stamp: stamp ? { id: stamp.id, name: stamp.name, active: stamp.active } : null,
      customVariables: d.custom_variables,
      programs: programs.map((r) => ({ id: r.program_id, title: r.title })),
      revision: d.revision,
      activatedAt: d.activated_at?.toISOString() ?? null,
      archivedAt: d.archived_at?.toISOString() ?? null,
      createdAt: d.created_at.toISOString(),
      createdBy: personRef(d.created_by, d.created_by_name),
      updatedBy: personRef(d.updated_by, d.updated_by_name),
    };
  }

  private async stateOf(d: Definition): Promise<DefinitionState> {
    const [programs, slots] = await Promise.all([
      this.db.selectFrom('certification_programs').select('program_id').where('definition_id', '=', d.id).execute(),
      this.db.selectFrom('certification_signatory_slots').select(['slot', 'signatory_id']).where('definition_id', '=', d.id).orderBy('slot').execute(),
    ]);
    return {
      name: d.name,
      code: d.code,
      publicDescription: d.public_description,
      programIds: programs.map((r) => r.program_id),
      validity: d.validity_policy,
      renewal: d.renewal_policy,
      eligibilityRule: d.eligibility_rule,
      approvalPolicy: d.approval_policy,
      automaticIssuance: d.automatic_issuance,
      issuingOrganizationName: d.issuing_organization_name,
      templateId: d.template_id,
      badge: d.badge,
      publicVerificationEnabled: d.public_verification_enabled,
      numberPattern: d.number_pattern,
      signatories: slots.map((s) => ({ slot: s.slot as 1 | 2, signatoryId: s.signatory_id })),
      stampId: d.stamp_id,
      customVariables: d.custom_variables,
    };
  }

  /**
   * Validate references and policies. Normalizes approval requirements into both rule trees.
   * With `activation`, also checks everything issuance needs (non-empty rule, template, artwork).
   */
  private async validate(organizationId: string, definitionId: string | null, state: DefinitionState, activation: boolean): Promise<DefinitionState> {
    const fields: Array<{ path: string; message: string }> = [];
    for (const [path, rule] of [
      ['eligibilityRule', state.eligibilityRule],
      ['renewal.requirements', state.renewal.requirements],
    ] as const) {
      const unsupported = unsupportedLeafTypes(rule);
      if (unsupported.length) fields.push({ path, message: `Certifications cannot evaluate ${unsupported.join(', ')} requirements. Use lesson, phase or program requirements.` });
      if (leaves(rule).some((l) => l.type === 'certification_held' && l.certificationId === definitionId)) {
        fields.push({ path, message: 'A certification cannot require itself.' });
      }
    }
    const eligibility = normalizeApprovalRule(state.eligibilityRule, state.approvalPolicy);
    const renewalRule = normalizeApprovalRule(state.renewal.requirements, state.approvalPolicy);
    for (const message of eligibility.problems) fields.push({ path: 'eligibilityRule', message });
    for (const message of renewalRule.problems) fields.push({ path: 'renewal.requirements', message });

    const today = calendarDate(new Date(), 'UTC');
    let design: certification.TemplateDesign | null = null;
    if (state.templateId) {
      const template = await this.db
        .selectFrom('certificate_templates as t')
        .innerJoin('certificate_template_versions as v', (j) => j.onRef('v.template_id', '=', 't.id').onRef('v.version', '=', 't.current_version'))
        .select(['t.status', 'v.design'])
        .where('t.id', '=', state.templateId)
        .where('t.organization_id', '=', organizationId)
        .executeTakeFirst();
      if (!template || template.status !== 'active') fields.push({ path: 'templateId', message: 'Choose an active certificate template.' });
      else design = template.design;
    }
    if (design) {
      const missing = missingCustomVariables(design, state.customVariables);
      if (missing.length) fields.push({ path: 'customVariables', message: `The template uses ${missing.map((m) => `{{${m}}}`).join(', ')}; define them as custom variables.` });
    }

    const signatoryRows = state.signatories.length
      ? await this.db
          .selectFrom('signatories')
          .select(['id', 'name', 'active', 'effective_from', 'effective_to'])
          .where('organization_id', '=', organizationId)
          .where('id', 'in', state.signatories.map((s) => s.signatoryId))
          .execute()
      : [];
    const restrictions = signatoryRows.length
      ? await this.db.selectFrom('signatory_certifications').select(['signatory_id', 'definition_id']).where('signatory_id', 'in', signatoryRows.map((s) => s.id)).execute()
      : [];
    for (const slot of state.signatories) {
      const row = signatoryRows.find((s) => s.id === slot.signatoryId);
      if (!row) {
        fields.push({ path: 'signatories', message: `Signatory ${slot.slot} does not exist.` });
        continue;
      }
      const allowed = restrictions.filter((r) => r.signatory_id === row.id);
      if (allowed.length && (!definitionId || !allowed.some((r) => r.definition_id === definitionId))) {
        fields.push({ path: 'signatories', message: `${row.name} is not allowed to sign this certification.` });
      }
      if (activation && !inEffect(row, today)) fields.push({ path: 'signatories', message: `${row.name} is not an active signatory.` });
    }
    if (state.stampId) {
      const stamp = await this.db.selectFrom('stamps').select(['id', 'name', 'active', 'effective_from', 'effective_to']).where('id', '=', state.stampId).where('organization_id', '=', organizationId).executeTakeFirst();
      if (!stamp) fields.push({ path: 'stampId', message: 'Choose an existing stamp.' });
      else {
        const allowed = await this.db.selectFrom('stamp_certifications').select('definition_id').where('stamp_id', '=', stamp.id).execute();
        if (allowed.length && (!definitionId || !allowed.some((r) => r.definition_id === definitionId))) {
          fields.push({ path: 'stampId', message: `The stamp "${stamp.name}" is not allowed for this certification.` });
        }
        if (activation && !inEffect(stamp, today)) fields.push({ path: 'stampId', message: `The stamp "${stamp.name}" is not active.` });
      }
    }
    if (state.badge.assetId) {
      const asset = (await assetsByIds(this.db, organizationId, [state.badge.assetId])).get(state.badge.assetId);
      if (!asset || !['badge', 'logo'].includes(asset.purpose)) fields.push({ path: 'badge.assetId', message: 'Choose an uploaded badge image.' });
    }
    if (state.validity.kind === 'fixed_date' && state.validity.date <= today) {
      fields.push({ path: 'validity.date', message: 'The fixed expiration date must be in the future.' });
    }
    if (fields.length) throw new ValidationError(fields);

    if (activation) {
      if (leaves(eligibility.rule).length === 0) {
        throw new PreconditionError('ELIGIBILITY_RULE_REQUIRED', 'Add at least one requirement before activating this certification.');
      }
      if (!design) throw new PreconditionError('TEMPLATE_REQUIRED', 'Assign a certificate template before activating this certification.');
      const signatures = await currentSignatures(this.db, state.signatories.map((s) => s.signatoryId));
      for (const n of [1, 2] as const) {
        if (!design.elements.some((el) => el.type === 'signature' && signatureSlotOf(el) === n)) continue;
        const slot = state.signatories.find((s) => s.slot === n);
        if (!slot) throw new PreconditionError('SIGNATORY_MISSING', `The template shows signatory ${n}. Assign a signatory to slot ${n}.`);
        if (!signatures.get(slot.signatoryId)) {
          const name = signatoryRows.find((s) => s.id === slot.signatoryId)?.name ?? 'The signatory';
          throw new PreconditionError('SIGNATURE_MISSING', `${name} has no signature image yet. Upload one before activating.`);
        }
      }
      if (design.elements.some((el) => el.type === 'stamp')) {
        if (!state.stampId) throw new PreconditionError('STAMP_MISSING', 'The template shows a stamp. Choose a stamp for this certification.');
        if (!(await currentStampImages(this.db, [state.stampId])).get(state.stampId)) {
          throw new PreconditionError('STAMP_IMAGE_MISSING', 'Upload an image for the selected stamp before activating.');
        }
      }
    }
    return { ...state, eligibilityRule: eligibility.rule, renewal: { ...state.renewal, requirements: renewalRule.rule } };
  }

  private async write(trx: Trx, id: string, state: DefinitionState): Promise<void> {
    await trx.deleteFrom('certification_programs').where('definition_id', '=', id).execute();
    if (state.programIds.length) {
      await trx.insertInto('certification_programs').values([...new Set(state.programIds)].map((program_id) => ({ definition_id: id, program_id }))).execute();
    }
    await trx.deleteFrom('certification_signatory_slots').where('definition_id', '=', id).execute();
    if (state.signatories.length) {
      await trx
        .insertInto('certification_signatory_slots')
        .values(state.signatories.map((s) => ({ definition_id: id, slot: s.slot, signatory_id: s.signatoryId })))
        .execute();
    }
  }

  private columns(state: DefinitionState) {
    return {
      name: state.name,
      code: state.code,
      public_description: state.publicDescription,
      validity_policy: state.validity,
      renewal_policy: state.renewal,
      eligibility_rule: state.eligibilityRule,
      approval_policy: state.approvalPolicy,
      automatic_issuance: state.automaticIssuance,
      issuing_organization_name: state.issuingOrganizationName,
      template_id: state.templateId,
      stamp_id: state.stampId,
      badge: state.badge,
      public_verification_enabled: state.publicVerificationEnabled,
      number_pattern: state.numberPattern,
      custom_variables: state.customVariables,
    };
  }

  async create(p: Principal, input: CreateInput): Promise<certification.CertificationDetail> {
    const state = await this.validate(
      p.organizationId,
      null,
      {
        ...input,
        publicDescription: input.publicDescription ?? null,
        renewal: input.renewal,
        signatories: input.signatories.map((s) => ({ slot: s.slot, signatoryId: s.signatoryId })),
      },
      false,
    );
    const id = uuidv7();
    try {
      await this.db.transaction().execute(async (trx) => {
        await trx
          .insertInto('certification_definitions')
          .values({
            id,
            organization_id: p.organizationId,
            status: 'draft',
            ...this.columns(state),
            activated_at: null,
            archived_at: null,
            created_by: p.userId,
            created_by_name: p.displayName,
            updated_by: p.userId,
            updated_by_name: p.displayName,
          })
          .execute();
        await this.write(trx, id, state);
        await trx.insertInto('certificate_number_sequences').values({ definition_id: id }).execute();
        await this.events.audit(trx, { action: 'certification.created', resourceType: 'certification', resourceId: id, actorDisplay: p.displayName, after: state });
      });
    } catch (err) {
      if (isUniqueViolation(err, 'certification_definitions_org_code_uq')) {
        throw new ConflictError('CODE_TAKEN', 'Another certification already uses this code. Choose a different code.');
      }
      throw err;
    }
    return this.get(p, id);
  }

  async update(p: Principal, id: string, input: UpdateInput): Promise<certification.CertificationDetail> {
    const before = await this.load(this.db, p, id);
    if (before.status === 'archived') throw new PreconditionError('CERTIFICATION_ARCHIVED', 'Archived certifications cannot be edited.');
    const current = await this.stateOf(before);
    const next: DefinitionState = {
      ...current,
      ...Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)),
      signatories: input.signatories ? input.signatories.map((s) => ({ slot: s.slot, signatoryId: s.signatoryId })) : current.signatories,
      publicDescription: input.publicDescription !== undefined ? (input.publicDescription ?? null) : current.publicDescription,
    } as DefinitionState;
    if (next.code.toLowerCase() !== current.code.toLowerCase()) {
      const issued = await this.db.selectFrom('issued_certificates').select('id').where('definition_id', '=', id).executeTakeFirst();
      if (issued) throw new PreconditionError('CODE_LOCKED', 'The code is part of issued certificate numbers and cannot change after the first certificate.');
    }
    const state = await this.validate(p.organizationId, id, next, before.status === 'active');
    try {
      await this.db.transaction().execute(async (trx) => {
        await this.load(trx, p, id, true);
        await trx
          .updateTable('certification_definitions')
          .set((eb) => ({ ...this.columns(state), revision: eb('revision', '+', 1), updated_by: p.userId, updated_by_name: p.displayName }))
          .where('id', '=', id)
          .execute();
        await this.write(trx, id, state);
        await this.events.audit(trx, { action: 'certification.updated', resourceType: 'certification', resourceId: id, actorDisplay: p.displayName, before: current, after: state });
        if (before.status === 'active') await markDefinitionsDirty(trx, [id]);
      });
    } catch (err) {
      if (isUniqueViolation(err, 'certification_definitions_org_code_uq')) {
        throw new ConflictError('CODE_TAKEN', 'Another certification already uses this code. Choose a different code.');
      }
      throw err;
    }
    if (before.status === 'active') await this.eligibility.processDirty({ definitionId: id, limit: 200 });
    return this.get(p, id);
  }

  async activate(p: Principal, id: string): Promise<certification.CertificationDetail> {
    const before = await this.load(this.db, p, id);
    if (before.status === 'active') return this.get(p, id);
    if (before.status === 'archived') throw new PreconditionError('CERTIFICATION_ARCHIVED', 'Archived certifications cannot be activated again. Create a new certification.');
    const state = await this.validate(p.organizationId, id, await this.stateOf(before), true);
    await this.db.transaction().execute(async (trx) => {
      await this.load(trx, p, id, true);
      await trx
        .updateTable('certification_definitions')
        .set((eb) => ({ ...this.columns(state), status: 'active', activated_at: new Date(), revision: eb('revision', '+', 1), updated_by: p.userId, updated_by_name: p.displayName }))
        .where('id', '=', id)
        .execute();
      await this.events.audit(trx, { action: 'certification.activated', resourceType: 'certification', resourceId: id, actorDisplay: p.displayName });
      await markDefinitionsDirty(trx, [id]);
    });
    await this.eligibility.processDirty({ definitionId: id, limit: 200 });
    return this.get(p, id);
  }

  async archive(p: Principal, id: string): Promise<certification.CertificationDetail> {
    await this.db.transaction().execute(async (trx) => {
      const d = await this.load(trx, p, id, true);
      if (d.status === 'archived') return;
      await trx
        .updateTable('certification_definitions')
        .set((eb) => ({ status: 'archived', archived_at: new Date(), revision: eb('revision', '+', 1), updated_by: p.userId, updated_by_name: p.displayName }))
        .where('id', '=', id)
        .execute();
      await trx
        .updateTable('certificate_approvals')
        .set({ status: 'cancelled', decided_at: new Date(), comment: 'The certification was archived.' })
        .where('definition_id', '=', id)
        .where('status', '=', 'pending')
        .execute();
      await trx.deleteFrom('eligibility_dirty').where('definition_id', '=', id).execute();
      await this.events.audit(trx, {
        action: 'certification.archived',
        resourceType: 'certification',
        resourceId: id,
        actorDisplay: p.displayName,
        metadata: { note: 'Issued certificates remain valid until they expire or are revoked.' },
      });
    });
    return this.get(p, id);
  }

  /** Live requirement breakdown for the caller or, with certificates.view, for someone in scope. */
  async progress(p: Principal, id: string, userId: string | undefined) {
    await this.load(this.db, p, id);
    const target = userId ?? p.userId;
    if (!(await this.access.canViewCertificatesOf(p, { userId: target, organizationId: p.organizationId }))) throw new NotFoundError('Person');
    const progress = await this.eligibility.progress(id, target);
    if (!progress) throw new NotFoundError('Certification');
    return progress;
  }

  /** Start a new cycle for a rejected candidate or lift a hold, then re-evaluate. */
  async reopen(p: Principal, id: string, userId: string, note: string | null) {
    await this.load(this.db, p, id);
    await this.access.assertAdmits(p, 'certifications.update', { userId, organizationId: p.organizationId }, 'Person');
    await this.db.transaction().execute(async (trx) => {
      const cand = await trx
        .selectFrom('certification_candidates')
        .selectAll()
        .where('definition_id', '=', id)
        .where('user_id', '=', userId)
        .forUpdate()
        .executeTakeFirst();
      if (!cand) throw new NotFoundError('Candidate');
      if (cand.status !== 'rejected' && !cand.hold_reason) {
        throw new PreconditionError('NOTHING_TO_REOPEN', 'This person is neither rejected nor on hold for this certification.');
      }
      await trx
        .updateTable('certification_candidates')
        .set((eb) => ({
          status: 'in_progress',
          cycle: cand.status === 'rejected' ? eb('cycle', '+', 1) : eb.ref('cycle'),
          rejected_at: null,
          hold_reason: null,
          held_at: null,
          eligible_at: null,
        }))
        .where('id', '=', cand.id)
        .execute();
      await this.events.audit(trx, {
        action: 'certification.candidate_reopened',
        resourceType: 'certification_candidate',
        resourceId: cand.id,
        actorDisplay: p.displayName,
        before: { status: cand.status, holdReason: cand.hold_reason },
        reason: note,
      });
    });
    const progress = await this.eligibility.evaluate(id, userId);
    if (!progress) throw new PreconditionError('CERTIFICATION_NOT_ACTIVE', 'Activate the certification to evaluate candidates.');
    return progress;
  }
}
