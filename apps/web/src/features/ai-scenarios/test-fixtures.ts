import type { ai } from '@a5/contracts';

export const IDS = {
  scenario: '00000000-0000-4000-8000-000000000101',
  persona: '00000000-0000-4000-8000-000000000102',
  rubric: '00000000-0000-4000-8000-000000000103',
  rubricVersion1: '00000000-0000-4000-8000-000000000104',
  rubricVersion2: '00000000-0000-4000-8000-000000000105',
  promptV1: '00000000-0000-4000-8000-000000000111',
  promptV2: '00000000-0000-4000-8000-000000000112',
  promptV3: '00000000-0000-4000-8000-000000000113',
};

export function scenario(over: Partial<ai.ScenarioDetail> = {}): ai.ScenarioDetail {
  return {
    id: IDS.scenario,
    title: 'Three Estimates',
    category: 'Comparison',
    difficulty: 'intermediate',
    status: 'draft',
    objection: 'I already have two other quotes.',
    persona: { id: IDS.persona, name: 'Comparison shopper' },
    passingScore: 75,
    maxTurns: 10,
    provider: null,
    model: null,
    currentPromptVersion: { id: IDS.promptV2, version: 2, createdAt: '2026-10-02T15:00:00.000Z' },
    sessionCount: 4,
    publishedAt: null,
    updatedAt: '2026-10-02T15:00:00.000Z',
    repBrief: 'Early evening in Plano.',
    background: 'You are comparing roofers.',
    propertyContext: 'A 2012 build with hail damage.',
    trigger: 'The representative knocked.',
    hiddenConcern: 'You were burned by a roofer who disappeared.',
    expectedBehaviors: ['Asks what matters most'],
    requiredTalkingPoints: ['Written scope of work'],
    forbiddenClaims: ['Insurance will pay for a new roof'],
    aiInstructions: '',
    openingLine: 'I already have two other quotes.',
    rubric: { id: IDS.rubric, title: 'A5 objection handling', currentVersion: 2 },
    evaluationModel: null,
    modelSettings: {},
    archivedAt: null,
    createdAt: '2026-10-01T15:00:00.000Z',
    ...over,
  };
}

export function scenarioSummary(over: Partial<ReturnType<typeof scenario>> = {}) {
  const s = scenario(over);
  return {
    id: s.id,
    title: s.title,
    category: s.category,
    difficulty: s.difficulty,
    status: s.status,
    objection: s.objection,
    persona: s.persona,
    passingScore: s.passingScore,
    maxTurns: s.maxTurns,
    provider: s.provider,
    model: s.model,
    currentPromptVersion: s.currentPromptVersion,
    sessionCount: s.sessionCount,
    publishedAt: s.publishedAt,
    updatedAt: s.updatedAt,
  };
}

export function persona(over: Partial<ai.Persona> = {}): ai.Persona {
  return {
    id: IDS.persona,
    name: 'Comparison shopper',
    description: 'Gets three quotes before deciding.',
    temperament: 'Methodical',
    speakingStyle: 'Precise',
    background: 'Reads reviews.',
    traits: ['Asks for itemized scopes'],
    archived: false,
    scenarioCount: 1,
    createdAt: '2026-10-01T15:00:00.000Z',
    updatedAt: '2026-10-01T15:00:00.000Z',
    ...over,
  };
}

const categories: ai.RubricCategory[] = [
  {
    key: 'discovery',
    label: 'Discovery',
    description: 'Finds the real concern.',
    weight: 10,
    guidance: 'Two open questions before presenting.',
  },
  {
    key: 'next_step_closing',
    label: 'Next-step closing',
    description: 'Proposes a specific next step.',
    weight: 30,
    guidance: 'A day and a time.',
  },
];

export function rubric(over: Partial<ai.RubricDetail> = {}): ai.RubricDetail {
  const current: ai.RubricVersion = {
    id: IDS.rubricVersion2,
    version: 2,
    passingScore: 75,
    categoryCount: categories.length,
    changeNote: 'Raised closing weight',
    createdBy: { id: '00000000-0000-4000-8000-000000000120', displayName: 'Shelby Hartman' },
    createdAt: '2026-10-02T15:00:00.000Z',
    rubricId: IDS.rubric,
    categories,
  };
  return {
    id: IDS.rubric,
    title: 'A5 objection handling',
    description: 'The default rubric.',
    archived: false,
    scenarioCount: 3,
    currentVersion: current,
    versions: [
      current,
      {
        id: IDS.rubricVersion1,
        version: 1,
        passingScore: 70,
        categoryCount: 2,
        changeNote: 'Initial version',
        createdBy: null,
        createdAt: '2026-10-01T15:00:00.000Z',
      },
    ],
    updatedAt: '2026-10-02T15:00:00.000Z',
    ...over,
  };
}

export function promptVersions() {
  const base = {
    provider: null,
    model: null,
    evaluationModel: null,
    rubricVersionId: IDS.rubricVersion2,
    createdBy: { id: '00000000-0000-4000-8000-000000000120', displayName: 'Shelby Hartman' },
  };
  return {
    items: [
      {
        ...base,
        id: IDS.promptV2,
        version: 2,
        changeNote: 'Edited opening line',
        current: true,
        sessionCount: 3,
        createdAt: '2026-10-02T15:00:00.000Z',
      },
      {
        ...base,
        id: IDS.promptV1,
        version: 1,
        changeNote: 'Initial version',
        current: false,
        sessionCount: 1,
        createdAt: '2026-10-01T15:00:00.000Z',
      },
    ],
  };
}
