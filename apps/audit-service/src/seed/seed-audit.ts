import { createHash } from 'node:crypto';
import type { Producer } from '@a5/events';
import {
  ASSESSMENTS,
  CERTIFICATE_TEMPLATES,
  CERTIFICATION,
  JOURNEYS,
  LOCATIONS,
  ORGANIZATION,
  PEOPLE,
  PHASES,
  PROGRAM,
  SCENARIOS,
  SEED_NOW,
  SIGNATORIES,
  STAMPS,
  TEAMS,
  TRAINER_ASSIGNMENTS,
  emailOf,
  seedId,
  type PersonKey,
} from '@a5/seed-data';
import { jsonOrNull, type Db } from '../database/index.js';
import { ensurePartitions, ensureUpcomingPartitions, monthsBetween } from '../partitions/partitions.js';

export interface SeedOptions {
  /** Months after the last entry that also get partitions (default 3). */
  monthsAhead?: number;
  log?: (line: string) => void;
}

interface Entry {
  /** Stable key; ids and timestamps derive from it, which keeps the seed idempotent. */
  key: string;
  /** Calendar day (UTC) of the action. */
  day: string;
  actor: PersonKey | 'system';
  service: Producer;
  action: string;
  resourceType: string;
  resourceId: string | null;
  before?: unknown;
  after?: unknown;
  reason?: string;
  metadata?: Record<string, unknown>;
}

const DAY = 86_400_000;

function hashOf(text: string): Buffer {
  return createHash('sha256').update(`a5-audit-seed:${text}`).digest();
}

/** Deterministic, time-ordered UUIDv7 (48-bit timestamp + hashed name). */
export function seedUuidV7(at: Date, name: string): string {
  const bytes = Buffer.alloc(16);
  const ms = BigInt(at.getTime());
  for (let i = 0; i < 6; i++) bytes[i] = Number((ms >> BigInt(8 * (5 - i))) & 0xffn);
  hashOf(name).copy(bytes, 6, 0, 10);
  bytes[6] = 0x70 | (bytes[6]! & 0x0f);
  bytes[8] = 0x80 | (bytes[8]! & 0x3f);
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** A believable working-hours time (Central) for an action on `day`, derived from the key. */
function timeOf(day: string, key: string): Date {
  const h = hashOf(`time:${key}`);
  const minutes = 14 * 60 + 5 + (((h[0]! << 8) | h[1]!) % (7 * 60 + 45));
  return new Date(Date.parse(`${day}T00:00:00.000Z`) + minutes * 60_000 + (h[2]! % 60) * 1_000 + h[3]!);
}

const isoDay = (date: Date) => date.toISOString().slice(0, 10);
const shiftDays = (day: string, days: number) => isoDay(new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY));

/** The last weekday before `day`. */
function previousWorkday(day: string): string {
  let d = shiftDays(day, -1);
  for (;;) {
    const weekday = new Date(`${d}T00:00:00Z`).getUTCDay();
    if (weekday !== 0 && weekday !== 6) return d;
    d = shiftDays(d, -1);
  }
}

const name = (key: PersonKey) => `${PEOPLE[key].firstName} ${PEOPLE[key].lastName}`;
const displayOf = (actor: PersonKey | 'system') => (actor === 'system' ? 'System' : name(actor));

const OFFICE_IP: Record<string, string> = { DAL: '198.51.100.21', FTW: '198.51.100.41', AUS: '198.51.100.61' };
const LOCATION_CODE = new Map<string, string>(LOCATIONS.map((l) => [l.id, l.code]));
const AGENTS = [
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
];

/** Office address of the actor's location (occasionally a home connection) and a stable browser. */
function clientOf(actor: PersonKey | 'system', key: string): { ip: string | null; userAgent: string | null } {
  if (actor === 'system') return { ip: null, userAgent: null };
  const h = hashOf(`client:${actor}:${key.split(':')[0]}`);
  const office = OFFICE_IP[LOCATION_CODE.get(PEOPLE[actor].locationId) ?? 'DAL']!;
  return {
    ip: h[0]! % 9 === 0 ? `203.0.113.${10 + (h[1]! % 200)}` : office,
    userAgent: AGENTS[hashOf(`agent:${actor}`)[0]! % AGENTS.length]!,
  };
}

