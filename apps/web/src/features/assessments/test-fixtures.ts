import type { assessment } from '@a5/contracts';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

type Base = {
  id: string;
  position: number;
  prompt: string;
  points: number;
  response: null;
  savedAt: null;
};
const base = (n: number, prompt: string): Base => ({
  id: id(n),
  position: n,
  prompt,
  points: 1,
  response: null,
  savedAt: null,
});

/** One learner question of every type, in a fixed order, with readable ids. */
export function learnerQuestions(): assessment.LearnerQuestion[] {
  return [
    {
      ...base(1, 'Who must give permission before a photo report is shared?'),
      type: 'multiple_choice',
      options: [
        { id: 'a', text: 'The homeowner' },
        { id: 'b', text: 'The sales manager' },
        { id: 'c', text: 'The insurance adjuster' },
      ],
    },
    {
      ...base(2, 'Which of these are signs of hail damage?'),
      type: 'multiple_select',
      options: [
        { id: 'a', text: 'Bruised shingles' },
        { id: 'b', text: 'Granule loss in a random pattern' },
        { id: 'c', text: 'Moss on the north slope' },
      ],
    },
    { ...base(3, 'Insurance covers the deductible.'), type: 'true_false' },
    { ...base(4, 'What does the A in A5 stand for?'), type: 'short_answer', maxLength: 20 },
    {
      ...base(5, 'Explain how you would open a door-knock conversation.'),
      type: 'long_answer',
      minWords: 5,
      maxWords: 12,
    },
    {
      ...base(6, 'Handle this objection.'),
      type: 'scenario',
      scenario: 'The homeowner says they want to talk to their spouse first.',
      subQuestion: {
        kind: 'multiple_choice',
        prompt: 'What is your best next step?',
        options: [
          { id: 'x', text: 'Offer to return when both are home' },
          { id: 'y', text: 'Push for a signature today' },
        ],
      },
    },
    {
      ...base(7, 'Put the customer journey in order.'),
      type: 'ordering',
      items: [
        { id: 'i3', text: 'Install' },
        { id: 'i1', text: 'Inspect' },
        { id: 'i2', text: 'Estimate' },
      ],
    },
    {
      ...base(8, 'Match each component to its job.'),
      type: 'matching',
      prompts: [
        { id: 'p1', text: 'Underlayment' },
        { id: 'p2', text: 'Flashing' },
      ],
      choices: [
        { id: 'c2', text: 'Redirects water at joints' },
        { id: 'c1', text: 'Secondary water barrier' },
      ],
    },
  ];
}

export function learnerAttempt(
  over: Partial<assessment.LearnerAttempt> = {},
): assessment.LearnerAttempt {
  const questions = over.questions ?? learnerQuestions();
  return {
    id: id(900),
    assessmentId: id(800),
    title: 'Week 1 Knowledge Check',
    kind: 'quiz',
    attemptNumber: 1,
    status: 'in_progress',
    startedAt: '2026-10-05T15:00:00.000Z',
    expiresAt: '2026-10-05T15:20:00.000Z',
    timeLimitSeconds: 1200,
    timeRemainingSeconds: 1200,
    submittedAt: null,
    autoSubmitted: false,
    passingPercent: 80,
    questionCount: questions.length,
    answeredCount: 0,
    questions,
    resumed: false,
    context: {},
    ...over,
  };
}

export function attemptResult(
  over: Partial<assessment.AttemptResult> = {},
): assessment.AttemptResult {
  return {
    attemptId: id(900),
    assessmentId: id(800),
    title: 'Week 1 Knowledge Check',
    kind: 'quiz',
    attemptNumber: 1,
    status: 'graded',
    submittedAt: '2026-10-05T15:10:00.000Z',
    gradedAt: '2026-10-05T15:10:01.000Z',
    autoSubmitted: false,
    scoreVisible: true,
    scorePercent: 62.5,
    scorePoints: 5,
    maxPoints: 8,
    passed: false,
    passingPercent: 80,
    overridden: false,
    answersRevealed: false,
    attemptsUsed: 1,
    attemptsRemaining: 2,
    retakeAvailableAt: '2026-10-05T15:20:01.000Z',
    message:
      'You did not reach the passing score of 80% (you scored 62.5%). You can try again in 10 minutes.',
    questions: [
      {
        attemptQuestionId: id(1),
        position: 1,
        type: 'multiple_choice',
        prompt: 'Who must give permission before a photo report is shared?',
        points: 1,
        response: { type: 'multiple_choice', optionId: 'b' },
        outcome: 'incorrect',
        awardedPoints: 0,
        feedback: null,
        correctAnswer: null,
        explanation: null,
      },
    ],
    ...over,
  };
}

