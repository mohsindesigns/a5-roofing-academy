import { describe, expect, it } from 'vitest';
import type { ai } from '@a5/contracts';
import {
  buildRequest,
  changedFields,
  emptyScenario,
  fromScenario,
  validateScenario,
  type ScenarioFormValues,
} from './scenario-model';

const UUID_A = '3b9f0f7e-5c2a-4b1d-8e6f-1a2b3c4d5e6f';
const UUID_B = '7c1d2e3f-4a5b-4c6d-8e7f-0a1b2c3d4e5f';

function valid(overrides: Partial<ScenarioFormValues> = {}): ScenarioFormValues {
  return {
    ...emptyScenario(),
    title: 'Three Estimates',
    category: 'Comparison',
    personaId: UUID_A,
    rubricId: UUID_B,
    objection: 'I already have two other quotes.',
    repBrief: 'Early evening in Plano.',
    background: 'You are comparing roofers.',
    propertyContext: 'A 2012 build with hail damage.',
    trigger: 'The representative knocked.',
    hiddenConcern: 'You were burned by a roofer who disappeared.',
    openingLine: 'I already have two other quotes.',
    expectedBehaviors: 'Asks what matters most\n\n  Offers a written scope  ',
    ...overrides,
  };
}

describe('validateScenario', () => {
  it('builds the API request: trims, splits lines and drops blank model settings', () => {
    const result = validateScenario(valid({ temperature: '0.4', effort: 'low' }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.request.expectedBehaviors).toEqual([
        'Asks what matters most',
        'Offers a written scope',
      ]);
      expect(result.request.modelSettings).toEqual({ temperature: 0.4, effort: 'low' });
      expect(result.request.provider).toBeNull();
      expect(result.request.model).toBeNull();
      expect(result.request.passingScore).toBe(75);
    }
  });

  it('points at the fields that need attention with readable messages', () => {
    const result = validateScenario(
      valid({ title: '  ', passingScore: '', maxTurns: '1', temperature: '3', personaId: 'nope' }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const by = Object.fromEntries(result.issues.map((i) => [i.field, i.message]));
      expect(by.title).toBe('Required');
      expect(by.passingScore).toBe('Required');
      expect(by.maxTurns).toBe('Use 2 or more');
      expect(by.temperature).toBe('Use 1 or less');
      expect(by.personaId).toBe('Choose a persona');
    }
  });

  it('limits line lists and long text', () => {
    const result = validateScenario(
      valid({ objection: 'x'.repeat(301), forbiddenClaims: Array(21).fill('claim').join('\n') }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const by = Object.fromEntries(result.issues.map((i) => [i.field, i.message]));
      expect(by.objection).toBe('Use at most 300 characters');
      expect(by.forbiddenClaims).toBe('Use at most 20 lines');
    }
  });
});

describe('changedFields', () => {
  const detail = {
    id: UUID_A,
    title: 'Three Estimates',
    category: 'Comparison',
    difficulty: 'intermediate',
    status: 'published',
    objection: 'I already have two other quotes.',
    persona: { id: UUID_A, name: 'Comparison shopper' },
    passingScore: 75,
    maxTurns: 10,
    provider: null,
    model: null,
    currentPromptVersion: null,
    sessionCount: 0,
    publishedAt: null,
    updatedAt: '2026-10-05T16:00:00.000Z',
    repBrief: 'Early evening in Plano.',
    background: 'You are comparing roofers.',
    propertyContext: 'A 2012 build with hail damage.',
    trigger: 'The representative knocked.',
    hiddenConcern: 'You were burned by a roofer who disappeared.',
    expectedBehaviors: ['Asks what matters most', 'Offers a written scope'],
    requiredTalkingPoints: [],
    forbiddenClaims: [],
    aiInstructions: '',
    openingLine: 'I already have two other quotes.',
    rubric: { id: UUID_B, title: 'A5 objection handling', currentVersion: 1 },
    evaluationModel: null,
    modelSettings: { effort: 'low' },
    archivedAt: null,
    createdAt: '2026-10-01T16:00:00.000Z',
  } satisfies ai.ScenarioDetail;

  it('round-trips a saved scenario with no changes', () => {
    const saved = fromScenario(detail);
    const result = validateScenario(saved);
    expect(result.ok).toBe(true);
    if (result.ok) expect(changedFields(result.request, saved)).toEqual({});
    expect(buildRequest(saved).modelSettings).toEqual({ effort: 'low' });
  });

  it('sends only what was edited, plus the change note', () => {
    const saved = fromScenario(detail);
    const result = validateScenario({
      ...saved,
      passingScore: '80',
      expectedBehaviors: 'Asks what matters most',
      changeNote: 'Raised the bar',
    });
    expect(result.ok).toBe(true);
    if (result.ok)
      expect(changedFields(result.request, saved)).toEqual({
        passingScore: 80,
        expectedBehaviors: ['Asks what matters most'],
        changeNote: 'Raised the bar',
      });
  });
});
