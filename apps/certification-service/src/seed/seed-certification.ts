import { certification } from '@a5/contracts';
import { jsonb } from '../common/jsonb.js';
import { applyDirectoryTeam, applyDirectoryUnit, applyDirectoryUser } from '@a5/directory';
import type { Rule } from '@a5/rules';
import {
  ASSESSMENTS,
  CERTIFICATE_TEMPLATES,
  CERTIFICATION,
  JOURNEYS,
  ORGANIZATION,
  PEOPLE,
  PHASES,
  PROGRAM,
  SCENARIOS,
  SEED_NOW,
  SIGNATORIES,
  STAMPS,
  allLessons,
  completedLessonKeys,
  daysAgo,
  directoryTeams,
  directoryUnits,
  directoryUsers,
  seedId,
  type PersonKey,
} from '@a5/seed-data';
import { uuidv7 } from '@a5/observability';
import type { ObjectStorage } from '@a5/storage';
import type { CertificationConfig } from '../config.js';
import type { Db, Trx } from '../database/index.js';
import { storageKeys } from '../common/storage.js';
import { validateCertificateImage } from '../common/images.js';
import { EligibilityService } from '../eligibility/eligibility.service.js';
import { IssuanceService } from '../issuance/issuance.service.js';
import { generateCertificatePdf } from '../issuance/pdf.service.js';
import { LifecycleService } from '../jobs/lifecycle.service.js';
import { STARTER_DESIGNS } from '../templates/starters.js';
import { renderSeal, renderSignature } from './artwork.js';

export interface SeedDeps {
  db: Db;
  storage: ObjectStorage;
  config: Pick<CertificationConfig, 'publicAppUrl'>;
  issuance: IssuanceService;
  eligibility: EligibilityService;
  lifecycle: LifecycleService;
}

export interface SeedOptions {
  log?: (line: string) => void;
  /** Reference time for projections and lifecycle checks. */
  now?: Date;
}

const ORG = ORGANIZATION.id;
const DAY = 86_400_000;

/** Eligibility rule of the seeded certification (every threshold comes from the shared catalogue). */
export function seededEligibilityRule(): Rule {
  return {
    type: 'all',
    rules: [
      { type: 'program_completed', programId: PROGRAM.id, minPercent: 100 },
      {
        type: 'program_assessments_score',
        programId: PROGRAM.id,
        minPercent: CERTIFICATION.quizMinimum,
        kinds: ['quiz'],
      },
      {
        type: 'assessment_score',
        assessmentId: ASSESSMENTS.find((a) => a.key === 'final')!.id,
        minPercent: CERTIFICATION.finalMinimum,
      },
      { type: 'ai_sessions_count', minCount: CERTIFICATION.requiredAiSessions },
      { type: 'ai_average_score', minScore: CERTIFICATION.aiAverage },
      { type: 'approval', kind: 'manager' },
    ],
  };
}

function seededRenewalRule(): Rule {
  return {
    type: 'all',
    rules: [
      { type: 'ai_sessions_count', minCount: 2, minScore: CERTIFICATION.aiAverage },
      { type: 'approval', kind: 'manager' },
    ],
  };
}

async function putAsset(
  db: Db,
  storage: ObjectStorage,
  asset: {
    id: string;
    purpose: 'signature' | 'stamp';
    png: Buffer;
    filename: string;
    by: { id: string; name: string };
  },
): Promise<void> {
  const image = await validateCertificateImage(asset.png, 'image/png', asset.purpose);
  const key = storageKeys.asset(ORG, asset.id, 'png');
  await storage.putObject(key, asset.png, {
    contentType: 'image/png',
    contentLength: asset.png.length,
  });
  await db
    .insertInto('certification_assets')
    .values({
      id: asset.id,
      organization_id: ORG,
      purpose: asset.purpose,
      storage_key: key,
      content_type: 'image/png',
      byte_size: image.byteSize,
      width: image.width,
      height: image.height,
      sha256: image.sha256,
      original_filename: asset.filename,
      created_by: asset.by.id,
      created_by_name: asset.by.name,
    })
    .onConflict((oc) => oc.column('id').doNothing())
    .execute();
}