export function intro(over: Partial<assessment.AssessmentIntro> = {}): assessment.AssessmentIntro {
  return {
    assessment: {
      id: id(800),
      title: 'Week 1 Knowledge Check',
      description: 'Checks how A5 earns trust.',
      kind: 'quiz',
      questionCount: 8,
      passingPercent: 80,
      timeLimitSeconds: 1200,
      maxAttempts: 3,
      revealScore: true,
      revealCorrectAnswers: 'after_submit',
    },
    attemptsUsed: 0,
    attemptsRemaining: 3,
    inProgressAttempt: null,
    cooldownUntil: null,
    bestScorePercent: null,
    passed: false,
    canStart: true,
    blockedReason: null,
    attempts: [],
    ...over,
  };
}

export const ids = { id };

export const BANK_ID = id(500);
export const CATEGORY_ID = id(501);

export function bankDetail(
  over: Partial<assessment.QuestionBankDetail> = {},
): assessment.QuestionBankDetail {
  return {
    id: BANK_ID,
    title: 'A5 Sales Core',
    description: null,
    archived: false,
    questionCount: 12,
    activeQuestionCount: 12,
    categoryCount: 2,
    createdAt: '2026-09-01T10:00:00.000Z',
    updatedAt: '2026-09-01T10:00:00.000Z',
    categories: [
      {
        id: CATEGORY_ID,
        bankId: BANK_ID,
        name: 'Storm damage',
        description: null,
        position: 0,
        questionCount: 4,
      },
      {
        id: id(502),
        bankId: BANK_ID,
        name: 'Objection handling',
        description: null,
        position: 1,
        questionCount: 3,
      },
    ],
    competencies: [
      { id: id(503), bankId: BANK_ID, name: 'Inspection', description: null, questionCount: 2 },
    ],
    createdBy: null,
    updatedBy: null,
    ...over,
  };
}

export function bankSummary(
  over: Partial<assessment.QuestionBankSummary> = {},
): assessment.QuestionBankSummary {
  const {
    categories: _c,
    competencies: _k,
    createdBy: _a,
    updatedBy: _b,
    ...summary
  } = bankDetail();
  return { ...summary, ...over };
}

export function questionDetail(
  over: Partial<assessment.QuestionDetail> = {},
): assessment.QuestionDetail {
  return {
    id: id(600),
    bank: { id: BANK_ID, title: 'A5 Sales Core' },
    status: 'active',
    archivedAt: null,
    versionCount: 3,
    currentVersion: {
      id: id(603),
      questionId: id(600),
      version: 3,
      type: 'multiple_choice',
      config: {
        options: [
          { id: 'oAAA', text: 'The homeowner', correct: true },
          { id: 'oBBB', text: 'The sales manager', correct: false },
          { id: 'oCCC', text: 'The insurance adjuster', correct: false },
        ],
      },
      prompt: 'Who must give permission before a photo report is shared?',
      explanation: 'A5 never shares photos without a yes.',
      points: 2,
      difficulty: 'medium',
      category: { id: CATEGORY_ID, name: 'Storm damage' },
      competencies: [],
      tags: ['permission'],
      changeNote: 'Tightened the wording',
      createdAt: '2026-10-01T10:00:00.000Z',
      createdBy: { id: id(1), displayName: 'Shelby Hartman' },
    },
    usage: [
      { assessmentId: id(800), title: 'Week 1 Knowledge Check', status: 'published', kind: 'quiz' },
    ],
    attemptCount: 14,
    createdAt: '2026-09-02T10:00:00.000Z',
    updatedAt: '2026-10-01T10:00:00.000Z',
    ...over,
  };
}

export function reviewSummary(
  over: Partial<assessment.ReviewAttemptSummary> = {},
): assessment.ReviewAttemptSummary {
  return {
    id: id(950),
    assessment: { id: id(800), title: 'Week 1 Knowledge Check', kind: 'quiz' },
    learner: { id: id(2), displayName: 'Marcus Delgado' },
    attemptNumber: 1,
    status: 'graded',
    startedAt: '2026-10-05T15:00:00.000Z',
    submittedAt: '2026-10-05T15:12:00.000Z',
    gradedAt: '2026-10-05T15:12:01.000Z',
    autoSubmitted: false,
    scorePercent: 66.67,
    passed: false,
    overridden: false,
    pendingReviewCount: 0,
    context: {},
    ...over,
  };
}

