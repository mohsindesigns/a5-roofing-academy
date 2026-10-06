import { createHash } from 'node:crypto';
import { applyDirectoryTeam, applyDirectoryUnit, applyDirectoryUser } from '@a5/directory';
import type { EventPayload, EventType } from '@a5/events';
import {
  ASSESSMENTS,
  CERTIFICATION,
  JOURNEYS,
  ORGANIZATION,
  PEOPLE,
  PHASES,
  PROGRAM,
  SCENARIOS,
  SEED_NOW,
  TEAMS,
  daysAgo,
  directoryTeams,
  directoryUnits,
  directoryUsers,
  emailOf,
  seedId,
  type PersonKey,
} from '@a5/seed-data';
import { provisionDefaults } from '../catalog/defaults.js';
import {
  EVENT_DESCRIPTORS,
  getTypeDef,
  type BuildContext,
  type NotificationTypeKey,
} from '../catalog/notification-types.js';
import { json, type Db, type Trx } from '../database/index.js';
import { renderEmail, renderInApp, type TemplateVars } from '../templates/renderer.js';

export interface SeedOptions {
  /** Also create a realistic inbox history for the seeded people (default true). */
  demo?: boolean;
  /** Public web origin used in email links. */
  appUrl?: string;
  timezone?: string;
  log?: (line: string) => void;
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** Deterministic, time-ordered UUIDv7 for seed rows (48-bit timestamp + hashed name). */
export function seedUuidV7(at: Date, name: string): string {
  const hash = createHash('sha256').update(`a5-seed:${name}`).digest();
  const bytes = Buffer.alloc(16);
  const ms = BigInt(at.getTime());
  for (let i = 0; i < 6; i++) bytes[i] = Number((ms >> BigInt(8 * (5 - i))) & 0xffn);
  hash.copy(bytes, 6, 0, 10);
  bytes[6] = 0x70 | (bytes[6]! & 0x0f);
  bytes[8] = 0x80 | (bytes[8]! & 0x3f);
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function managersOf(person: PersonKey): PersonKey[] {
  return [
    ...new Set(
      TEAMS.filter((t) => (t.members as readonly string[]).includes(person)).flatMap(
        (t) => t.managers,
      ),
    ),
  ];
}

const name = (key: PersonKey) => `${PEOPLE[key].firstName} ${PEOPLE[key].lastName}`;

interface SeedEvent<E extends EventType = EventType> {
  key: string;
  type: E;
  at: Date;
  payload: EventPayload<E>;
}

interface Delivery {
  type: NotificationTypeKey;
  to: PersonKey;
  learner: PersonKey | null;
  event: { key: string; type: EventType; at: Date; payload: unknown };
  /** Unread notifications stay highlighted in the demo. */
  read: boolean;
  email: boolean;
}

/** The events that would have produced the seeded people's notifications, derived from their journeys. */
function journeyEvents(): Delivery[] {
  const out: Delivery[] = [];
  const recent = (at: Date) => at.getTime() > SEED_NOW.getTime() - 4 * DAY;
  const add = (
    type: NotificationTypeKey,
    to: PersonKey,
    learner: PersonKey | null,
    event: Delivery['event'],
    options: { read?: boolean; email?: boolean } = {},
  ) =>
    out.push({
      type,
      to,
      learner,
      event,
      read: options.read ?? !recent(event.at),
      email: options.email ?? false,
    });
  const assessmentOffsetDays: Record<string, number> = {
    'quiz-w1': 6,
    'quiz-w2': 13,
    'quiz-w3': 20,
    final: 27,
  };
  const withinEmailLog = (at: Date) => at.getTime() > SEED_NOW.getTime() - 30 * DAY;
  const signoff = PHASES.flatMap((p) => p.modules.flatMap((m) => m.lessons)).find(
    (l) => l.type === 'manager_approval',
  )!;

  for (const journey of JOURNEYS) {
    const person = journey.person;
    const userId = PEOPLE[person].id;
    const enrolledAt = new Date(journey.enrolledAt);
    const enrollmentId = seedId(`enrollment:${person}`);

    const created: SeedEvent<'user.created'> = {
      key: `user-created:${person}`,
      type: 'user.created',
      at: new Date(enrolledAt.getTime() - 2 * HOUR),
      payload: {
        userId,
        email: emailOf(PEOPLE[person]),
        displayName: name(person),
        roleKeys: ['sales_rep'],
        createdBy: PEOPLE.grant.id,
      },
    };
    add('account.welcome', person, person, created);

    const enrolled: SeedEvent<'program.enrolled'> = {
      key: `enrolled:${person}`,
      type: 'program.enrolled',
      at: new Date(enrolledAt.getTime() + 5 * 60_000),
      payload: {
        enrollmentId,
        programId: PROGRAM.id,
        userId,
        programTitle: PROGRAM.title,
        assignedBy: PEOPLE.shelby.id,
        dueAt: new Date(enrolledAt.getTime() + PROGRAM.durationDays * DAY).toISOString(),
        source: 'manual',
      },
    };
    add('training.assigned', person, person, enrolled, { email: withinEmailLog(enrolled.at) });

    for (const assessment of ASSESSMENTS) {
      const scores = journey.attempts[assessment.key as keyof typeof journey.attempts] ?? [];
      scores.forEach((score, index) => {
        const at = new Date(
          enrolledAt.getTime() + (assessmentOffsetDays[assessment.key]! + index) * DAY + 3 * HOUR,
        );
        if (at >= SEED_NOW) return;
        const passed = score >= assessment.passingPercent;
        const attemptId = seedId(`attempt:${person}:${assessment.key}:${index + 1}`);
        const graded: SeedEvent<'assessment.attempt.graded'> = {
          key: `graded:${person}:${assessment.key}:${index + 1}`,
          type: 'assessment.attempt.graded',
          at,
          payload: {
            attemptId,
            assessmentId: assessment.id,
            assessmentTitle: assessment.title,
            kind: assessment.kind,
            userId,
            attemptNumber: index + 1,
            scorePercent: score,
            passed,
            passingPercent: assessment.passingPercent,
            gradedAt: at.toISOString(),
            overridden: false,
            context: { programId: PROGRAM.id, enrollmentId },
            questionResults: [],
          },
        };
        add(passed ? 'assessment.passed' : 'assessment.failed', person, person, graded, {
          email: !passed && withinEmailLog(at),
        });
        if (!passed)
          for (const m of managersOf(person)) add('assessment.failed.manager', m, person, graded);
      });
    }

    journey.aiSessions.forEach((s, index) => {
      const scenario = SCENARIOS.find((sc) => sc.key === s.scenario)!;
      const at = new Date(daysAgo(s.daysAgo).getTime() - 2 * HOUR);
      const scored: SeedEvent<'ai.score.generated'> = {
        key: `ai-score:${person}:${index}`,
        type: 'ai.score.generated',
        at,
        payload: {
          sessionId: seedId(`ai-session:${person}:${index}`),
          scenarioId: scenario.id,
          scenarioTitle: scenario.title,
          scenarioCategory: scenario.category,
          difficulty: scenario.difficulty,
          userId,
          overallScore: s.score,
          passed: s.score >= scenario.passingScore,
          passingScore: scenario.passingScore,
          categoryScores: [],
          context: { programId: PROGRAM.id, enrollmentId },
          evaluatedAt: at.toISOString(),
          promptVersionId: seedId(`prompt-version:${scenario.key}:1`),
          rubricVersionId: seedId('rubric-version:a5-objection-handling:1'),
        },
      };
      add('ai.feedback_ready', person, person, scored);
    });

    if (journey.stage === 'awaiting_approval') {
      const requested: SeedEvent<'approval.requested'> = {
        key: `approval-requested:${person}`,
        type: 'approval.requested',
        at: daysAgo(2),
        payload: {
          enrollmentId,
          programId: PROGRAM.id,
          userId,
          approvalId: seedId(`approval:${person}:signoff`),
          lessonId: signoff.id,
          lessonTitle: signoff.title,
          programTitle: PROGRAM.title,
        },
      };
      for (const m of managersOf(person))
        add('approval.requested', m, person, requested, { read: false, email: true });
    }

    (journey.certificates ?? []).forEach((cert, index) => {
      const issuedAt = new Date(cert.issuedAt);
      const certificateId = seedId(`certificate:${person}:${index + 1}`);
      const year = issuedAt.getUTCFullYear();
      const certificateNumber = `A5-${CERTIFICATION.code}-${year}-${String(certificateSequence(person, index)).padStart(6, '0')}`;
      const expiresAt = new Date(issuedAt);
      expiresAt.setUTCMonth(expiresAt.getUTCMonth() + CERTIFICATION.validityMonths);
      const ref = {
        certificateId,
        definitionId: CERTIFICATION.id,
        definitionName: CERTIFICATION.name,
        userId,
      };
      const issued: SeedEvent<'certificate.issued'> = {
        key: `certificate-issued:${person}:${index + 1}`,
        type: 'certificate.issued',
        at: issuedAt,
        payload: {
          ...ref,
          certificateNumber,
          issuedAt: issuedAt.toISOString(),
          expiresAt: expiresAt.toISOString(),
          mode: index > 0 ? 'reissue' : 'approval',
        },
      };
      add('certificate.issued', person, person, issued);
      if (index === 0)
        for (const m of managersOf(person)) add('certificate.issued.manager', m, person, issued);
      const generated: SeedEvent<'certificate.generated'> = {
        key: `certificate-generated:${person}:${index + 1}`,
        type: 'certificate.generated',
        at: new Date(issuedAt.getTime() + 2 * 60_000),
        payload: { ...ref, certificateNumber },
      };
      add('certificate.generated', person, person, generated);

      const daysRemaining = Math.round((expiresAt.getTime() - SEED_NOW.getTime()) / DAY);
      if (cert.status === 'issued' && daysRemaining > 0 && daysRemaining <= 60) {
        const expiring: SeedEvent<'certificate.expiring'> = {
          key: `certificate-expiring:${person}:${index + 1}:60`,
          type: 'certificate.expiring',
          at: daysAgo(1),
          payload: { ...ref, expiresAt: expiresAt.toISOString(), daysRemaining: daysRemaining + 1 },
        };
        add('certificate.expiring', person, person, expiring, { read: false, email: true });
      }
    });
  }
  return out;
}

/** Sequence numbers in issue order per year, matching the certification seed's numbering. */
function certificateSequence(person: PersonKey, index: number): number {
  const issued = JOURNEYS.flatMap((j) =>
    (j.certificates ?? []).map((c, i) => ({
      person: j.person,
      index: i,
      at: new Date(c.issuedAt),
    })),
  ).sort((a, b) => a.at.getTime() - b.at.getTime());
  const self = issued.find((c) => c.person === person && c.index === index)!;
  return issued.filter((c) => c.at.getUTCFullYear() === self.at.getUTCFullYear() && c.at <= self.at)
    .length;
}

/**
 * Seed the notification service for the A5 organization: directory projection, default templates
 * and rules, program enrollments and (optionally) an inbox history derived from the seeded
 * learner journeys. Idempotent.
 */
export async function seedNotification(
  db: Db,
  options: SeedOptions = {},
): Promise<{ notifications: number; emails: number }> {
  const log = options.log ?? (() => undefined);
  const appUrl = (options.appUrl ?? 'http://localhost:5173').replace(/\/$/, '');

  await db.transaction().execute(async (trx) => {
    const t = trx as never;
    for (const unit of directoryUnits()) await applyDirectoryUnit(t, unit, 1);
    for (const team of directoryTeams()) await applyDirectoryTeam(t, team, 1);
    for (const user of directoryUsers()) await applyDirectoryUser(t, user, 1);
  });
  const provisioned = await provisionDefaults(db, ORGANIZATION.id);
  log(
    `notification: directory projection ready; ${provisioned.templates} templates and ${provisioned.rules} rules provisioned`,
  );

  await db
    .insertInto('program_learners')
    .values(
      JOURNEYS.map((j) => ({
        program_id: PROGRAM.id,
        user_id: PEOPLE[j.person].id,
        organization_id: ORGANIZATION.id,
        enrollment_id: seedId(`enrollment:${j.person}`),
        enrolled_at: new Date(j.enrolledAt),
        withdrawn_at: null,
        event_at: new Date(j.enrolledAt),
      })),
    )
    .onConflict((oc) => oc.columns(['program_id', 'user_id']).doNothing())
    .execute();

  if (options.demo === false) return { notifications: 0, emails: 0 };

  const timeZone = options.timezone ?? ORGANIZATION.timezone;
  const dateFormat = new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone,
  });
  const ctx: BuildContext = {
    appUrl,
    formatDate: (iso) => dateFormat.format(new Date(iso)),
    formatDateTime: (iso) => dateFormat.format(new Date(iso)),
    nameOf: (id, fallback) => {
      const person = Object.values(PEOPLE).find((p) => p.id === id);
      return person ? `${person.firstName} ${person.lastName}` : fallback;
    },
  };