const fullName = (key: PersonKey) => `${PEOPLE[key].firstName} ${PEOPLE[key].lastName}`;

/** Position of a journey's manager (the person who approves). */
function managerOf(person: PersonKey): PersonKey {
  const team = directoryTeams().find((t) => t.memberIds.includes(PEOPLE[person].id));
  const manager = Object.entries(PEOPLE).find(([, p]) => p.id === team?.managerIds[0]);
  return (manager?.[0] ?? 'priya') as PersonKey;
}

/**
 * Seed the A5 certification catalogue: directory projection, template designs, signatories with
 * generated signatures, the company seal, the Certified Sales Representative definition, learner
 * facts for every journey, issued certificates with real PDFs, and a pending approval.
 * Idempotent: every step either upserts deterministic rows or skips work that already exists.
 */
export async function seedCertification(
  deps: SeedDeps,
  options: SeedOptions = {},
): Promise<{ created: boolean }> {
  const { db, storage } = deps;
  const log = options.log ?? (() => undefined);
  const now = options.now ?? SEED_NOW;
  const alreadySeeded = await db
    .selectFrom('certification_definitions')
    .select('id')
    .where('id', '=', CERTIFICATION.id)
    .executeTakeFirst();

  // ------------------------------------------------------------ directory projection
  await db.transaction().execute(async (trx) => {
    const t = trx as Trx;
    for (const unit of directoryUnits()) await applyDirectoryUnit(t, unit, 1);
    for (const team of directoryTeams()) await applyDirectoryTeam(t, team, 1);
    for (const user of directoryUsers()) await applyDirectoryUser(t, user, 1);
  });

  const priya = { id: PEOPLE.priya.id, name: fullName('priya') };

  // ------------------------------------------------------------ settings, artwork, templates
  await db
    .insertInto('certification_settings')
    .values({
      organization_id: ORG,
      organization_code: 'A5',
      verification_base_url: null,
      recipient_name_display: 'full_name',
      show_certificate_number: true,
      show_expiration_date: true,
      timezone: ORGANIZATION.timezone,
      updated_by: null,
    })
    .onConflict((oc) => oc.column('organization_id').doNothing())
    .execute();

  const sealAssetId = seedId('cert-asset:stamp:company-seal');
  const stampSeed = STAMPS[0];
  const signatureAssets = new Map<string, string>();
  for (const s of SIGNATORIES) {
    const assetId = seedId(`cert-asset:signature:${s.key}`);
    signatureAssets.set(s.key, assetId);
    await putAsset(db, storage, {
      id: assetId,
      purpose: 'signature',
      png: await renderSignature(fullName(s.person), s.key === 'priya' ? 'flowing' : 'brisk'),
      filename: `${s.key}-signature.png`,
      by: priya,
    });
  }
  await putAsset(db, storage, {
    id: sealAssetId,
    purpose: 'stamp',
    png: await renderSeal({
      topText: ORGANIZATION.legalName.toUpperCase(),
      bottomText: 'OFFICIAL SEAL',
      monogram: 'A5',
      caption: 'SALES ACADEMY',
    }),
    filename: 'company-seal.png',
    by: priya,
  });

  await db.transaction().execute(async (trx) => {
    for (const tpl of CERTIFICATE_TEMPLATES) {
      const starter = STARTER_DESIGNS[tpl.key];
      await trx
        .insertInto('certificate_templates')
        .values({
          id: tpl.id,
          organization_id: ORG,
          name: tpl.name,
          description: starter.description,
          status: 'active',
          is_default: tpl.key === 'classic',
          current_version: 1,
          cloned_from_id: null,
          archived_at: null,
          created_by: priya.id,
          created_by_name: priya.name,
          updated_by: priya.id,
          updated_by_name: priya.name,
        })
        .onConflict((oc) => oc.column('id').doNothing())
        .execute();
      await trx
        .insertInto('certificate_template_versions')
        .values({
          id: seedId(`template-version:${tpl.key}:1`),
          template_id: tpl.id,
          version: 1,
          design: starter.design,
          change_note: `Created from the ${starter.name} starter design`,
          created_by: priya.id,
          created_by_name: priya.name,
        })
        .onConflict((oc) => oc.column('id').doNothing())
        .execute();
    }

    for (const s of SIGNATORIES) {
      const person = PEOPLE[s.person];
      await trx
        .insertInto('signatories')
        .values({
          id: s.id,
          organization_id: ORG,
          user_id: person.id,
          name: fullName(s.person),
          title: s.title,
          department: 'Sales Training & Enablement',
          active: true,
          effective_from: null,
          effective_to: null,
          created_by: priya.id,
          created_by_name: priya.name,
          updated_by: priya.id,
          updated_by_name: priya.name,
        })
        .onConflict((oc) => oc.column('id').doNothing())
        .execute();
      await trx
        .insertInto('signatory_signatures')
        .values({
          id: seedId(`signature-version:${s.key}:1`),
          signatory_id: s.id,
          version: 1,
          asset_id: signatureAssets.get(s.key)!,
          created_by: priya.id,
          created_by_name: priya.name,
        })
        .onConflict((oc) => oc.column('id').doNothing())
        .execute();
    }
    await trx
      .insertInto('stamps')
      .values({
        id: stampSeed.id,
        organization_id: ORG,
        name: stampSeed.name,
        kind: 'company',
        department_name: null,
        active: true,
        effective_from: null,
        effective_to: null,
        created_by: priya.id,
        created_by_name: priya.name,
        updated_by: priya.id,
        updated_by_name: priya.name,
      })
      .onConflict((oc) => oc.column('id').doNothing())
      .execute();
    await trx
      .insertInto('stamp_images')
      .values({
        id: seedId('stamp-image:company-seal:1'),
        stamp_id: stampSeed.id,
        version: 1,
        asset_id: sealAssetId,
        created_by: priya.id,
        created_by_name: priya.name,
      })
      .onConflict((oc) => oc.column('id').doNothing())
      .execute();

    // ---------------------------------------------------------- definition
    await trx
      .insertInto('certification_definitions')
      .values({
        id: CERTIFICATION.id,
        organization_id: ORG,
        name: CERTIFICATION.name,
        code: CERTIFICATION.code,
        public_description:
          'Awarded to sales representatives who completed the A5 New Hire Sales Academy, passed every knowledge check and the final readiness assessment, practiced with the AI homeowner and were signed off by their manager.',
        status: 'active',
        validity_policy: { kind: 'months', months: CERTIFICATION.validityMonths },
        renewal_policy: {
          windowDays: 90,
          reminderOffsets: certification.DEFAULT_REMINDER_OFFSETS,
          requirements: seededRenewalRule(),
        },
        eligibility_rule: seededEligibilityRule(),
        approval_policy: 'manager',
        automatic_issuance: true,
        issuing_organization_name: ORGANIZATION.legalName,
        template_id: CERTIFICATE_TEMPLATES[0].id,
        stamp_id: stampSeed.id,
        badge: { label: 'Certified Sales Rep', color: '#B4531F', assetId: null },
        public_verification_enabled: true,
        number_pattern: CERTIFICATION.numberPattern,
        custom_variables: jsonb([]),
        activated_at: daysAgo(540, now),
        archived_at: null,
        created_by: priya.id,
        created_by_name: priya.name,
        updated_by: priya.id,
        updated_by_name: priya.name,
      })
      .onConflict((oc) => oc.column('id').doNothing())
      .execute();
    await trx
      .insertInto('certification_programs')
      .values({ definition_id: CERTIFICATION.id, program_id: PROGRAM.id })
      .onConflict((oc) => oc.doNothing())
      .execute();
    await trx
      .insertInto('certification_signatory_slots')
      .values(
        SIGNATORIES.map((s, i) => ({
          definition_id: CERTIFICATION.id,
          slot: i + 1,
          signatory_id: s.id,
        })),
      )
      .onConflict((oc) => oc.doNothing())
      .execute();
    await trx
      .insertInto('certificate_number_sequences')
      .values({ definition_id: CERTIFICATION.id })
      .onConflict((oc) => oc.column('definition_id').doNothing())
      .execute();

    // ---------------------------------------------------------- program catalogue projection
    await trx
      .insertInto('program_catalog')
      .values({
        program_id: PROGRAM.id,
        organization_id: ORG,
        title: PROGRAM.title,
        version: 1,
        phases: jsonb(PHASES.map((p, i) => ({ phaseId: p.id, title: p.title, position: i + 1 }))),
        archived: false,
      })
      .onConflict((oc) => oc.column('program_id').doNothing())
      .execute();
    const lessons = allLessons();
    await trx
      .insertInto('program_assessments')
      .values(
        ASSESSMENTS.map((a) => ({
          program_id: PROGRAM.id,
          assessment_id: a.id,
          lesson_id: lessons.find((l) => l.key === a.lessonKey)?.id ?? null,
          kind: a.kind,
          required: true,
          title: a.title,
        })),
      )
      .onConflict((oc) => oc.columns(['program_id', 'assessment_id']).doNothing())
      .execute();
  });
  log('certification: definition, templates, signatories and seal ready');

  // ------------------------------------------------------------ learner fact projections
  await seedLearnerFacts(db, now);
  log(`certification: projected learner facts for ${JOURNEYS.length} journeys`);

  // ------------------------------------------------------------ historical certificates
  const issued = await seedCertificates(deps);

  // Reminders and renewal windows as of the seed date (Sofia is inside her renewal window).
  const windows = await deps.lifecycle.openRenewalWindows(now);
  const reminders = await deps.lifecycle.sendReminders(now);

  // Evaluate everyone else through the real engine (Brianna becomes a pending approval).
  for (const j of JOURNEYS) {
    if (j.certificates?.length) continue;
    await deps.eligibility.evaluate(CERTIFICATION.id, PEOPLE[j.person].id, { now });
  }

  // Real PDFs through the worker logic (no events: this is historical data).
  const pending = await db
    .selectFrom('issued_certificates')
    .select('id')
    .where('pdf_status', '=', 'pending')
    .execute();
  for (const c of pending) await generateCertificatePdf(db, storage, c.id, undefined, now);

  log(
    `certification: ${alreadySeeded ? 'verified' : 'seeded'} ${issued} certificates, ${windows} renewal windows, ${reminders} reminders`,
  );
  return { created: !alreadySeeded };
}

