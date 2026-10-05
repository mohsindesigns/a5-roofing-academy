import type { notification } from '@a5/contracts';
import type { EventPayload, EventType } from '@a5/events';

type Channel = notification.NotificationChannel;
type Category = notification.NotificationCategory;
type Priority = notification.NotificationPriority;
type Recipient = notification.Recipient;
type Conditions = notification.RuleConditions;
export type NotificationTypeKey = notification.NotificationType;

export interface TemplateContent {
  /** Email subject, or in-app title. */
  subject: string;
  body: string;
}

export interface VariableDef {
  name: string;
  description: string;
  sample: string;
}

export interface BuildContext {
  /** Public web origin without trailing slash, e.g. `https://academy.a5roofing.com`. */
  appUrl: string;
  formatDate(iso: string): string;
  formatDateTime(iso: string): string;
  /** Display name of a user referenced by the payload (resolved from the directory). */
  nameOf(userId: string | null | undefined, fallback: string): string;
}

export interface BuiltNotification {
  /** Template variables that may be stored and shown (in-app rows, email log). */
  vars: Record<string, string>;
  /** Path inside the web app the notification points to. */
  path: string | null;
  /**
   * Absolute one-time URL (activation, password reset). It becomes `{{link}}` and the button of
   * the email, is sealed until delivery and is never stored readable. Overrides `path`.
   */
  secretLink?: string;
  /** Structured, non-sensitive references stored with the in-app notification. */
  data: Record<string, unknown>;
}

export interface NotificationTypeDef {
  key: NotificationTypeKey;
  label: string;
  description: string;
  category: Category;
  /** Who typically receives it; manager-facing types are hidden from other people's preferences. */
  audience: 'learner' | 'manager';
  eventType: EventType;
  channels: Channel[];
  /** Security messages: always sent, cannot be disabled by rules or preferences. */
  mandatory: boolean;
  /** Content contains secrets; never stored readable. */
  sensitive: boolean;
  actionLabel: string;
  /** Conditions that define this notification; always applied in addition to the rule's. */
  fixedConditions: Conditions;
  /** Payload fields holding user ids whose display names the builder needs. */
  nameFields: string[];
  variables: VariableDef[];
  defaults: Partial<Record<Channel, TemplateContent>>;
  rule: { recipients: Recipient[]; channels: Channel[]; conditions: Conditions; priority: Priority; delayMinutes: number };
  build(payload: unknown, ctx: BuildContext): BuiltNotification;
}

export interface EventDescriptor {
  type: EventType;
  /** Payload path of the person the event is about. */
  subjectPath: string | null;
  /** Payload path of the program the event belongs to. */
  programPath: string | null;
}

/** Events the notification engine reacts to. */
export const EVENT_DESCRIPTORS: Record<string, EventDescriptor> = Object.fromEntries(
  (
    [
      ['user.created', 'userId', null],
      ['identity.invitation.created', 'userId', null],
      ['identity.password_reset.requested', 'userId', null],
      ['program.enrolled', 'userId', 'programId'],
      ['enrollment.overdue', 'userId', 'programId'],
      ['program.published', null, 'programId'],
      ['assessment.attempt.graded', 'userId', 'context.programId'],
      ['approval.requested', 'userId', 'programId'],
      ['approval.decided', 'userId', 'programId'],
      ['ai.score.generated', 'userId', 'context.programId'],
      ['ai.session.reviewed', 'userId', null],
      ['certificate.eligible', 'userId', null],
      ['certificate.approval_requested', 'userId', null],
      ['certificate.approval_decided', 'userId', null],
      ['certificate.issued', 'userId', null],
      ['certificate.generated', 'userId', null],
      ['certificate.expiring', 'userId', null],
      ['certificate.expired', 'userId', null],
      ['certificate.revoked', 'userId', null],
      ['certificate.renewal_required', 'userId', null],
    ] as Array<[EventType, string | null, string | null]>
  ).map(([type, subjectPath, programPath]) => [type, { type, subjectPath, programPath }]),
);

/** Recipient kinds that make sense for an event (role:<key> is always allowed). */
export function allowedRecipientKinds(eventType: string): string[] {
  const d = EVENT_DESCRIPTORS[eventType];
  if (!d) return ['role:<key>'];
  const kinds: string[] = [];
  if (d.subjectPath) kinds.push('subject', 'managers', 'team_managers', 'trainers');
  if (d.programPath) kinds.push('enrolled_learners');
  kinds.push('role:<key>');
  return kinds;
}

// ---------------------------------------------------------------- helpers

/** Variables every template can use. */
export const COMMON_VARIABLES: VariableDef[] = [
  { name: 'recipientFirstName', description: 'First name of the person receiving the message', sample: 'Andre' },
  { name: 'recipientName', description: 'Full name of the person receiving the message', sample: 'Andre Coleman' },
  { name: 'link', description: 'Full URL of the page the message points to', sample: 'https://academy.a5roofing.example/training' },
  { name: 'appUrl', description: 'Address of the A5 Sales Academy', sample: 'https://academy.a5roofing.example' },
];

/** Variables available when the event is about a specific person. */
export const LEARNER_VARIABLES: VariableDef[] = [
  { name: 'learnerName', description: 'Full name of the person the event is about', sample: 'Brianna Castillo' },
  { name: 'learnerFirstName', description: 'First name of the person the event is about', sample: 'Brianna' },
];

const v = (name: string, description: string, sample: string): VariableDef => ({ name, description, sample });

function score(n: number): string {
  return String(Math.round(n * 10) / 10);
}

function quoted(comment: string | null | undefined): string {
  const c = comment?.trim();
  return c ? `Their note: “${c}” ` : '';
}