const managersOf = (person: PersonKey): PersonKey[] =>
  [...new Set(TEAMS.filter((t) => (t.members as readonly string[]).includes(person)).flatMap((t) => t.managers))];
const teamOf = (person: PersonKey) => TEAMS.find((t) => (t.members as readonly string[]).includes(person));

/** Certificate numbers in issue order per year, matching the certification and notification seeds. */
function certificateNumber(person: PersonKey, index: number): string {
  const issued = JOURNEYS.flatMap((j) => (j.certificates ?? []).map((c, i) => ({ person: j.person, index: i, at: new Date(c.issuedAt) }))).sort(
    (a, b) => a.at.getTime() - b.at.getTime(),
  );
  const self = issued.find((c) => c.person === person && c.index === index)!;
  const sequence = issued.filter((c) => c.at.getUTCFullYear() === self.at.getUTCFullYear() && c.at <= self.at).length;
  return `A5-${CERTIFICATION.code}-${self.at.getUTCFullYear()}-${String(sequence).padStart(6, '0')}`;
}

const roleId = (key: string) => seedId(`role:${key}`);
const FIRST_DAY = '2024-09-23';

/** Administrative history of the A5 organization, oldest first. */
export function auditHistory(): Entry[] {
  const e: Entry[] = [];
  const add = (entry: Entry) => {
    e.push(entry);
  };
  const lessonTitle = (key: string) => PHASES.flatMap((p) => p.modules.flatMap((m) => m.lessons)).find((l) => l.key === key)!;

  // ------------------------------------------------------------ platform setup (identity)
  add({
    key: 'org-settings-1',
    day: FIRST_DAY,
    actor: 'priya',
    service: 'identity-service',
    action: 'organization.settings_changed',
    resourceType: 'organization',
    resourceId: ORGANIZATION.id,
    before: { name: 'A5 Roofing', timezone: 'America/New_York', supportEmail: null },
    after: { name: ORGANIZATION.name, timezone: ORGANIZATION.timezone, supportEmail: `sales-enablement@${ORGANIZATION.emailDomain}` },
  });
  add({
    key: 'org-security-1',
    day: FIRST_DAY,
    actor: 'priya',
    service: 'identity-service',
    action: 'organization.security_changed',
    resourceType: 'organization',
    resourceId: ORGANIZATION.id,
    before: { passwordMinLength: 10, lockoutThreshold: 10, sessionIdleMinutes: 120 },
    after: { passwordMinLength: 12, lockoutThreshold: 5, sessionIdleMinutes: 60 },
    reason: 'Align with the company information security policy',
  });
  for (const team of TEAMS) {
    add({
      key: `team-created:${team.id}`,
      day: shiftDays(FIRST_DAY, 1),
      actor: 'grant',
      service: 'identity-service',
      action: 'team.created',
      resourceType: 'team',
      resourceId: team.id,
      after: { name: team.name, managerIds: team.managers.map((m) => PEOPLE[m].id), locationId: team.locationId },
    });
  }
  add({
    key: 'flag:manager_approvals',
    day: shiftDays(FIRST_DAY, 2),
    actor: 'priya',
    service: 'identity-service',
    action: 'feature_flag.changed',
    resourceType: 'feature_flag',
    resourceId: 'manager_approvals',
    before: { enabled: false },
    after: { enabled: true },
  });
  add({
    key: 'flag:certification_expiration',
    day: shiftDays(FIRST_DAY, 2),
    actor: 'priya',
    service: 'identity-service',
    action: 'feature_flag.changed',
    resourceType: 'feature_flag',
    resourceId: 'certification_expiration',
    before: { enabled: false },
    after: { enabled: true },
  });
  add({
    key: 'roles-shelby',
    day: '2024-09-25',
    actor: 'priya',
    service: 'identity-service',
    action: 'user.roles_changed',
    resourceType: 'user',
    resourceId: PEOPLE.shelby.id,
    before: { roles: ['training_admin'] },
    after: { roleIds: [roleId('training_admin'), roleId('trainer')] },
    reason: 'Shelby coaches new hires directly',
  });
  add({
    key: 'roles-ruth',
    day: '2024-11-04',
    actor: 'priya',
    service: 'identity-service',
    action: 'user.roles_changed',
    resourceType: 'user',
    resourceId: PEOPLE.ruth.id,
    before: { roles: [] },
    after: { roleIds: [roleId('auditor')] },
    reason: 'Compliance review of training records',
  });
  add({
    key: 'role-perms-manager-1',
    day: '2025-02-10',
    actor: 'priya',
    service: 'identity-service',
    action: 'role.permissions_changed',
    resourceType: 'role',
    resourceId: roleId('manager'),
    before: { added: [], removed: [] },
    after: { added: ['reports.export'], removed: [] },
    reason: 'Managers export their own team’s progress for weekly reviews',
    metadata: { roleKey: 'manager' },
  });
  add({
    key: 'role-perms-trainer-1',
    day: '2025-06-17',
    actor: 'priya',
    service: 'identity-service',
    action: 'role.permissions_changed',
    resourceType: 'role',
    resourceId: roleId('trainer'),
    before: { added: [], removed: [] },
    after: { added: ['assessment_attempts.grade'], removed: [] },
    reason: 'Trainers grade open-answer questions for their trainees',
    metadata: { roleKey: 'trainer' },
  });
  add({
    key: 'flag:leaderboards',
    day: '2025-09-03',
    actor: 'priya',
    service: 'identity-service',
    action: 'feature_flag.changed',
    resourceType: 'feature_flag',
    resourceId: 'leaderboards',
    before: { enabled: false },
    after: { enabled: true },
  });
  add({
    key: 'flag:leaderboards-off',
    day: '2025-09-17',
    actor: 'priya',
    service: 'identity-service',
    action: 'feature_flag.changed',
    resourceType: 'feature_flag',
    resourceId: 'leaderboards',
    before: { enabled: true },
    after: { enabled: false },
    reason: 'Managers asked to review team rankings before they are shown to reps',
  });

  // ------------------------------------------------------------ people (identity)
  const hires = (Object.keys(PEOPLE) as PersonKey[])
    .filter((k) => PEOPLE[k].hiredAt >= '2024-09-23' && k !== 'priya')
    .sort((a, b) => PEOPLE[a].hiredAt.localeCompare(PEOPLE[b].hiredAt));
  for (const person of hires) {
    const p = PEOPLE[person];
    const day = previousWorkday(p.hiredAt);
    const team = teamOf(person);
    add({
      key: `user-created:${person}`,
      day,
      actor: 'grant',
      service: 'identity-service',
      action: 'user.created',
      resourceType: 'user',
      resourceId: p.id,
      after: { email: emailOf(p), name: name(person), roleIds: p.roles.map(roleId), teamIds: team ? [team.id] : [] },
    });
    if (team) {
      add({
        key: `team-members:${person}`,
        day,
        actor: 'grant',
        service: 'identity-service',
        action: 'team.members_changed',
        resourceType: 'team',
        resourceId: team.id,
        after: { added: [p.id], removed: [] },
        metadata: { teamName: team.name },
      });
    }
    const trainer = TRAINER_ASSIGNMENTS.find((a) => a.trainees.includes(person));
    if (trainer) {
      add({
        key: `user-trainer:${person}`,
        day: p.hiredAt,
        actor: 'grant',
        service: 'identity-service',
        action: 'user.updated',
        resourceType: 'user',
        resourceId: p.id,
        before: { trainerIds: [] },
        after: { trainerIds: [PEOPLE[trainer.trainer].id], managerIds: managersOf(person).map((m) => PEOPLE[m].id) },
        reason: `${PEOPLE[trainer.trainer].firstName} coaches this cohort`,
      });
    }
  }
  add({
    key: 'invite-resent:tyler',
    day: '2026-09-01',
    actor: 'grant',
    service: 'identity-service',
    action: 'user.invitation_resent',
    resourceType: 'user',
    resourceId: PEOPLE.tyler.id,
    metadata: { note: 'The first activation link expired over the weekend' },
  });
  add({
    key: 'invite-resent:devon',
    day: '2026-09-29',
    actor: 'grant',
    service: 'identity-service',
    action: 'user.invitation_resent',
    resourceType: 'user',
    resourceId: PEOPLE.devon.id,
  });
  add({
    key: 'sessions-revoked:naomi',
    day: '2026-08-19',
    actor: 'grant',
    service: 'identity-service',
    action: 'user.sessions_revoked',
    resourceType: 'user',
    resourceId: PEOPLE.naomi.id,
    reason: 'Reported a lost phone; all signed-in devices were signed out',
  });
  add({
    key: 'user-moved:kayla',
    day: '2026-09-16',
    actor: 'grant',
    service: 'identity-service',
    action: 'user.updated',
    resourceType: 'user',
    resourceId: PEOPLE.kayla.id,
    before: { jobTitle: 'Sales Representative', phone: null },
    after: { jobTitle: 'Sales Representative', phone: PEOPLE.kayla.phone },
  });
  add({
    key: 'password-reset:marcus',
    day: '2026-09-09',
    actor: 'marcus',
    service: 'identity-service',
    action: 'user.password_reset',
    resourceType: 'user',
    resourceId: PEOPLE.marcus.id,
  });
  add({
    key: 'password-changed:brianna',
    day: '2026-08-12',
    actor: 'brianna',
    service: 'identity-service',
    action: 'user.password_changed',
    resourceType: 'user',
    resourceId: PEOPLE.brianna.id,
  });
  add({
    key: 'token-reuse:jordan',
    day: '2026-09-22',
    actor: 'system',
    service: 'identity-service',
    action: 'session.refresh_token_reused',
    resourceType: 'session',
    resourceId: seedId('session:jordan:2026-09-22'),
    metadata: { userId: PEOPLE.jordan.id, outcome: 'session family revoked' },
    reason: 'A refresh token was presented twice; the session was revoked',
  });

  // ------------------------------------------------------------ program (learning)
  add({
    key: 'program-created',
    day: '2024-09-23',
    actor: 'shelby',
    service: 'learning-service',
    action: 'program.created',
    resourceType: 'program',
    resourceId: PROGRAM.id,
    after: { title: PROGRAM.title, category: PROGRAM.category, phaseLabel: PROGRAM.phaseLabel },
  });
  const publishes: Array<{ day: string; version: number; note: string; changes: string[] }> = [
    { day: '2024-10-14', version: 1, note: 'First cohort', changes: ['Four weeks, 4 knowledge checks, 10 AI scenarios'] },
    { day: '2025-02-18', version: 2, note: 'Insurance claims content reworked', changes: ['w2-claims', 'w2-adjusters'] },
    { day: '2025-05-27', version: 3, note: 'Compliance article updated after legal review', changes: ['w4-compliance'] },
    { day: '2026-01-13', version: 4, note: 'Discovery questions refreshed', changes: ['w3-discovery', 'w3-framework'] },
    { day: '2026-06-30', version: 5, note: 'Ahead of the July cohort', changes: ['w3-practice-estimates', 'w4-practice-cheaper'] },
  ];
  for (const pub of publishes) {
    add({
      key: `program-published:${pub.version}`,
      day: pub.day,
      actor: 'shelby',
      service: 'learning-service',
      action: 'program.published',
      resourceType: 'program',
      resourceId: PROGRAM.id,
      before: { version: pub.version - 1 },
      after: { version: pub.version, requiredLessons: PHASES.flatMap((p) => p.modules.flatMap((m) => m.lessons)).filter((l) => l.required).length },
      reason: pub.note,
      metadata: { changedLessons: pub.changes },
    });
  }
  for (const [day, key, from, to] of [
    ['2025-02-14', 'w2-claims', 'How a Claim Works', 'How a Homeowner Claim Works'],
    ['2026-01-09', 'w3-discovery', 'Discovery Questions', 'Discovery Questions That Uncover Real Concerns'],
    ['2026-06-26', 'w4-practice-cheaper', 'Practice: Price Objection', 'Practice: "Another roofer is cheaper"'],
  ] as const) {
    const l = lessonTitle(key);
    add({
      key: `lesson-updated:${key}`,
      day,
      actor: 'shelby',
      service: 'learning-service',
      action: 'lesson.updated',
      resourceType: 'lesson',
      resourceId: l.id,
      before: { title: from },
      after: { title: to, estimatedMinutes: l.minutes },
    });
  }

  // ------------------------------------------------------------ enrollments and approvals (learning)
  for (const j of JOURNEYS) {
    const day = isoDay(new Date(j.enrolledAt));
    const assigner = managersOf(j.person)[0] ?? 'shelby';
    add({
      key: `enrollment-created:${j.person}`,
      day,
      actor: assigner,
      service: 'learning-service',
      action: 'enrollment.created',
      resourceType: 'enrollment',
      resourceId: seedId(`enrollment:${j.person}`),
      after: { userId: PEOPLE[j.person].id, programId: PROGRAM.id, source: 'manual', dueInDays: PROGRAM.durationDays },
    });
  }
  add({
    key: 'enrollment-extended:tyler',
    day: '2026-09-08',
    actor: 'danielle',
    service: 'learning-service',
    action: 'enrollment.due_date_changed',
    resourceType: 'enrollment',
    resourceId: seedId('enrollment:tyler'),
    before: { dueAt: '2026-09-28T17:00:00.000Z' },
    after: { dueAt: '2026-10-05T17:00:00.000Z' },
    reason: 'Out the week of September 1 for a family emergency',
  });
  for (const j of JOURNEYS.filter((x) => x.certificates?.length)) {
    const cert = j.certificates![0]!;
    const manager = managersOf(j.person)[0]!;
    add({
      key: `signoff:${j.person}`,
      day: shiftDays(isoDay(new Date(cert.issuedAt)), -2),
      actor: manager,
      service: 'learning-service',
      action: 'approval.decided',
      resourceType: 'approval',
      resourceId: seedId(`approval:${j.person}:signoff`),
      before: { status: 'pending' },
      after: { status: 'approved', lesson: 'Manager Field-Ready Sign-off', userId: PEOPLE[j.person].id },
      reason: `Ride-along looked field ready; ${PEOPLE[j.person].firstName} handled objections well`,
    });
  }

  // ------------------------------------------------------------ assessments and AI (assessment, ai-coaching)
  const finalExam = ASSESSMENTS.find((a) => a.key === 'final')!;
  add({
    key: 'assessment-final-passmark',
    day: '2025-03-11',
    actor: 'shelby',
    service: 'assessment-service',
    action: 'assessment.updated',
    resourceType: 'assessment',
    resourceId: finalExam.id,
    before: { passingPercent: 80 },
    after: { passingPercent: finalExam.passingPercent },
    reason: 'Raise the bar for field readiness after the first cohort results',
  });
  add({
    key: 'attempt-override:sofia',
    day: '2024-11-12',
    actor: 'hector',
    service: 'assessment-service',
    action: 'attempt.score_overridden',
    resourceType: 'attempt',
    resourceId: seedId('attempt:sofia:quiz-w2:1'),
    before: { scorePercent: 78, passed: false },
    after: { scorePercent: 80, passed: true },
    reason: 'Regraded open answer 4 against the rubric',
    metadata: { assessmentId: ASSESSMENTS.find((a) => a.key === 'quiz-w2')!.id, userId: PEOPLE.sofia.id },
  });
  const cheaper = SCENARIOS.find((s) => s.key === 'cheaper')!;
  add({
    key: 'scenario-passing:cheaper',
    day: '2025-09-09',
    actor: 'shelby',
    service: 'ai-coaching-service',
    action: 'ai_scenario.updated',
    resourceType: 'ai_scenario',
    resourceId: cheaper.id,
    before: { passingScore: 75 },
    after: { passingScore: cheaper.passingScore },
    reason: 'Advanced scenarios need a higher bar',
  });
  add({
    key: 'ai-prompt-published',
    day: '2026-02-24',
    actor: 'shelby',
    service: 'ai-coaching-service',
    action: 'ai_prompt_version.published',
    resourceType: 'ai_scenario',
    resourceId: SCENARIOS.find((s) => s.key === 'not-signing')!.id,
    before: { version: 1 },
    after: { version: 2 },
    reason: 'Homeowner pushes back harder on signing before the inspection',
  });
  add({
    key: 'ai-settings',
    day: '2025-11-18',
    actor: 'priya',
    service: 'ai-coaching-service',
    action: 'ai_settings.updated',
    resourceType: 'ai_settings',
    resourceId: ORGANIZATION.id,
    before: { dailySessionLimit: 5 },
    after: { dailySessionLimit: 8 },
    reason: 'Reps were hitting the daily limit during week 3',
  });

  // ------------------------------------------------------------ certification
  add({
    key: 'signatory-priya',
    day: '2024-10-07',
    actor: 'priya',
    service: 'certification-service',
    action: 'signatory.created',
    resourceType: 'signatory',
    resourceId: SIGNATORIES[0].id,
    after: { name: name('priya'), title: SIGNATORIES[0].title },
  });
  add({
    key: 'signatory-shelby',
    day: '2024-10-07',
    actor: 'priya',
    service: 'certification-service',
    action: 'signatory.created',
    resourceType: 'signatory',
    resourceId: SIGNATORIES[1].id,
    after: { name: name('shelby'), title: SIGNATORIES[1].title },
  });
  add({
    key: 'stamp-seal',
    day: '2024-10-07',
    actor: 'priya',
    service: 'certification-service',
    action: 'stamp.created',
    resourceType: 'stamp',
    resourceId: STAMPS[0].id,
    after: { name: STAMPS[0].name },
  });
  add({
    key: 'certification-defined',
    day: '2024-10-08',
    actor: 'shelby',
    service: 'certification-service',
    action: 'certification.created',
    resourceType: 'certification',
    resourceId: CERTIFICATION.id,
    after: {
      name: CERTIFICATION.name,
      validityMonths: CERTIFICATION.validityMonths,
      requiredAiSessions: CERTIFICATION.requiredAiSessions,
      aiAverage: CERTIFICATION.aiAverage,
      finalMinimum: CERTIFICATION.finalMinimum,
    },
  });
  add({
    key: 'certification-final-minimum',
    day: '2025-03-11',
    actor: 'shelby',
    service: 'certification-service',
    action: 'certification.updated',
    resourceType: 'certification',
    resourceId: CERTIFICATION.id,
    before: { finalMinimum: 80 },
    after: { finalMinimum: CERTIFICATION.finalMinimum },
    reason: 'Matches the new pass mark of the final assessment',
  });
  add({
    key: 'template-published',
    day: '2025-03-03',
    actor: 'shelby',
    service: 'certification-service',
    action: 'certificate_template.published',
    resourceType: 'certificate_template',
    resourceId: CERTIFICATE_TEMPLATES[0].id,
    before: { version: 1 },
    after: { version: 2 },
    reason: 'Added the official seal',
  });
  add({
    key: 'certification-settings',
    day: '2025-04-22',
    actor: 'priya',
    service: 'certification-service',
    action: 'certification_settings.updated',
    resourceType: 'certification_settings',
    resourceId: ORGANIZATION.id,
    before: { reminderOffsetsDays: [30, 7] },
    after: { reminderOffsetsDays: [90, 60, 30, 7] },
    reason: 'Give reps and managers more lead time to renew',
  });
  for (const j of JOURNEYS.filter((x) => x.certificates?.length)) {
    const approver = managersOf(j.person)[0]!;
    j.certificates!.forEach((cert, index) => {
      const day = isoDay(new Date(cert.issuedAt));
      const certId = seedId(`certificate:${j.person}:${index + 1}`);
      const number = certificateNumber(j.person, index);
      if (index === 0) {
        add({
          key: `cert-approval:${j.person}`,
          day: shiftDays(day, -1),
          actor: approver,
          service: 'certification-service',
          action: 'certificate_approval.decided',
          resourceType: 'certificate_approval',
          resourceId: seedId(`certificate-approval:${j.person}`),
          before: { status: 'pending' },
          after: { status: 'approved', userId: PEOPLE[j.person].id, definitionId: CERTIFICATION.id },
          reason: 'All requirements met',
        });
      }
      add({
        key: `cert-issued:${j.person}:${index + 1}`,
        day,
        actor: index === 0 ? 'system' : 'shelby',
        service: 'certification-service',
        action: index === 0 ? 'certificate.issued' : 'certificate.reissued',
        resourceType: 'certificate',
        resourceId: certId,
        after: { certificateNumber: number, userId: PEOPLE[j.person].id, definitionId: CERTIFICATION.id, status: 'issued' },
        ...(index === 0 ? {} : { before: { certificateId: seedId(`certificate:${j.person}:${index}`), status: 'issued' }, reason: j.certificates![index - 1]!.reissueReason ?? 'Corrected certificate details' }),
        metadata: { mode: index === 0 ? 'approval' : 'reissue', certificateNumber: number },
      });
      if (index > 0) {
        add({
          key: `cert-superseded:${j.person}:${index}`,
          day,
          actor: 'system',
          service: 'certification-service',
          action: 'certificate.superseded',
          resourceType: 'certificate',
          resourceId: seedId(`certificate:${j.person}:${index}`),
          before: { status: 'issued' },
          after: { status: 'superseded', replacedBy: certId },
        });
      }
    });
  }

  // ------------------------------------------------------------ notifications and media
  add({
    key: 'template-edit',
    day: '2026-03-03',
    actor: 'grant',
    service: 'notification-service',
    action: 'notification_template.updated',
    resourceType: 'notification_template',
    resourceId: seedId('notification_template:assessment.failed:in_app'),
    before: { subject: '{{assessmentTitle}}: {{scorePercent}}%, not passed yet' },
    after: { subject: 'Keep going on {{assessmentTitle}} ({{scorePercent}}%)' },
    metadata: { type: 'assessment.failed', channel: 'in_app' },
  });
  add({
    key: 'template-reset',
    day: '2026-03-10',
    actor: 'grant',
    service: 'notification-service',
    action: 'notification_template.reset',
    resourceType: 'notification_template',
    resourceId: seedId('notification_template:assessment.failed:in_app'),
    before: { subject: 'Keep going on {{assessmentTitle}} ({{scorePercent}}%)' },
    after: { subject: '{{assessmentTitle}}: {{scorePercent}}%, not passed yet' },
    reason: 'Reps found the original wording clearer',
    metadata: { type: 'assessment.failed', channel: 'in_app' },
  });
  add({
    key: 'rule-edit',
    day: '2026-05-19',
    actor: 'priya',
    service: 'notification-service',
    action: 'notification_rule.updated',
    resourceType: 'notification_rule',
    resourceId: seedId('notification_rule:assessment.failed.manager'),
    before: { recipients: ['managers'], channels: ['in_app'] },
    after: { recipients: ['managers', 'trainers'], channels: ['in_app'] },
    metadata: { key: 'assessment.failed.manager', eventType: 'assessment.attempt.graded' },
  });
  add({
    key: 'media-deleted',
    day: '2025-08-12',
    actor: 'shelby',
    service: 'media-service',
    action: 'media_asset.deleted',
    resourceType: 'media_asset',
    resourceId: seedId('media:w1-welcome:draft'),
    before: { title: 'Welcome from Leadership (draft cut)', status: 'ready' },
    reason: 'Replaced by the final recording',
  });

  // ------------------------------------------------------------ audit access itself
  for (const [day, from, to, rows] of [
    ['2025-11-04', '2025-07-01', '2025-09-30', 41],
    ['2026-07-01', '2026-01-01', '2026-06-30', 118],
    ['2026-09-30', '2026-07-01', '2026-09-30', 96],
  ] as const) {
    add({
      key: `audit-export:${day}`,
      day,
      actor: 'ruth',
      service: 'audit-service',
      action: 'audit_logs.exported',
      resourceType: 'audit_log',
      resourceId: null,
      metadata: { format: 'csv', filters: { from, to }, matchedEntries: rows },
    });
  }

  return e.filter((x) => x.day >= FIRST_DAY && x.day < isoDay(SEED_NOW)).sort((a, b) => a.day.localeCompare(b.day) || a.key.localeCompare(b.key));
}

