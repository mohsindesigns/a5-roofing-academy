import { seedId } from './ids.js';
import type { PersonKey } from './organization.js';

/**
 * Shared catalogue of the seeded A5 New Hire Sales Academy. Every service seeds its own part
 * (learning: structure, assessment: questions, ai: scenarios, certification: definition) using
 * these ids so cross-service references line up. Content titles are starting points that
 * administrators are expected to edit.
 */

export type LessonType =
  | 'video'
  | 'article'
  | 'pdf'
  | 'document'
  | 'external'
  | 'quiz'
  | 'assignment'
  | 'ai_simulation'
  | 'scenario'
  | 'final_assessment'
  | 'manager_approval'
  | 'acknowledgment';

export interface SeedLesson {
  key: string;
  id: string;
  title: string;
  type: LessonType;
  minutes: number;
  required: boolean;
  /** assessment key for quiz/final_assessment lessons, scenario key for ai_simulation */
  ref?: string;
}

export interface SeedModule {
  key: string;
  id: string;
  title: string;
  lessons: SeedLesson[];
}

export interface SeedPhase {
  key: string;
  id: string;
  title: string;
  summary: string;
  modules: SeedModule[];
}

const lesson = (
  key: string,
  title: string,
  type: LessonType,
  minutes: number,
  ref?: string,
  required = true,
): SeedLesson => ({
  key,
  id: seedId(`lesson:${key}`),
  title,
  type,
  minutes,
  required,
  ref,
});

const mod = (key: string, title: string, lessons: SeedLesson[]): SeedModule => ({
  key,
  id: seedId(`module:${key}`),
  title,
  lessons,
});

export const PROGRAM = {
  id: seedId('program:new-hire-sales-academy'),
  slug: 'a5-new-hire-sales-academy',
  title: 'A5 New Hire Sales Academy',
  summary:
    'Four weeks that take a new sales representative from their first day at A5 Roofing to field-ready: company standards, roofing and insurance knowledge, the A5 sales conversation and supervised practice.',
  category: 'Onboarding',
  phaseLabel: 'Week',
  durationDays: 28,
};

export const PHASES: SeedPhase[] = [
  {
    key: 'w1',
    id: seedId('phase:w1'),
    title: 'A5 Fundamentals',
    summary:
      'Who A5 Roofing is, how we earn trust and how a customer moves from first knock to final walkthrough.',
    modules: [
      mod('w1m1', 'Welcome to A5 Roofing', [
        lesson('w1-welcome', 'Welcome from Leadership', 'video', 8),
        lesson('w1-trust', 'How A5 Earns Homeowner Trust', 'article', 10),
        lesson('w1-handbook', 'Sales Code of Conduct Acknowledgment', 'acknowledgment', 5),
      ]),
      mod('w1m2', 'The A5 Customer Journey', [
        lesson('w1-journey', 'From Door Knock to Final Walkthrough', 'video', 12),
        lesson('w1-journey-map', 'Customer Journey Map', 'pdf', 6),
        lesson('w1-quiz', 'Week 1 Knowledge Check', 'quiz', 15, 'quiz-w1'),
      ]),
    ],
  },
  {
    key: 'w2',
    id: seedId('phase:w2'),
    title: 'Roofing & Insurance Fundamentals',
    summary: 'Roof systems, storm damage and how homeowner insurance claims really work.',
    modules: [
      mod('w2m1', 'Roofing Systems', [
        lesson('w2-anatomy', 'Anatomy of a Residential Roof', 'video', 14),
        lesson('w2-materials', 'Shingles, Underlayment and Ventilation', 'article', 12),
        lesson('w2-damage', 'Identifying Hail and Wind Damage', 'video', 16),
      ]),
      mod('w2m2', 'Insurance Claims', [
        lesson('w2-claims', 'How a Homeowner Claim Works', 'video', 15),
        lesson('w2-adjusters', 'Working With Adjusters', 'article', 10),
        lesson('w2-quiz', 'Week 2 Knowledge Check', 'quiz', 15, 'quiz-w2'),
      ]),
    ],
  },
  {
    key: 'w3',
    id: seedId('phase:w3'),
    title: 'Sales Execution',
    summary:
      'Opening conversations, discovery and the A5 objection framework, practised with the AI homeowner.',
    modules: [
      mod('w3m1', 'The A5 Sales Conversation', [
        lesson('w3-opening', 'Opening the Door: The First 30 Seconds', 'video', 10),
        lesson('w3-discovery', 'Discovery Questions That Uncover Real Concerns', 'article', 12),
        lesson('w3-practice-busy', 'Practice: The Busy Homeowner', 'ai_simulation', 15, 'no-time'),
      ]),
      mod('w3m2', 'Handling Objections', [
        lesson('w3-framework', 'The A5 Objection Framework', 'video', 14),
        lesson(
          'w3-practice-spouse',
          'Practice: "I need to talk to my spouse"',
          'ai_simulation',
          15,
          'spouse',
        ),
        lesson(
          'w3-practice-estimates',
          'Practice: "I want three estimates"',
          'ai_simulation',
          15,
          'three-estimates',
        ),
        lesson('w3-quiz', 'Week 3 Knowledge Check', 'quiz', 15, 'quiz-w3'),
      ]),
    ],
  },
  {
    key: 'w4',
    id: seedId('phase:w4'),
    title: 'Field Readiness',
    summary: 'Compliance, supervised field work and the final readiness assessment.',
    modules: [
      mod('w4m1', 'Ride-Along and Compliance', [
        lesson('w4-compliance', 'Compliance: What We Never Promise', 'article', 10),
        lesson('w4-ridealong', 'Field Ride-Along Reflection', 'assignment', 20),
        lesson(
          'w4-practice-claim',
          'Practice: "I don\'t want to file a claim"',
          'ai_simulation',
          15,
          'no-claim',
        ),
        lesson(
          'w4-practice-cheaper',
          'Practice: "Another roofer is cheaper"',
          'ai_simulation',
          15,
          'cheaper',
        ),
      ]),
      mod('w4m2', 'Certification', [
        lesson('w4-final', 'Final Sales Readiness Assessment', 'final_assessment', 40, 'final'),
        lesson('w4-signoff', 'Manager Field-Ready Sign-off', 'manager_approval', 5),
      ]),
    ],
  },
];