const programVars = [v('programTitle', 'Program title', 'A5 New Hire Sales Academy')];
const assessmentVars = [
  v('assessmentTitle', 'Assessment title', 'Week 2 Knowledge Check'),
  v('scorePercent', 'Score in percent', '74'),
  v('passingPercent', 'Pass mark in percent', '80'),
  v('attemptNumber', 'Attempt number', '1'),
];
const certVars = [
  v('definitionName', 'Certification name', 'A5 Roofing Certified Sales Representative'),
  v('certificateNumber', 'Certificate number', 'A5-SALES-2026-000014'),
];

const training = (programId: string) => `/training/${programId}`;
const teamMember = (userId: string) => `/team/people/${userId}`;
const certificate = (certificateId: string) => `/certifications/${certificateId}`;
const aiSession = (sessionId: string) => `/ai-practice/sessions/${sessionId}`;

type Def<E extends EventType> = Omit<NotificationTypeDef, 'build' | 'eventType' | 'mandatory' | 'sensitive' | 'fixedConditions' | 'nameFields' | 'rule'> & {
  eventType: E;
  mandatory?: boolean;
  sensitive?: boolean;
  fixedConditions?: Conditions;
  nameFields?: string[];
  rule: Omit<NotificationTypeDef['rule'], 'conditions' | 'delayMinutes'> & { conditions?: Conditions; delayMinutes?: number };
  build(payload: EventPayload<E>, ctx: BuildContext): BuiltNotification;
};

function define<E extends EventType>(def: Def<E>): NotificationTypeDef {
  return {
    ...def,
    mandatory: def.mandatory ?? false,
    sensitive: def.sensitive ?? false,
    fixedConditions: def.fixedConditions ?? {},
    nameFields: def.nameFields ?? [],
    rule: { conditions: {}, delayMinutes: 0, ...def.rule },
    build: (payload, ctx) => def.build(payload as EventPayload<E>, ctx),
  };
}

// ---------------------------------------------------------------- catalog