export function reviewDetail(
  over: Partial<assessment.ReviewAttemptDetail> = {},
): assessment.ReviewAttemptDetail {
  const mc = questionDetail().currentVersion;
  const question = (
    n: number,
    outcome: assessment.QuestionOutcome,
    awarded: number | null,
    category: string | null,
  ): assessment.ReviewQuestion => ({
    attemptQuestionId: id(960 + n),
    position: n,
    questionId: id(970 + n),
    questionVersionId: id(980 + n),
    version: 1,
    points: 2,
    difficulty: 'medium',
    category: category ? { id: id(990 + n), name: category } : null,
    prompt: `Review question ${n}`,
    explanation: null,
    definition: {
      type: 'multiple_choice',
      config: mc.type === 'multiple_choice' ? mc.config : { options: [] },
    } as assessment.QuestionDefinition,
    optionOrder: {},
    response: { type: 'multiple_choice', optionId: n === 1 ? 'oAAA' : 'oBBB' },
    savedAt: null,
    outcome,
    needsReview: outcome === 'pending_review',
    isCorrect: outcome === 'correct',
    awardedPoints: awarded,
    feedback: null,
    gradedBy: null,
    gradedAt: null,
  });
  return {
    ...reviewSummary(),
    config: {
      title: 'Week 1 Knowledge Check',
      kind: 'quiz',
      assessmentRevision: 4,
      passingPercent: 80,
      maxAttempts: 3,
      timeLimitSeconds: 1200,
      randomizeQuestions: false,
      randomizeOptions: true,
      revealCorrectAnswers: 'after_submit',
      revealScore: true,
      retryCooldownMinutes: 10,
      notifyManagerOn: ['failed'],
      allowStandalone: false,
    },
    expiresAt: '2026-10-05T15:20:00.000Z',
    maxPoints: 6,
    gradedScorePoints: 4,
    gradedScorePercent: 66.67,
    gradedPassed: false,
    questions: [
      question(1, 'correct', 2, 'Storm damage'),
      question(2, 'incorrect', 0, 'Storm damage'),
      question(3, 'correct', 2, 'Objection handling'),
      question(4, 'pending_review', null, null),
    ],
    overrides: [],
    ...over,
  };
}

export function assessmentDetail(
  over: Partial<assessment.AssessmentDetail> = {},
): assessment.AssessmentDetail {
  return {
    id: id(800),
    title: 'Week 1 Knowledge Check',
    description: 'Checks how A5 earns trust.',
    kind: 'quiz',
    status: 'draft',
    passingPercent: 80,
    itemCount: 2,
    questionCount: 2,
    attemptCount: 0,
    publishedAt: null,
    archivedAt: null,
    createdAt: '2026-09-02T10:00:00.000Z',
    updatedAt: '2026-10-01T10:00:00.000Z',
    revision: 4,
    config: {
      passingPercent: 80,
      maxAttempts: 3,
      timeLimitSeconds: 1200,
      randomizeQuestions: false,
      randomizeOptions: true,
      revealCorrectAnswers: 'after_submit',
      revealScore: true,
      retryCooldownMinutes: 10,
      notifyManagerOn: ['failed'],
      allowStandalone: false,
    },
    items: [
      {
        id: id(901),
        position: 1,
        kind: 'question',
        points: null,
        question: {
          id: id(600),
          status: 'active',
          version: 3,
          type: 'multiple_choice',
          prompt: 'Who must give permission before a photo report is shared?',
          difficulty: 'medium',
          points: 2,
          category: { id: CATEGORY_ID, name: 'Storm damage' },
        },
      },
      {
        id: id(902),
        position: 2,
        kind: 'pool',
        points: null,
        bank: { id: BANK_ID, title: 'A5 Sales Core' },
        category: { id: CATEGORY_ID, name: 'Storm damage' },
        difficulty: null,
        tags: [],
        count: 3,
        available: 4,
      },
    ],
    createdBy: null,
    updatedBy: { id: id(1), displayName: 'Shelby Hartman' },
    ...over,
  };
}