export function allLessons(): Array<SeedLesson & { phaseKey: string; moduleKey: string }> {
  return PHASES.flatMap((p) =>
    p.modules.flatMap((m) => m.lessons.map((l) => ({ ...l, phaseKey: p.key, moduleKey: m.key }))),
  );
}

// ---------------------------------------------------------------- assessments

export interface SeedAssessment {
  key: string;
  id: string;
  title: string;
  kind: 'quiz' | 'exam' | 'final' | 'practice';
  passingPercent: number;
  lessonKey: string;
  questionCount: number;
}

export const ASSESSMENTS: SeedAssessment[] = [
  {
    key: 'quiz-w1',
    id: seedId('assessment:quiz-w1'),
    title: 'Week 1 Knowledge Check',
    kind: 'quiz',
    passingPercent: 80,
    lessonKey: 'w1-quiz',
    questionCount: 8,
  },
  {
    key: 'quiz-w2',
    id: seedId('assessment:quiz-w2'),
    title: 'Week 2 Knowledge Check',
    kind: 'quiz',
    passingPercent: 80,
    lessonKey: 'w2-quiz',
    questionCount: 10,
  },
  {
    key: 'quiz-w3',
    id: seedId('assessment:quiz-w3'),
    title: 'Week 3 Knowledge Check',
    kind: 'quiz',
    passingPercent: 80,
    lessonKey: 'w3-quiz',
    questionCount: 10,
  },
  {
    key: 'final',
    id: seedId('assessment:final'),
    title: 'Final Sales Readiness Assessment',
    kind: 'final',
    passingPercent: 85,
    lessonKey: 'w4-final',
    questionCount: 20,
  },
];

export const QUESTION_BANK = {
  id: seedId('bank:a5-sales-core'),
  title: 'A5 Sales Core',
};

// ---------------------------------------------------------------- AI scenarios

export interface SeedScenario {
  key: string;
  id: string;
  title: string;
  objection: string;
  category: string;
  difficulty: 'beginner' | 'intermediate' | 'advanced' | 'expert';
  personaKey: string;
  passingScore: number;
}

export const PERSONAS = [
  { key: 'friendly', id: seedId('persona:friendly'), name: 'Friendly homeowner' },
  { key: 'busy', id: seedId('persona:busy'), name: 'Busy homeowner' },
  { key: 'skeptical', id: seedId('persona:skeptical'), name: 'Skeptical homeowner' },
  { key: 'price', id: seedId('persona:price'), name: 'Price-sensitive homeowner' },
  { key: 'informed', id: seedId('persona:informed'), name: 'Highly informed homeowner' },
  { key: 'burned', id: seedId('persona:burned'), name: 'Burned by a previous contractor' },
  { key: 'insurance', id: seedId('persona:insurance'), name: 'Insurance-resistant homeowner' },
  { key: 'shopper', id: seedId('persona:shopper'), name: 'Comparison shopper' },
  { key: 'difficult', id: seedId('persona:difficult'), name: 'Difficult homeowner' },
] as const;