export const NOTIFICATION_TYPE_DEFS: NotificationTypeDef[] = [
  // ------------------------------------------------------------ account
  define({
    key: 'account.welcome',
    label: 'Welcome message',
    description: 'Greets a new team member when their account is created.',
    category: 'account',
    audience: 'learner',
    eventType: 'user.created',
    channels: ['in_app'],
    actionLabel: 'Open My Training',
    variables: [],
    defaults: {
      in_app: {
        subject: 'Welcome to the A5 Sales Academy, {{recipientFirstName}}',
        body: 'Your training plan, knowledge checks and AI role-play practice live here. Start with My Training to see what is assigned to you.',
      },
    },
    rule: { recipients: ['subject'], channels: ['in_app'], priority: 'normal' },
    build: () => ({ vars: {}, path: '/training', data: {} }),
  }),
  define({
    key: 'account.invitation',
    label: 'Account activation',
    description: 'Sends the activation link to a newly invited person.',
    category: 'account',
    audience: 'learner',
    eventType: 'identity.invitation.created',
    channels: ['email'],
    mandatory: true,
    sensitive: true,
    actionLabel: 'Activate my account',
    variables: [
      v('inviterName', 'Who sent the invitation', 'Grant Holloway'),
      v('expiresAt', 'When the activation link stops working', 'Oct 8, 2026, 10:00 AM CDT'),
    ],
    defaults: {
      email: {
        subject: 'Activate your A5 Sales Academy account',
        body: [
          'Hi {{recipientFirstName}},',
          '{{inviterName}} invited you to the A5 Roofing Sales Academy, where you will complete your onboarding training, knowledge checks and AI role-play practice.',
          'Choose your password to activate your account. The link works once and expires {{expiresAt}}.',
          'Not expecting this invitation? You can ignore this email, or let your manager know.',
        ].join('\n\n'),
      },
    },
    rule: { recipients: ['subject'], channels: ['email'], priority: 'high' },
    build: (p, ctx) => ({
      vars: { inviterName: p.invitedByName ?? 'A5 Roofing', expiresAt: ctx.formatDateTime(p.expiresAt) },
      secretLink: p.activationUrl,
      path: null,
      data: {},
    }),
  }),
  define({
    key: 'account.password_reset',
    label: 'Password reset',
    description: 'Sends a password reset link when someone asks for one.',
    category: 'account',
    audience: 'learner',
    eventType: 'identity.password_reset.requested',
    channels: ['email'],
    mandatory: true,
    sensitive: true,
    actionLabel: 'Reset my password',
    variables: [v('expiresAt', 'When the reset link stops working', 'Oct 5, 2026, 10:30 AM CDT')],
    defaults: {
      email: {
        subject: 'Reset your A5 Sales Academy password',
        body: [
          'Hi {{recipientFirstName}},',
          'We received a request to reset your password. Use the button below to choose a new one. The link works once and expires {{expiresAt}}.',
          'Did not ask for this? Ignore this email and your password stays the same.',
        ].join('\n\n'),
      },
    },
    rule: { recipients: ['subject'], channels: ['email'], priority: 'high' },
    build: (p, ctx) => ({
      vars: { expiresAt: ctx.formatDateTime(p.expiresAt) },
      secretLink: p.resetUrl,
      path: null,
      data: {},
    }),
  }),

  // ------------------------------------------------------------ training
  define({
    key: 'training.assigned',
    label: 'Training assigned',
    description: 'Tells a learner they were enrolled in a program.',
    category: 'training',
    audience: 'learner',
    eventType: 'program.enrolled',
    channels: ['in_app', 'email'],
    nameFields: ['assignedBy'],
    actionLabel: 'Start training',
    variables: [
      ...programVars,
      v('dueDate', 'Due date, or "no due date"', 'Oct 30, 2026'),
      v('dueText', 'Sentence about the due date (empty without one)', 'Complete it by Oct 30, 2026.'),
      v('assignedByName', 'Who assigned the training', 'Danielle Okafor'),
      v('enrollmentText', 'Sentence saying how the person was enrolled', 'Danielle Okafor enrolled you in A5 New Hire Sales Academy.'),
    ],
    defaults: {
      in_app: {
        subject: 'New training: {{programTitle}}',
        body: '{{enrollmentText}} {{dueText}}',
      },
      email: {
        subject: 'You are enrolled in {{programTitle}}',
        body: [
          'Hi {{recipientFirstName}},',
          '{{enrollmentText}} {{dueText}}',
          'Open the Academy to see your lessons. Each one builds on the last, so start with the first lesson and keep a steady pace.',
        ].join('\n\n'),
      },
    },
    rule: { recipients: ['subject'], channels: ['in_app', 'email'], priority: 'normal' },
    build: (p, ctx) => {
      const due = p.dueAt ? ctx.formatDate(p.dueAt) : null;
      const assignedByName = p.assignedBy ? ctx.nameOf(p.assignedBy, 'A5 Sales Training') : 'A5 Sales Training';
      const enrollmentText =
        p.source === 'self'
          ? `You enrolled in ${p.programTitle}.`
          : p.assignedBy
            ? `${assignedByName} enrolled you in ${p.programTitle}.`
            : `You were enrolled in ${p.programTitle}.`;
      return {
        vars: {
          programTitle: p.programTitle,
          dueDate: due ?? 'no due date',
          dueText: due ? `Complete it by ${due}.` : '',
          assignedByName,
          enrollmentText,
        },
        path: training(p.programId),
        data: { programId: p.programId, enrollmentId: p.enrollmentId, dueAt: p.dueAt },
      };
    },
  }),
  define({
    key: 'training.overdue',
    label: 'Training overdue',
    description: 'Reminds a learner whose program passed its due date.',
    category: 'training',
    audience: 'learner',
    eventType: 'enrollment.overdue',
    channels: ['in_app', 'email'],
    actionLabel: 'Continue training',
    variables: [...programVars, v('dueDate', 'Due date', 'Sep 28, 2026'), v('progressPercent', 'Progress in percent', '45')],
    defaults: {
      in_app: {
        subject: '{{programTitle}} is overdue',
        body: 'It was due {{dueDate}} and you are {{progressPercent}}% complete. Pick up where you left off today.',
      },
      email: {
        subject: 'Overdue: {{programTitle}}',
        body: [
          'Hi {{recipientFirstName}},',
          '{{programTitle}} was due {{dueDate}}. You are {{progressPercent}}% complete.',
          'Block out time today to finish the remaining lessons. If something is in the way, talk to your manager so they can help.',
        ].join('\n\n'),
      },
    },
    rule: { recipients: ['subject'], channels: ['in_app', 'email'], priority: 'high' },
    build: (p, ctx) => ({
      vars: { programTitle: p.programTitle, dueDate: ctx.formatDate(p.dueAt), progressPercent: score(p.progressPercent) },
      path: training(p.programId),
      data: { programId: p.programId, enrollmentId: p.enrollmentId, progressPercent: p.progressPercent },
    }),
  }),
  define({
    key: 'training.overdue.manager',
    label: 'Team member overdue',
    description: 'Tells managers when someone on their team is overdue.',
    category: 'training',
    audience: 'manager',
    eventType: 'enrollment.overdue',
    channels: ['in_app', 'email'],
    actionLabel: 'View progress',
    variables: [...programVars, v('dueDate', 'Due date', 'Sep 28, 2026'), v('progressPercent', 'Progress in percent', '45')],
    defaults: {
      in_app: {
        subject: '{{learnerName}} is overdue on {{programTitle}}',
        body: 'Due {{dueDate}}, {{progressPercent}}% complete. A quick check-in usually gets things moving again.',
      },
      email: {
        subject: '{{learnerName}} is overdue on {{programTitle}}',
        body: [
          'Hi {{recipientFirstName}},',
          '{{learnerName}} has not finished {{programTitle}}, which was due {{dueDate}}. They are {{progressPercent}}% complete.',
          'A short check-in helps: ask what is blocking them and agree on a date to finish.',
        ].join('\n\n'),
      },
    },
    rule: { recipients: ['managers'], channels: ['in_app', 'email'], priority: 'normal' },
    build: (p, ctx) => ({
      vars: { programTitle: p.programTitle, dueDate: ctx.formatDate(p.dueAt), progressPercent: score(p.progressPercent) },
      path: teamMember(p.userId),
      data: { userId: p.userId, programId: p.programId, enrollmentId: p.enrollmentId, progressPercent: p.progressPercent },
    }),
  }),
  define({
    key: 'training.updated',
    label: 'Training updated',
    description: 'Tells enrolled learners when a program they are taking publishes changes.',
    category: 'training',
    audience: 'learner',
    eventType: 'program.published',
    channels: ['in_app'],
    actionLabel: 'Review changes',
    fixedConditions: { version: { gt: 1 } },
    variables: [...programVars, v('version', 'Published version number', '3')],
    defaults: {
      in_app: {
        subject: '{{programTitle}} was updated',
        body: 'New or revised lessons were published. Review the outline to see what changed in your training.',
      },
    },
    rule: { recipients: ['enrolled_learners'], channels: ['in_app'], priority: 'low' },
    build: (p) => ({
      vars: { programTitle: p.title, version: String(p.version) },
      path: training(p.programId),
      data: { programId: p.programId, version: p.version },
    }),
  }),

  // ------------------------------------------------------------ assessments
  define({
    key: 'assessment.passed',
    label: 'Assessment passed',
    description: 'Confirms a passing score to the learner.',
    category: 'assessments',
    audience: 'learner',
    eventType: 'assessment.attempt.graded',
    channels: ['in_app', 'email'],
    actionLabel: 'Review results',
    fixedConditions: { passed: true },
    variables: assessmentVars,
    defaults: {
      in_app: {
        subject: 'You passed {{assessmentTitle}}',
        body: 'You scored {{scorePercent}}% (pass mark {{passingPercent}}%). Review your answers or move on to your next lesson.',
      },
      email: {
        subject: 'You passed {{assessmentTitle}} with {{scorePercent}}%',
        body: [
          'Hi {{recipientFirstName}},',
          'Nice work: you scored {{scorePercent}}% on {{assessmentTitle}} (pass mark {{passingPercent}}%).',
          'Review the questions you missed while they are fresh, then continue with your next lesson.',
        ].join('\n\n'),
      },
    },
    rule: { recipients: ['subject'], channels: ['in_app'], priority: 'normal' },
    build: (p) => ({
      vars: {
        assessmentTitle: p.assessmentTitle,
        scorePercent: score(p.scorePercent),
        passingPercent: score(p.passingPercent),
        attemptNumber: String(p.attemptNumber),
      },
      path: `/assessments/attempts/${p.attemptId}`,
      data: { attemptId: p.attemptId, assessmentId: p.assessmentId, kind: p.kind, scorePercent: p.scorePercent, passed: true },
    }),
  }),
  define({
    key: 'assessment.failed',
    label: 'Assessment not passed',
    description: 'Tells the learner they did not reach the pass mark and what to do next.',
    category: 'assessments',
    audience: 'learner',
    eventType: 'assessment.attempt.graded',
    channels: ['in_app', 'email'],
    actionLabel: 'Review results',
    fixedConditions: { passed: false },
    variables: assessmentVars,
    defaults: {
      in_app: {
        subject: '{{assessmentTitle}}: {{scorePercent}}%, not passed yet',
        body: 'The pass mark is {{passingPercent}}%. Review the lessons behind the questions you missed, then try again.',
      },
      email: {
        subject: '{{assessmentTitle}}: not passed yet',
        body: [
          'Hi {{recipientFirstName}},',
          'You scored {{scorePercent}}% on {{assessmentTitle}}. The pass mark is {{passingPercent}}%.',
          'Open your results to see which topics to revisit, review those lessons, and retake the assessment when you are ready. Your manager can help if a topic is unclear.',
        ].join('\n\n'),
      },
    },
    rule: { recipients: ['subject'], channels: ['in_app', 'email'], priority: 'normal' },
    build: (p) => ({
      vars: {
        assessmentTitle: p.assessmentTitle,
        scorePercent: score(p.scorePercent),
        passingPercent: score(p.passingPercent),
        attemptNumber: String(p.attemptNumber),
      },
      path: `/assessments/attempts/${p.attemptId}`,
      data: { attemptId: p.attemptId, assessmentId: p.assessmentId, kind: p.kind, scorePercent: p.scorePercent, passed: false },
    }),
  }),
  define({
    key: 'assessment.failed.manager',
    label: 'Team member did not pass',
    description: 'Tells managers when someone on their team does not pass a graded assessment.',
    category: 'assessments',
    audience: 'manager',
    eventType: 'assessment.attempt.graded',
    channels: ['in_app', 'email'],
    actionLabel: 'View progress',
    fixedConditions: { passed: false },
    variables: assessmentVars,
    defaults: {
      in_app: {
        subject: '{{learnerName}} did not pass {{assessmentTitle}}',
        body: 'Scored {{scorePercent}}% on attempt {{attemptNumber}} (pass mark {{passingPercent}}%). A short coaching session before the retake helps.',
      },
      email: {
        subject: '{{learnerName}} did not pass {{assessmentTitle}}',
        body: [
          'Hi {{recipientFirstName}},',
          '{{learnerName}} scored {{scorePercent}}% on attempt {{attemptNumber}} of {{assessmentTitle}}. The pass mark is {{passingPercent}}%.',
          'Consider a short coaching session on the topics they missed before they retake it.',
        ].join('\n\n'),
      },
    },
    rule: { recipients: ['managers'], channels: ['in_app'], priority: 'normal', conditions: { kind: ['quiz', 'exam', 'final'] } },
    build: (p) => ({
      vars: {
        assessmentTitle: p.assessmentTitle,
        scorePercent: score(p.scorePercent),
        passingPercent: score(p.passingPercent),
        attemptNumber: String(p.attemptNumber),
      },
      path: teamMember(p.userId),
      data: { userId: p.userId, attemptId: p.attemptId, assessmentId: p.assessmentId, scorePercent: p.scorePercent },
    }),
  }),

  // ------------------------------------------------------------ approvals
  define({
    key: 'approval.requested',
    label: 'Approval requested',
    description: 'Asks managers to decide on a manager-approval step.',
    category: 'approvals',
    audience: 'manager',
    eventType: 'approval.requested',
    channels: ['in_app', 'email'],
    actionLabel: 'Review approval',
    variables: [...programVars, v('lessonTitle', 'Step waiting for approval', 'Manager Field-Ready Sign-off')],
    defaults: {
      in_app: {
        subject: 'Approval needed: {{learnerName}}',
        body: '{{lessonTitle}} in {{programTitle}} is waiting for your decision.',
      },
      email: {
        subject: 'Approval needed: {{learnerName}}, {{lessonTitle}}',
        body: [
          'Hi {{recipientFirstName}},',
          '{{learnerName}} reached {{lessonTitle}} in {{programTitle}} and is waiting for your decision.',
          'Review their progress and approve, or send it back with a note on what to work on.',
        ].join('\n\n'),
      },
    },
    rule: { recipients: ['managers'], channels: ['in_app', 'email'], priority: 'high' },
    build: (p) => ({
      vars: { programTitle: p.programTitle, lessonTitle: p.lessonTitle },
      path: '/team/approvals',
      data: { approvalId: p.approvalId, userId: p.userId, programId: p.programId, lessonId: p.lessonId },
    }),
  }),
  define({
    key: 'approval.approved',
    label: 'Approval granted',
    description: 'Tells the learner a manager approved their step.',
    category: 'approvals',
    audience: 'learner',
    eventType: 'approval.decided',
    channels: ['in_app', 'email'],
    actionLabel: 'Continue training',
    fixedConditions: { decision: 'approved' },
    nameFields: ['decidedBy'],
    variables: [
      v('lessonTitle', 'Approved step', 'Manager Field-Ready Sign-off'),
      v('deciderName', 'Who approved it', 'Andre Coleman'),
      v('commentText', 'The approver’s note, if any', 'Their note: “Great ride-along this week.” '),
    ],
    defaults: {
      in_app: {
        subject: '{{lessonTitle}} approved',
        body: '{{deciderName}} approved this step. {{commentText}}',
      },
      email: {
        subject: 'Approved: {{lessonTitle}}',
        body: ['Hi {{recipientFirstName}},', '{{deciderName}} approved {{lessonTitle}}. {{commentText}}', 'Your next steps are open in My Training.'].join('\n\n'),
      },
    },
    rule: { recipients: ['subject'], channels: ['in_app', 'email'], priority: 'normal' },
    build: (p, ctx) => ({
      vars: { lessonTitle: p.lessonTitle, deciderName: ctx.nameOf(p.decidedBy, 'Your manager'), commentText: quoted(p.comment) },
      path: training(p.programId),
      data: { approvalId: p.approvalId, programId: p.programId, lessonId: p.lessonId, decision: p.decision },
    }),
  }),
  define({
    key: 'approval.rejected',
    label: 'Approval declined',
    description: 'Tells the learner a manager sent a step back.',
    category: 'approvals',
    audience: 'learner',
    eventType: 'approval.decided',
    channels: ['in_app', 'email'],
    actionLabel: 'See what to work on',
    fixedConditions: { decision: 'rejected' },
    nameFields: ['decidedBy'],
    variables: [
      v('lessonTitle', 'Step that was sent back', 'Manager Field-Ready Sign-off'),
      v('deciderName', 'Who made the decision', 'Andre Coleman'),
      v('commentText', 'The manager’s note, if any', 'Their note: “Let’s do one more ride-along first.” '),
    ],
    defaults: {
      in_app: {
        subject: '{{lessonTitle}} needs more work',
        body: '{{deciderName}} did not approve this step yet. {{commentText}}Talk with them about what to work on next.',
      },
      email: {
        subject: 'Not approved yet: {{lessonTitle}}',
        body: [
          'Hi {{recipientFirstName}},',
          '{{deciderName}} did not approve {{lessonTitle}} yet. {{commentText}}',
          'Talk with them about what to work on, then request the sign-off again.',
        ].join('\n\n'),
      },
    },
    rule: { recipients: ['subject'], channels: ['in_app', 'email'], priority: 'high' },
    build: (p, ctx) => ({
      vars: { lessonTitle: p.lessonTitle, deciderName: ctx.nameOf(p.decidedBy, 'Your manager'), commentText: quoted(p.comment) },
      path: training(p.programId),
      data: { approvalId: p.approvalId, programId: p.programId, lessonId: p.lessonId, decision: p.decision },
    }),
  }),

  // ------------------------------------------------------------ AI coaching
  define({
    key: 'ai.feedback_ready',
    label: 'Role-play feedback ready',
    description: 'Tells the learner their AI role-play was scored.',
    category: 'ai_coaching',
    audience: 'learner',
    eventType: 'ai.score.generated',
    channels: ['in_app', 'email'],
    actionLabel: 'View feedback',
    variables: [
      v('scenarioTitle', 'Scenario title', 'Three Estimates'),
      v('overallScore', 'Overall score', '81'),
      v('passingScore', 'Passing score', '75'),
    ],
    defaults: {
      in_app: {
        subject: 'Feedback ready: {{scenarioTitle}}',
        body: 'You scored {{overallScore}} (passing score {{passingScore}}). See what worked and what to practise next.',
      },
      email: {
        subject: 'Your {{scenarioTitle}} role-play feedback is ready',
        body: [
          'Hi {{recipientFirstName}},',
          'You scored {{overallScore}} on {{scenarioTitle}} (passing score {{passingScore}}).',
          'Open the feedback to see what landed with the homeowner and what to practise in your next session.',
        ].join('\n\n'),
      },
    },
    rule: { recipients: ['subject'], channels: ['in_app'], priority: 'low' },
    build: (p) => ({
      vars: { scenarioTitle: p.scenarioTitle, overallScore: score(p.overallScore), passingScore: score(p.passingScore) },
      path: aiSession(p.sessionId),
      data: { sessionId: p.sessionId, scenarioId: p.scenarioId, overallScore: p.overallScore, passed: p.passed },
    }),
  }),
  define({
    key: 'ai.review_available',
    label: 'Coaching feedback from your manager',
    description: 'Tells the learner a trainer or manager reviewed their role-play.',
    category: 'ai_coaching',
    audience: 'learner',
    eventType: 'ai.session.reviewed',
    channels: ['in_app', 'email'],
    nameFields: ['reviewerId'],
    actionLabel: 'Read feedback',
    variables: [v('scenarioTitle', 'Scenario title', 'Another Roofer Is Cheaper'), v('reviewerName', 'Who reviewed it', 'Hector Villanueva')],
    defaults: {
      in_app: {
        subject: '{{reviewerName}} reviewed your {{scenarioTitle}} session',
        body: 'Open the session to read their coaching notes.',
      },
      email: {
        subject: 'Coaching notes on your {{scenarioTitle}} role-play',
        body: [
          'Hi {{recipientFirstName}},',
          '{{reviewerName}} reviewed your {{scenarioTitle}} role-play and left coaching notes.',
          'Read them before your next practice session.',
        ].join('\n\n'),
      },
    },
    rule: { recipients: ['subject'], channels: ['in_app', 'email'], priority: 'normal' },
    build: (p, ctx) => ({
      vars: { scenarioTitle: p.scenarioTitle, reviewerName: ctx.nameOf(p.reviewerId, 'Your coach') },
      path: aiSession(p.sessionId),
      data: { sessionId: p.sessionId, reviewerId: p.reviewerId },
    }),
  }),

  // ------------------------------------------------------------ certifications
  define({
    key: 'certificate.eligible',
    label: 'Certification requirements met',
    description: 'Tells the learner they met every requirement of a certification.',
    category: 'certifications',
    audience: 'learner',
    eventType: 'certificate.eligible',
    channels: ['in_app', 'email'],
    actionLabel: 'View certifications',
    variables: [certVars[0]!, v('nextStep', 'What happens next', 'Your manager will review it shortly.')],
    defaults: {
      in_app: {
        subject: 'You met the requirements for {{definitionName}}',
        body: '{{nextStep}}',
      },
      email: {
        subject: 'You met the requirements for {{definitionName}}',
        body: ['Hi {{recipientFirstName}},', 'You completed every requirement for {{definitionName}}. {{nextStep}}'].join('\n\n'),
      },
    },
    rule: { recipients: ['subject'], channels: ['in_app'], priority: 'normal' },
    build: (p) => ({
      vars: {
        definitionName: p.definitionName,
        nextStep: p.requiresApproval
          ? 'Your manager will review it shortly; you will hear from us once it is approved.'
          : 'Your certificate will be issued shortly.',
      },
      path: '/certifications',
      data: { definitionId: p.definitionId, candidateId: p.candidateId, requiresApproval: p.requiresApproval },
    }),
  }),
  define({
    key: 'certificate.approval_requested',
    label: 'Certification approval requested',
    description: 'Asks approvers to approve a certification.',
    category: 'certifications',
    audience: 'manager',
    eventType: 'certificate.approval_requested',
    channels: ['in_app', 'email'],
    actionLabel: 'Review approval',
    variables: [certVars[0]!],
    defaults: {
      in_app: {
        subject: 'Certification approval: {{learnerName}}',
        body: '{{learnerName}} met every requirement for {{definitionName}} and is waiting for your approval.',
      },
      email: {
        subject: 'Approve {{definitionName}} for {{learnerName}}',
        body: [
          'Hi {{recipientFirstName}},',
          '{{learnerName}} met every requirement for {{definitionName}} and is waiting for your approval.',
          'Review their results and approve the certification, or decline it with a note on what to work on.',
        ].join('\n\n'),
      },
    },
    rule: { recipients: ['managers'], channels: ['in_app', 'email'], priority: 'high' },
    build: (p) => ({
      vars: { definitionName: p.definitionName },
      path: '/team/approvals',
      data: { approvalId: p.approvalId, definitionId: p.definitionId, userId: p.userId },
    }),
  }),
  define({
    key: 'certificate.approval_rejected',
    label: 'Certification not approved',
    description: 'Tells the learner a certification approval was declined.',
    category: 'certifications',
    audience: 'learner',
    eventType: 'certificate.approval_decided',
    channels: ['in_app', 'email'],
    actionLabel: 'View certifications',
    fixedConditions: { decision: 'rejected' },
    nameFields: ['decidedBy'],
    variables: [
      certVars[0]!,
      v('deciderName', 'Who made the decision', 'Danielle Okafor'),
      v('commentText', 'The approver’s note, if any', 'Their note: “One more supervised appointment first.” '),
    ],
    defaults: {
      in_app: {
        subject: '{{definitionName}} not approved yet',
        body: '{{deciderName}} reviewed your certification. {{commentText}}Your manager will help you plan the next steps.',
      },
      email: {
        subject: '{{definitionName}}: not approved yet',
        body: [
          'Hi {{recipientFirstName}},',
          '{{deciderName}} reviewed your {{definitionName}} certification and did not approve it yet. {{commentText}}',
          'Your manager will help you plan the next steps.',
        ].join('\n\n'),
      },
    },
    rule: { recipients: ['subject'], channels: ['in_app', 'email'], priority: 'high' },
    build: (p, ctx) => ({
      vars: { definitionName: p.definitionName, deciderName: ctx.nameOf(p.decidedBy, 'Your manager'), commentText: quoted(p.comment) },
      path: '/certifications',
      data: { approvalId: p.approvalId, definitionId: p.definitionId, decision: p.decision },
    }),
  }),
  define({
    key: 'certificate.issued',
    label: 'Certificate earned',
    description: 'Congratulates the learner when a certificate is issued.',
    category: 'certifications',
    audience: 'learner',
    eventType: 'certificate.issued',
    channels: ['in_app', 'email'],
    actionLabel: 'View certificate',
    variables: [
      ...certVars,
      v('issuedDate', 'Issue date', 'Oct 5, 2026'),
      v('expiryText', 'Sentence about the expiry date (empty without one)', 'It is valid until Oct 5, 2028.'),
    ],
    defaults: {
      in_app: {
        subject: 'Certificate earned: {{definitionName}}',
        body: 'Congratulations! Certificate {{certificateNumber}} was issued on {{issuedDate}}. {{expiryText}}',
      },
      email: {
        subject: 'Congratulations, you are now {{definitionName}}',
        body: [
          'Hi {{recipientFirstName}},',
          'Congratulations! Your {{definitionName}} certificate ({{certificateNumber}}) was issued on {{issuedDate}}. {{expiryText}}',
          'You can download it and share its verification link from the Academy.',
        ].join('\n\n'),
      },
    },
    rule: { recipients: ['subject'], channels: ['in_app', 'email'], priority: 'high' },
    build: (p, ctx) => ({
      vars: {
        definitionName: p.definitionName,
        certificateNumber: p.certificateNumber,
        issuedDate: ctx.formatDate(p.issuedAt),
        expiryText: p.expiresAt ? `It is valid until ${ctx.formatDate(p.expiresAt)}.` : '',
      },
      path: certificate(p.certificateId),
      data: { certificateId: p.certificateId, definitionId: p.definitionId, certificateNumber: p.certificateNumber, mode: p.mode },
    }),
  }),
  define({
    key: 'certificate.issued.manager',
    label: 'Team member certified',
    description: 'Tells managers when someone on their team earns a certificate.',
    category: 'certifications',
    audience: 'manager',
    eventType: 'certificate.issued',
    channels: ['in_app', 'email'],
    actionLabel: 'View profile',
    variables: [...certVars, v('issuedDate', 'Issue date', 'Oct 5, 2026')],
    defaults: {
      in_app: {
        subject: '{{learnerName}} earned {{definitionName}}',
        body: 'Certificate {{certificateNumber}} was issued on {{issuedDate}}.',
      },
      email: {
        subject: '{{learnerName}} earned {{definitionName}}',
        body: ['Hi {{recipientFirstName}},', '{{learnerName}} earned {{definitionName}} (certificate {{certificateNumber}}) on {{issuedDate}}.'].join('\n\n'),
      },
    },
    rule: { recipients: ['managers'], channels: ['in_app'], priority: 'normal', conditions: { mode: { ne: 'reissue' } } },
    build: (p, ctx) => ({
      vars: { definitionName: p.definitionName, certificateNumber: p.certificateNumber, issuedDate: ctx.formatDate(p.issuedAt) },
      path: teamMember(p.userId),
      data: { userId: p.userId, certificateId: p.certificateId, definitionId: p.definitionId },
    }),
  }),
  define({
    key: 'certificate.generated',
    label: 'Certificate ready to download',
    description: 'Tells the learner their certificate PDF is ready.',
    category: 'certifications',
    audience: 'learner',
    eventType: 'certificate.generated',
    channels: ['in_app'],
    actionLabel: 'Download certificate',
    variables: certVars,
    defaults: {
      in_app: {
        subject: 'Your certificate PDF is ready',
        body: 'Download {{definitionName}} ({{certificateNumber}}) to print it or share it with homeowners.',
      },
    },
    rule: { recipients: ['subject'], channels: ['in_app'], priority: 'low' },
    build: (p) => ({
      vars: { definitionName: p.definitionName, certificateNumber: p.certificateNumber },
      path: certificate(p.certificateId),
      data: { certificateId: p.certificateId, definitionId: p.definitionId },
    }),
  }),
  define({
    key: 'certificate.expiring',
    label: 'Certificate expiring',
    description: 'Reminds the learner before a certificate expires.',
    category: 'certifications',
    audience: 'learner',
    eventType: 'certificate.expiring',
    channels: ['in_app', 'email'],
    actionLabel: 'Plan renewal',
    variables: [certVars[0]!, v('daysRemaining', 'Days until expiry', '48'), v('expiryDate', 'Expiry date', 'Nov 22, 2026')],
    defaults: {
      in_app: {
        subject: '{{definitionName}} expires in {{daysRemaining}} days',
        body: 'Your certificate expires on {{expiryDate}}. Complete the renewal steps before then to stay certified.',
      },
      email: {
        subject: 'Your {{definitionName}} certificate expires on {{expiryDate}}',
        body: [
          'Hi {{recipientFirstName}},',
          'Your {{definitionName}} certificate expires in {{daysRemaining}} days, on {{expiryDate}}.',
          'Complete the renewal steps before then so you stay certified in the field.',
        ].join('\n\n'),
      },
    },
    rule: { recipients: ['subject'], channels: ['in_app', 'email'], priority: 'high' },
    build: (p, ctx) => ({
      vars: { definitionName: p.definitionName, daysRemaining: String(p.daysRemaining), expiryDate: ctx.formatDate(p.expiresAt) },
      path: certificate(p.certificateId),
      data: { certificateId: p.certificateId, definitionId: p.definitionId, expiresAt: p.expiresAt, daysRemaining: p.daysRemaining },
    }),
  }),
  define({
    key: 'certificate.expired',
    label: 'Certificate expired',
    description: 'Tells the learner a certificate expired.',
    category: 'certifications',
    audience: 'learner',
    eventType: 'certificate.expired',
    channels: ['in_app', 'email'],
    actionLabel: 'View certificate',
    variables: [certVars[0]!, v('expiredDate', 'Expiry date', 'Nov 22, 2026')],
    defaults: {
      in_app: {
        subject: '{{definitionName}} has expired',
        body: 'Your certificate expired on {{expiredDate}}. Talk with your manager about renewing it.',
      },
      email: {
        subject: 'Your {{definitionName}} certificate has expired',
        body: [
          'Hi {{recipientFirstName}},',
          'Your {{definitionName}} certificate expired on {{expiredDate}}.',
          'Talk with your manager about the renewal steps so you can get re-certified.',
        ].join('\n\n'),
      },
    },
    rule: { recipients: ['subject'], channels: ['in_app', 'email'], priority: 'high' },
    build: (p, ctx) => ({
      vars: { definitionName: p.definitionName, expiredDate: ctx.formatDate(p.expiredAt) },
      path: certificate(p.certificateId),
      data: { certificateId: p.certificateId, definitionId: p.definitionId },
    }),
  }),
  define({
    key: 'certificate.expired.manager',
    label: 'Team member certificate expired',
    description: 'Tells managers when a certificate on their team expires.',
    category: 'certifications',
    audience: 'manager',
    eventType: 'certificate.expired',
    channels: ['in_app', 'email'],
    actionLabel: 'View profile',
    variables: [certVars[0]!, v('expiredDate', 'Expiry date', 'Nov 22, 2026')],
    defaults: {
      in_app: {
        subject: '{{learnerName}}’s {{definitionName}} expired',
        body: 'It expired on {{expiredDate}}. Help them plan the renewal.',
      },
      email: {
        subject: '{{learnerName}}’s {{definitionName}} expired',
        body: ['Hi {{recipientFirstName}},', '{{learnerName}}’s {{definitionName}} certificate expired on {{expiredDate}}.', 'Help them plan the renewal.'].join('\n\n'),
      },
    },
    rule: { recipients: ['managers'], channels: ['in_app'], priority: 'normal' },
    build: (p, ctx) => ({
      vars: { definitionName: p.definitionName, expiredDate: ctx.formatDate(p.expiredAt) },
      path: teamMember(p.userId),
      data: { userId: p.userId, certificateId: p.certificateId },
    }),
  }),
  define({
    key: 'certificate.revoked',
    label: 'Certificate revoked',
    description: 'Tells the learner a certificate was revoked and why.',
    category: 'certifications',
    audience: 'learner',
    eventType: 'certificate.revoked',
    channels: ['in_app', 'email'],
    actionLabel: 'View certificate',
    variables: [...certVars, v('reason', 'Reason for the revocation', 'Issued before the final assessment was regraded')],
    defaults: {
      in_app: {
        subject: '{{definitionName}} was revoked',
        body: 'Certificate {{certificateNumber}} is no longer valid. Reason: {{reason}}. Contact your manager with any questions.',
      },
      email: {
        subject: 'Your {{definitionName}} certificate was revoked',
        body: [
          'Hi {{recipientFirstName}},',
          'Certificate {{certificateNumber}} ({{definitionName}}) is no longer valid.',
          'Reason: {{reason}}',
          'Contact your manager if you have questions or want to discuss next steps.',
        ].join('\n\n'),
      },
    },
    rule: { recipients: ['subject'], channels: ['in_app', 'email'], priority: 'high' },
    build: (p) => ({
      vars: { definitionName: p.definitionName, certificateNumber: p.certificateNumber, reason: p.reason },
      path: certificate(p.certificateId),
      data: { certificateId: p.certificateId, definitionId: p.definitionId },
    }),
  }),
  define({
    key: 'certificate.renewal_required',
    label: 'Certificate renewal required',
    description: 'Tells the learner a certificate entered its renewal window.',
    category: 'certifications',
    audience: 'learner',
    eventType: 'certificate.renewal_required',
    channels: ['in_app', 'email'],
    actionLabel: 'Start renewal',
    variables: [certVars[0]!, v('dueDate', 'Renewal due date', 'Nov 22, 2026')],
    defaults: {
      in_app: {
        subject: 'Renew {{definitionName}} by {{dueDate}}',
        body: 'Your certification is in its renewal window. Complete the renewal requirements by {{dueDate}} to keep it active.',
      },
      email: {
        subject: 'Renew {{definitionName}} by {{dueDate}}',
        body: [
          'Hi {{recipientFirstName}},',
          'Your {{definitionName}} certification is in its renewal window.',
          'Complete the renewal requirements by {{dueDate}} to keep it active.',
        ].join('\n\n'),
      },
    },
    rule: { recipients: ['subject'], channels: ['in_app', 'email'], priority: 'high' },
    build: (p, ctx) => ({
      vars: { definitionName: p.definitionName, dueDate: ctx.formatDate(p.dueAt) },
      path: certificate(p.certificateId),
      data: { certificateId: p.certificateId, renewalId: p.renewalId, dueAt: p.dueAt },
    }),
  }),
];

const BY_KEY = new Map(NOTIFICATION_TYPE_DEFS.map((d) => [d.key, d]));

export function getTypeDef(key: string): NotificationTypeDef | undefined {
  return BY_KEY.get(key as NotificationTypeKey);
}

export function typeDefsForEvent(eventType: string): NotificationTypeDef[] {
  return NOTIFICATION_TYPE_DEFS.filter((d) => d.eventType === eventType);
}

/** Every variable a template of this type may reference. */
export function variablesOf(def: NotificationTypeDef): VariableDef[] {
  const subjectful = Boolean(EVENT_DESCRIPTORS[def.eventType]?.subjectPath);
  return [...COMMON_VARIABLES, ...(subjectful ? LEARNER_VARIABLES : []), ...def.variables];
}

/** Event types the engine subscribes to. */
export const HANDLED_EVENT_TYPES = [...new Set(NOTIFICATION_TYPE_DEFS.map((d) => d.eventType))];