/**
 * Seed the audit trail of the A5 organization with its administrative history (ids and
 * timestamps are deterministic). Creates the monthly partitions the history needs first.
 * Idempotent: existing entries are skipped.
 */
export async function seedAudit(db: Db, options: SeedOptions = {}): Promise<{ entries: number; partitions: string[] }> {
  const log = options.log ?? (() => undefined);
  const history = auditHistory().map((entry) => {
    const occurredAt = timeOf(entry.day, entry.key);
    const client = clientOf(entry.actor, entry.key);
    const requestId = `req_${seedUuidV7(occurredAt, `request:${entry.key}`).replace(/-/g, '').slice(0, 20)}`;
    return { entry, occurredAt, client, requestId };
  });
  const first = history[0]!.occurredAt;
  const last = history[history.length - 1]!.occurredAt;

  const partitions = await ensurePartitions(db as never, monthsBetween(first, last));
  partitions.push(...(await ensureUpcomingPartitions(db as never, options.monthsAhead ?? 3, SEED_NOW)));

  let entries = 0;
  const batchSize = 100;
  for (let i = 0; i < history.length; i += batchSize) {
    const batch = history.slice(i, i + batchSize);
    const result = await db
      .insertInto('audit_logs')
      .values(
        batch.map(({ entry, occurredAt, client, requestId }) => ({
          id: seedUuidV7(occurredAt, `entry:${entry.key}`),
          organization_id: ORGANIZATION.id,
          occurred_at: occurredAt,
          actor_type: entry.actor === 'system' ? ('system' as const) : ('user' as const),
          actor_id: entry.actor === 'system' ? null : PEOPLE[entry.actor].id,
          actor_display: displayOf(entry.actor),
          action: entry.action,
          resource_type: entry.resourceType,
          resource_id: entry.resourceId,
          before: jsonOrNull(entry.before),
          after: jsonOrNull(entry.after),
          reason: entry.reason ?? null,
          ip: client.ip,
          user_agent: client.userAgent,
          request_id: requestId,
          correlation_id: requestId,
          service: entry.service,
          metadata: JSON.stringify(entry.metadata ?? {}),
        })),
      )
      .onConflict((oc) => oc.columns(['id', 'occurred_at']).doNothing())
      .executeTakeFirst();
    entries += Number(result.numInsertedOrUpdatedRows ?? 0n);
  }
  log(`audit: ${entries} entries seeded (${history.length - entries} already present), ${partitions.length} partitions created`);
  return { entries, partitions };
}