async function seedLearnerFacts(db: Db, now: Date): Promise<void> {
  const lessons = allLessons();
  const requiredLessons = lessons.filter((l) => l.required);
  const phaseDone = (keys: Set<string>) =>
    PHASES.filter((p) =>
      p.modules.every((m) => m.lessons.filter((l) => l.required).every((l) => keys.has(l.key))),
    );
  const dayOffset: Record<string, number> = {
    'quiz-w1': 6,
    'quiz-w2': 13,
    'quiz-w3': 20,
    final: 30,
  };

  for (const j of JOURNEYS) {
    const user = PEOPLE[j.person];
    const enrolledAt = new Date(j.enrolledAt);
    const completedKeys = new Set(completedLessonKeys(j.stage));
    const complete = j.stage === 'certified' || j.stage === 'awaiting_approval';
    const firstIssued = j.certificates?.[0] ? new Date(j.certificates[0].issuedAt) : null;
    const completedAt =
      j.stage === 'certified' && firstIssued
        ? new Date(firstIssued.getTime() - DAY)
        : j.stage === 'awaiting_approval'
          ? daysAgo(8, now)
          : null;
    const percent = complete
      ? 100
      : Math.round(
          (requiredLessons.filter((l) => completedKeys.has(l.key)).length /
            requiredLessons.length) *
            10000,
        ) / 100;

    await db
      .insertInto('learner_program_status')
      .values({
        user_id: user.id,
        program_id: PROGRAM.id,
        organization_id: ORG,
        enrollment_id: seedId(`enrollment:${j.person}`),
        status: complete ? 'completed' : 'enrolled',
        progress_percent: percent,
        enrolled_at: enrolledAt,
        completed_at: completedAt,
        source_occurred_at: completedAt ?? now,
      })
      .onConflict((oc) => oc.columns(['user_id', 'program_id']).doNothing())
      .execute();

    const done = lessons.filter((l) => completedKeys.has(l.key));
    if (done.length) {
      const span = (completedAt ?? now).getTime() - enrolledAt.getTime();
      await db
        .insertInto('learner_milestones')
        .values(
          done.map((l, i) => ({
            user_id: user.id,
            kind: 'lesson' as const,
            ref_id: l.id,
            program_id: PROGRAM.id,
            title: l.title,
            completed_at: new Date(
              enrolledAt.getTime() + Math.round((span * (i + 1)) / (done.length + 1)),
            ),
          })),
        )
        .onConflict((oc) => oc.columns(['user_id', 'kind', 'ref_id']).doNothing())
        .execute();
      const finished = phaseDone(completedKeys);
      if (finished.length) {
        await db
          .insertInto('learner_milestones')
          .values(
            finished.map((p, i) => ({
              user_id: user.id,
              kind: 'phase' as const,
              ref_id: p.id,
              program_id: PROGRAM.id,
              title: p.title,
              completed_at: new Date(enrolledAt.getTime() + (i + 1) * 7 * DAY),
            })),
          )
          .onConflict((oc) => oc.columns(['user_id', 'kind', 'ref_id']).doNothing())
          .execute();
      }
    }

    const results = (Object.entries(j.attempts) as Array<[string, number[]]>).flatMap(
      ([key, scores]) => {
        const assessment = ASSESSMENTS.find((a) => a.key === key)!;
        return scores.map((score, i) => ({
          attempt_id: seedId(`attempt:${j.person}:${key}:${i + 1}`),
          user_id: user.id,
          organization_id: ORG,
          assessment_id: assessment.id,
          kind: assessment.kind,
          title: assessment.title,
          score_percent: score,
          passed: score >= assessment.passingPercent,
          program_id: PROGRAM.id,
          graded_at: new Date(enrolledAt.getTime() + ((dayOffset[key] ?? 20) + i) * DAY),
        }));
      },
    );
    if (results.length)
      await db
        .insertInto('learner_assessment_results')
        .values(results)
        .onConflict((oc) => oc.column('attempt_id').doNothing())
        .execute();

    const sessions = j.aiSessions.map((s, i) => {
      const scenario = SCENARIOS.find((x) => x.key === s.scenario)!;
      return {
        session_id: seedId(`ai-session:${j.person}:${i + 1}`),
        user_id: user.id,
        organization_id: ORG,
        scenario_id: scenario.id,
        scenario_title: scenario.title,
        overall_score: s.score,
        passed: s.score >= scenario.passingScore,
        program_id: PROGRAM.id,
        evaluated_at: daysAgo(s.daysAgo, now),
      };
    });
    if (sessions.length)
      await db
        .insertInto('learner_ai_results')
        .values(sessions)
        .onConflict((oc) => oc.column('session_id').doNothing())
        .execute();
  }
}