  const templates = await db
    .selectFrom('notification_templates')
    .select(['type', 'channel', 'subject', 'body'])
    .where('organization_id', '=', ORGANIZATION.id)
    .execute();
  const templateOf = (type: string, channel: 'in_app' | 'email') =>
    templates.find((t) => t.type === type && t.channel === channel);

  let notifications = 0;
  let emails = 0;
  await db.transaction().execute(async (trx: Trx) => {
    for (const d of journeyEvents()) {
      const def = getTypeDef(d.type)!;
      const built = def.build(d.event.payload, ctx);
      const recipient = PEOPLE[d.to];
      const learnerName = d.learner ? name(d.learner) : null;
      const vars: TemplateVars = {
        ...built.vars,
        ...(learnerName && EVENT_DESCRIPTORS[def.eventType]?.subjectPath
          ? { learnerName, learnerFirstName: PEOPLE[d.learner!].firstName }
          : {}),
        recipientFirstName: recipient.firstName,
        recipientName: name(d.to),
        appUrl,
        link: `${appUrl}${built.path ?? ''}`,
      };
      const sourceEventId = seedId(`event:${d.event.key}`);
      const inApp = templateOf(def.key, 'in_app');
      if (inApp && def.channels.includes('in_app')) {
        const rendered = renderInApp(inApp, vars);
        const result = await trx
          .insertInto('notifications')
          .values({
            id: seedUuidV7(d.event.at, `notification:${d.event.key}:${d.to}:${def.key}`),
            organization_id: ORGANIZATION.id,
            user_id: recipient.id,
            type: def.key,
            title: rendered.title,
            body: rendered.body,
            link: built.path,
            data: json(built.data),
            priority: def.rule.priority,
            source_event_id: sourceEventId,
            available_at: d.event.at,
            created_at: d.event.at,
            read_at: d.read
              ? new Date(Math.min(d.event.at.getTime() + 3 * HOUR, SEED_NOW.getTime()))
              : null,
          })
          .onConflict((oc) => oc.columns(['source_event_id', 'user_id', 'type']).doNothing())
          .executeTakeFirst();
        notifications += Number(result.numInsertedOrUpdatedRows ?? 0n);
      }
      const emailTemplate = templateOf(def.key, 'email');
      if (d.email && emailTemplate) {
        const rendered = renderEmail(emailTemplate, vars, {
          actionLabel: def.actionLabel,
          actionUrl: vars.link ?? null,
          appUrl,
          mandatory: def.mandatory,
        });
        const sentAt = new Date(d.event.at.getTime() + 20_000);
        const result = await trx
          .insertInto('email_deliveries')
          .values({
            id: seedUuidV7(d.event.at, `email:${d.event.key}:${d.to}:${def.key}`),
            organization_id: ORGANIZATION.id,
            user_id: recipient.id,
            notification_type: def.key,
            source_event_id: sourceEventId,
            to_address: emailOf(recipient),
            to_name: name(d.to),
            subject: rendered.subject,
            body_text: rendered.text,
            body_html: rendered.html,
            sealed_content: null,
            sensitive: false,
            status: 'sent',
            attempts: 1,
            provider_message_id: `<${seedId(`smtp:${d.event.key}:${d.to}`)}@mail.a5roofing.example>`,
            last_error: null,
            scheduled_at: d.event.at,
            last_attempt_at: sentAt,
            sent_at: sentAt,
            failed_at: null,
            created_at: d.event.at,
          })
          .onConflict((oc) =>
            oc.columns(['source_event_id', 'user_id', 'notification_type']).doNothing(),
          )
          .executeTakeFirst();
        emails += Number(result.numInsertedOrUpdatedRows ?? 0n);
      }
    }
  });
  log(`notification: ${notifications} demo notifications and ${emails} email deliveries created`);
  return { notifications, emails };
}
