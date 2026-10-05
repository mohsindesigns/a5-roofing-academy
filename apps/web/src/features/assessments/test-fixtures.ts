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