/** Historical certificates through the real issuance path (numbers, snapshots, copied images, timeline). */
async function seedCertificates(deps: SeedDeps): Promise<number> {
  const { db, issuance, eligibility } = deps;
  let issued = 0;
  const journeys = JOURNEYS.filter((j) => j.certificates?.length)
    .map((j) => ({ j, first: new Date(j.certificates![0]!.issuedAt).getTime() }))
    .sort((a, b) => a.first - b.first)
    .map((x) => x.j);

  for (const j of journeys) {
    const user = PEOPLE[j.person];
    const existing = await db
      .selectFrom('issued_certificates')
      .select('id')
      .where('definition_id', '=', CERTIFICATION.id)
      .where('user_id', '=', user.id)
      .executeTakeFirst();
    if (existing) continue;

    const manager = managerOf(j.person);
    const [first, ...rest] = j.certificates!;
    const firstIssuedAt = new Date(first!.issuedAt);
    const recipientFor = (name?: string) => ({
      userId: user.id,
      organizationId: ORG,
      firstName: user.firstName,
      lastName: name ? name.split(' ').slice(1).join(' ') : user.lastName,
      legalName: name ?? `${user.firstName} ${user.lastName}`,
      employeeId: user.employeeId,
      source: 'directory' as const,
    });

    // The approval that precedes issuance, recorded against the candidate.
    const candidateId = uuidv7(firstIssuedAt.getTime());
    await db
      .insertInto('certification_candidates')
      .values({
        id: candidateId,
        organization_id: ORG,
        definition_id: CERTIFICATION.id,
        user_id: user.id,
        status: 'approved',
        purpose: 'initial',
        cycle: 1,
        renewal_id: null,
        requirements: jsonb([]),
        met_count: 0,
        total_count: 0,
        auto_requirements_met: true,
        evaluated_at: null,
        eligible_at: new Date(firstIssuedAt.getTime() - 2 * DAY),
        eligible_cycle: 1,
        rejected_at: null,
        hold_reason: null,
        held_at: null,
        issue_error: null,
        certificate_id: null,
      })
      .onConflict((oc) => oc.columns(['definition_id', 'user_id']).doNothing())
      .execute();
    const candidate = await db
      .selectFrom('certification_candidates')
      .select('id')
      .where('definition_id', '=', CERTIFICATION.id)
      .where('user_id', '=', user.id)
      .executeTakeFirstOrThrow();
    await db
      .insertInto('certificate_approvals')
      .values({
        id: seedId(`approval:${j.person}:1`),
        organization_id: ORG,
        candidate_id: candidate.id,
        definition_id: CERTIFICATION.id,
        user_id: user.id,
        cycle: 1,
        kind: 'manager',
        status: 'approved',
        requested_at: new Date(firstIssuedAt.getTime() - 2 * DAY),
        decided_at: new Date(firstIssuedAt.getTime() - DAY),
        decided_by: PEOPLE[manager].id,
        decided_by_name: fullName(manager),
        comment: 'Field ready. Strong objection handling in ride-alongs.',
      })
      .onConflict((oc) => oc.columns(['candidate_id', 'cycle']).doNothing())
      .execute();

    const cert = await db
      .selectFrom('certification_definitions')
      .selectAll()
      .where('id', '=', CERTIFICATION.id)
      .executeTakeFirstOrThrow();
    const outcome = await eligibility.compute(
      db,
      cert,
      user.id,
      await db
        .selectFrom('certification_candidates')
        .selectAll()
        .where('id', '=', candidate.id)
        .executeTakeFirstOrThrow(),
      firstIssuedAt,
    );
    if (!outcome.satisfied) {
      throw new Error(
        `Seed journey for ${j.person} does not satisfy the certification requirements: ${outcome.requirements
          .filter((r) => !r.satisfied)
          .map((r) => r.description)
          .join('; ')}`,
      );
    }
    await db
      .updateTable('certification_candidates')
      .set({
        requirements: jsonb(outcome.requirements),
        met_count: outcome.metCount,
        total_count: outcome.totalCount,
        evaluated_at: firstIssuedAt,
      })
      .where('id', '=', candidate.id)
      .execute();

    // Destiny's first certificate carried a misspelled name that was later corrected by a reissue.
    const misspelled =
      rest.length > 0 && first!.reissueReason
        ? `${user.firstName} ${user.lastName.replace(/s$/, 'z')}`
        : undefined;
    const original = await issuance.issue({
      definitionId: CERTIFICATION.id,
      userId: user.id,
      mode: 'approval',
      actor: { userId: null, displayName: null },
      issuedAt: firstIssuedAt,
      recipient: recipientFor(misspelled),
      silent: true,
    });
    issued++;

    for (const next of rest) {
      await issuance.issue({
        definitionId: CERTIFICATION.id,
        userId: user.id,
        mode: 'reissue',
        actor: { userId: PEOPLE.grant.id, displayName: fullName('grant') },
        issuedAt: new Date(next.issuedAt),
        recipient: recipientFor(),
        reissue: {
          originalCertificateId: original.certificateId,
          reasonCode: 'corrected_name',
          note: first!.reissueReason ?? 'Corrected recipient details',
        },
        silent: true,
      });
      issued++;
    }
  }
  return issued;
}
