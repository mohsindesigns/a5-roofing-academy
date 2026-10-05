import type { ai } from '@a5/contracts';

let n = 0;
const id = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;

export function message(
  seq: number,
  role: ai.Message['role'],
  content: string,
  overrides: Partial<ai.Message> = {},
): ai.Message {
  return {
    id: id(),
    seq,
    role,
    content,
    modality: 'text',
    audioRef: null,
    createdAt: '2026-10-05T16:00:00.000Z',
    ...overrides,
  };
}

export function session(overrides: Partial<ai.Session> = {}): ai.Session {
  const messages = overrides.messages ?? [message(1, 'homeowner', "I don't have time right now.")];
  return {
    id: id(),
    scenario: {
      id: id(),
      title: 'The Busy Homeowner',
      category: 'Brush-off',
      difficulty: 'beginner',
      objection: "I don't have time.",
    },
    promptVersion: { id: id(), version: 1 },
    mode: 'practice',
    isTest: false,
    modality: 'text',
    status: 'active',
    endReason: null,
    context: {},
    turnCount: messages.filter((m) => m.role === 'rep').length,
    maxTurns: 10,
    turnsRemaining: 10,
    awaitingReply: messages[messages.length - 1]?.role === 'rep',
    provider: {
      name: 'dev_simulator',
      label: 'Development simulator',
      model: 'a5-dev-simulator-v1',
      simulated: true,
    },
    startedAt: '2026-10-05T16:00:00.000Z',
    endedAt: null,
    messages,
    transcriptPurged: false,
    evaluation: null,
    evaluationError: null,
    reviews: [],
    ...overrides,
  };
}

export function scorecard(overrides: Partial<ai.Scorecard> = {}): ai.Scorecard {
  return {
    id: id(),
    overallScore: 65,
    passed: false,
    passingScore: 75,
    categoryScores: [
      {
        key: 'discovery',
        label: 'Discovery',
        weight: 30,
        score: 66,
        rationale: 'Asked one open question before pitching.',
        evidence: [{ seq: 2, quote: 'What have you noticed on the roof?' }],
      },
      {
        key: 'next_step_closing',
        label: 'Next-step closing',
        weight: 10,
        score: 28,
        rationale: 'Never proposed a specific day and time.',
        evidence: [],
      },
    ],
    strengths: [
      {
        point: 'Built on the homeowner’s own words',
        evidence: [{ seq: 2, quote: 'What have you noticed on the roof?' }],
      },
    ],
    missedOpportunities: [
      {
        point: 'Did not isolate the objection',
        seq: 2,
        quote: 'What have you noticed on the roof?',
        betterApproach: 'Ask whether anything else is holding them back.',
      },
    ],
    questionsToAsk: [
      {
        question: 'Who else weighs in on the decision?',
        why: 'It surfaces the real decision-maker.',
      },
    ],
    riskyStatements: [],
    recommendedResponses: [],
    nextGoal: 'Propose one specific next step with a day and time.',
    summary: 'You listened well but never asked for a next step.',
    provider: {
      name: 'dev_simulator',
      label: 'Development simulator',
      model: 'a5-dev-simulator-v1',
      simulated: true,
    },
    promptVersionId: id(),
    rubricVersionId: id(),
    evaluatedAt: '2026-10-05T16:05:00.000Z',
    ...overrides,
  };
}