export const SCENARIOS: SeedScenario[] = [
  {
    key: 'no-time',
    id: seedId('scenario:no-time'),
    title: 'The Busy Homeowner',
    objection: "I don't have time.",
    category: 'Brush-off',
    difficulty: 'beginner',
    personaKey: 'busy',
    passingScore: 75,
  },
  {
    key: 'spouse',
    id: seedId('scenario:spouse'),
    title: 'Talk to My Spouse',
    objection: 'I need to talk to my spouse.',
    category: 'Decision maker',
    difficulty: 'intermediate',
    personaKey: 'friendly',
    passingScore: 75,
  },
  {
    key: 'three-estimates',
    id: seedId('scenario:three-estimates'),
    title: 'Three Estimates',
    objection: 'I want to get three estimates.',
    category: 'Comparison',
    difficulty: 'intermediate',
    personaKey: 'shopper',
    passingScore: 75,
  },
  {
    key: 'no-claim',
    id: seedId('scenario:no-claim'),
    title: 'No Insurance Claim',
    objection: "I don't want to file an insurance claim.",
    category: 'Insurance',
    difficulty: 'advanced',
    personaKey: 'insurance',
    passingScore: 80,
  },
  {
    key: 'cheaper',
    id: seedId('scenario:cheaper'),
    title: 'Another Roofer Is Cheaper',
    objection: 'Another roofer is cheaper.',
    category: 'Price',
    difficulty: 'advanced',
    personaKey: 'price',
    passingScore: 80,
  },
  {
    key: 'have-roofer',
    id: seedId('scenario:have-roofer'),
    title: 'Already Have a Roofer',
    objection: 'I already have a roofer.',
    category: 'Loyalty',
    difficulty: 'intermediate',
    personaKey: 'skeptical',
    passingScore: 75,
  },
  {
    key: 'roof-fine',
    id: seedId('scenario:roof-fine'),
    title: 'My Roof Looks Fine',
    objection: 'My roof looks fine.',
    category: 'Need',
    difficulty: 'beginner',
    personaKey: 'friendly',
    passingScore: 75,
  },
  {
    key: 'leave-card',
    id: seedId('scenario:leave-card'),
    title: 'Just Leave Your Card',
    objection: 'Just leave your card.',
    category: 'Brush-off',
    difficulty: 'beginner',
    personaKey: 'busy',
    passingScore: 75,
  },
  {
    key: 'not-signing',
    id: seedId('scenario:not-signing'),
    title: "I'm Not Signing Anything",
    objection: "I'm not signing anything.",
    category: 'Commitment',
    difficulty: 'expert',
    personaKey: 'burned',
    passingScore: 80,
  },
  {
    key: 'already-inspected',
    id: seedId('scenario:already-inspected'),
    title: 'Insurance Already Inspected',
    objection: 'My insurance company already inspected it.',
    category: 'Insurance',
    difficulty: 'expert',
    personaKey: 'informed',
    passingScore: 80,
  },
];

export const RUBRIC = {
  id: seedId('rubric:a5-objection-handling'),
  title: 'A5 Objection Handling Rubric',
};

// ---------------------------------------------------------------- certification

export const CERTIFICATION = {
  id: seedId('certification:sales-rep'),
  code: 'SALES',
  name: 'A5 Roofing Certified Sales Representative',
  validityMonths: 24,
  numberPattern: '{ORG}-{CODE}-{YYYY}-{SEQ:6}',
  requiredAiSessions: 5,
  aiAverage: 80,
  quizMinimum: 80,
  finalMinimum: 85,
};

export const CERTIFICATE_TEMPLATES = [
  { key: 'classic', id: seedId('template:classic-landscape'), name: 'Classic Landscape' },
  { key: 'modern', id: seedId('template:modern-portrait'), name: 'Modern Portrait' },
] as const;

export const SIGNATORIES = [
  {
    key: 'priya',
    id: seedId('signatory:priya'),
    person: 'priya' as PersonKey,
    title: 'Director of Sales Enablement',
  },
  {
    key: 'shelby',
    id: seedId('signatory:shelby'),
    person: 'shelby' as PersonKey,
    title: 'Sales Training Manager',
  },
] as const;

export const STAMPS = [
  { key: 'company-seal', id: seedId('stamp:company-seal'), name: 'A5 Roofing Official Seal' },
] as const;

// ---------------------------------------------------------------- learner journeys

export type JourneyStage =
  | 'started' // just enrolled, part of week 1 done
  | 'week1'
  | 'week2'
  | 'week3'
  | 'week4'
  | 'awaiting_approval' // everything done, manager approval pending
  | 'certified';

export interface CertificateSeed {
  issuedAt: string;
  status: 'issued' | 'expired' | 'revoked' | 'superseded';
  /** For reissued certificates, the replacement is seeded as a separate, active certificate. */
  reissueReason?: string;
  revokeReason?: string;
}

export interface LearnerJourney {
  person: PersonKey;
  enrolledAt: string;
  stage: JourneyStage;
  /** Assessment attempts in order. Scores are percentages. */
  attempts: Partial<Record<SeedAssessment['key'], number[]>>;
  /** AI practice sessions: scenario key + overall score, oldest first. */
  aiSessions: Array<{ scenario: SeedScenario['key']; score: number; daysAgo: number }>;
  certificates?: CertificateSeed[];
}

/** Ordered list of lesson keys a learner at a given stage has completed. */
export function completedLessonKeys(stage: JourneyStage): string[] {
  const lessons = allLessons();
  const upTo = (phaseKey: string, extra: string[] = []) => {
    const idx = lessons.findIndex((l) => l.phaseKey === phaseKey);
    return [...lessons.slice(0, idx === -1 ? lessons.length : idx).map((l) => l.key), ...extra];
  };
  switch (stage) {
    case 'started':
      return ['w1-welcome', 'w1-trust'];
    case 'week1':
      return ['w1-welcome', 'w1-trust', 'w1-handbook', 'w1-journey'];
    case 'week2':
      return upTo('w2', ['w2-anatomy', 'w2-materials']);
    case 'week3':
      return upTo('w3', ['w3-opening', 'w3-discovery', 'w3-practice-busy']);
    case 'week4':
      return upTo('w4', ['w4-compliance']);
    case 'awaiting_approval':
      return lessons.filter((l) => l.key !== 'w4-signoff').map((l) => l.key);
    case 'certified':
      return lessons.map((l) => l.key);
  }
}

export const JOURNEYS: LearnerJourney[] = [
  {
    person: 'ashlyn',
    enrolledAt: '2025-03-03T14:00:00Z',
    stage: 'certified',
    attempts: { 'quiz-w1': [90], 'quiz-w2': [84], 'quiz-w3': [92], final: [91] },
    aiSessions: [
      { scenario: 'no-time', score: 81, daysAgo: 570 },
      { scenario: 'spouse', score: 84, daysAgo: 565 },
      { scenario: 'three-estimates', score: 79, daysAgo: 562 },
      { scenario: 'no-claim', score: 86, daysAgo: 556 },
      { scenario: 'cheaper', score: 88, daysAgo: 554 },
    ],
    certificates: [{ issuedAt: '2025-04-04T16:00:00Z', status: 'issued' }],
  },
  {
    person: 'sofia',
    enrolledAt: '2024-10-21T14:00:00Z',
    stage: 'certified',
    attempts: { 'quiz-w1': [88], 'quiz-w2': [80], 'quiz-w3': [86], final: [87] },
    aiSessions: [
      { scenario: 'no-time', score: 82, daysAgo: 700 },
      { scenario: 'spouse', score: 80, daysAgo: 695 },
      { scenario: 'three-estimates', score: 83, daysAgo: 690 },
      { scenario: 'no-claim', score: 81, daysAgo: 688 },
      { scenario: 'cheaper', score: 85, daysAgo: 686 },
    ],
    // Expires within 60 days of the seed date, so renewal reminders and dashboards have data.
    certificates: [{ issuedAt: '2024-11-22T16:00:00Z', status: 'issued' }],
  },
  {
    person: 'destiny',
    enrolledAt: '2025-06-02T14:00:00Z',
    stage: 'certified',
    attempts: { 'quiz-w1': [94], 'quiz-w2': [90], 'quiz-w3': [88], final: [93] },
    aiSessions: [
      { scenario: 'no-time', score: 88, daysAgo: 470 },
      { scenario: 'spouse', score: 91, daysAgo: 466 },
      { scenario: 'three-estimates', score: 85, daysAgo: 463 },
      { scenario: 'no-claim', score: 87, daysAgo: 460 },
      { scenario: 'cheaper', score: 90, daysAgo: 458 },
      { scenario: 'not-signing', score: 82, daysAgo: 120 },
    ],
    certificates: [
      {
        issuedAt: '2025-07-03T16:00:00Z',
        status: 'superseded',
        reissueReason: 'Corrected legal name spelling',
      },
      { issuedAt: '2025-07-10T16:00:00Z', status: 'issued' },
    ],
  },
  {
    person: 'brianna',
    enrolledAt: '2026-07-06T14:00:00Z',
    stage: 'awaiting_approval',
    attempts: { 'quiz-w1': [86], 'quiz-w2': [74, 88], 'quiz-w3': [90], final: [89] },
    aiSessions: [
      { scenario: 'no-time', score: 78, daysAgo: 40 },
      { scenario: 'spouse', score: 83, daysAgo: 36 },
      { scenario: 'three-estimates', score: 81, daysAgo: 30 },
      { scenario: 'no-claim', score: 84, daysAgo: 12 },
      { scenario: 'cheaper', score: 86, daysAgo: 9 },
    ],
  },
  {
    person: 'naomi',
    enrolledAt: '2026-08-03T14:00:00Z',
    stage: 'week4',
    attempts: { 'quiz-w1': [92], 'quiz-w2': [86], 'quiz-w3': [82] },
    aiSessions: [
      { scenario: 'no-time', score: 80, daysAgo: 18 },
      { scenario: 'spouse', score: 72, daysAgo: 14 },
      { scenario: 'spouse', score: 81, daysAgo: 13 },
      { scenario: 'three-estimates', score: 77, daysAgo: 10 },
    ],
  },
  {
    person: 'caleb',
    enrolledAt: '2026-08-17T14:00:00Z',
    stage: 'week3',
    attempts: { 'quiz-w1': [82], 'quiz-w2': [80] },
    aiSessions: [{ scenario: 'no-time', score: 76, daysAgo: 3 }],
  },
  {
    person: 'jasmine',
    enrolledAt: '2026-08-17T14:00:00Z',
    stage: 'week3',
    attempts: { 'quiz-w1': [96], 'quiz-w2': [92] },
    aiSessions: [{ scenario: 'no-time', score: 84, daysAgo: 2 }],
  },
  {
    person: 'marcus',
    enrolledAt: '2026-08-31T14:00:00Z',
    stage: 'week2',
    attempts: { 'quiz-w1': [86] },
    aiSessions: [{ scenario: 'roof-fine', score: 71, daysAgo: 5 }],
  },
  {
    person: 'tyler',
    enrolledAt: '2026-08-31T14:00:00Z',
    stage: 'week2',
    attempts: { 'quiz-w1': [70, 84] },
    aiSessions: [],
  },
  {
    person: 'kayla',
    enrolledAt: '2026-09-14T14:00:00Z',
    stage: 'week1',
    attempts: {},
    aiSessions: [],
  },
  {
    person: 'jordan',
    enrolledAt: '2026-09-14T14:00:00Z',
    stage: 'week1',
    attempts: {},
    aiSessions: [],
  },
  {
    person: 'isaiah',
    enrolledAt: '2026-09-14T14:00:00Z',
    stage: 'week1',
    attempts: {},
    aiSessions: [],
  },
  {
    person: 'colton',
    enrolledAt: '2026-09-14T14:00:00Z',
    stage: 'week1',
    attempts: {},
    aiSessions: [],
  },
  {
    person: 'devon',
    enrolledAt: '2026-09-28T14:00:00Z',
    stage: 'started',
    attempts: {},
    aiSessions: [],
  },
  {
    person: 'ethan',
    enrolledAt: '2026-09-28T14:00:00Z',
    stage: 'started',
    attempts: {},
    aiSessions: [],
  },
  {
    person: 'darius',
    enrolledAt: '2026-09-28T14:00:00Z',
    stage: 'started',
    attempts: {},
    aiSessions: [],
  },
];

/** Reference "now" for seed data; ages (daysAgo) are relative to this instant. */
export const SEED_NOW = new Date('2026-10-05T15:00:00Z');

export function daysAgo(days: number, from: Date = SEED_NOW): Date {
  return new Date(from.getTime() - days * 86_400_000);
}
