import { describe, expect, it } from 'vitest';
import { assessment } from '@a5/contracts';
import {
  buildPayload,
  emptyForm,
  formPath,
  fromVersion,
  newChoiceId,
  setIn,
  validateForm,
  withType,
  type QuestionFormValues,
} from './question-form-model';

const BANK = '00000000-0000-4000-8000-0000000000aa';

/** A fully valid form for each question type. */
function valid(type: assessment.QuestionType): QuestionFormValues {
  const f = emptyForm(type, BANK);
  f.prompt = 'Which statement about permission is true?';
  switch (type) {
    case 'multiple_choice':
      f.options.forEach((o, i) => Object.assign(o, { text: `Option ${i + 1}`, correct: i === 1 }));
      break;
    case 'multiple_select':
      f.options.forEach((o, i) => Object.assign(o, { text: `Option ${i + 1}`, correct: i < 2 }));
      break;
    case 'short_answer':
      f.accepted = [{ value: 'Alpine' }, { value: 'Alpine Roofing' }];
      break;
    case 'long_answer':
      f.rubric = 'Look for a greeting, a reason for the visit and a question.';
      f.minWords = '20';
      f.maxWords = '200';
      break;
    case 'scenario':
      f.scenario = 'A homeowner says they need to ask their spouse.';
      f.subPrompt = 'What do you do next?';
      f.options.forEach((o, i) => Object.assign(o, { text: `Step ${i + 1}`, correct: i === 0 }));
      break;
    case 'ordering':
      f.items.forEach((it, i) => (it.text = `Step ${i + 1}`));
      break;
    case 'matching':
      f.pairs.forEach((p, i) =>
        Object.assign(p, { left: `Left ${i + 1}`, right: `Right ${i + 1}` }),
      );
      break;
    case 'true_false':
      break;
  }
  return f;
}

describe('emptyForm', () => {
  it('gives each type the rows it needs', () => {
    expect(emptyForm('multiple_choice', BANK).options).toHaveLength(4);
    expect(emptyForm('multiple_select', BANK).options).toHaveLength(4);
    expect(emptyForm('ordering', BANK).items).toHaveLength(3);
    expect(emptyForm('matching', BANK).pairs).toHaveLength(3);
    expect(emptyForm('short_answer', BANK).accepted).toHaveLength(1);
    expect(emptyForm('scenario', BANK).maxLength).toBe('2000');
  });

  it('generates ids that never hint at the answer', () => {
    const ids = emptyForm('multiple_choice', BANK).options.map((o) => o.id);
    expect(new Set(ids).size).toBe(4);
    for (const id of ids) expect(id).toMatch(/^o[a-z0-9]{10}$/);
    expect(newChoiceId('i')).toMatch(/^i[a-z0-9]{10}$/);
  });
});

describe('validateForm', () => {
  it.each(assessment.QUESTION_TYPES)('accepts a complete %s question', (type) => {
    const { payload, issues } = validateForm(valid(type), { creating: true });
    expect(issues).toEqual([]);
    expect(
      assessment.createQuestionRequestSchema.safeParse({ ...payload, bankId: BANK }).success,
    ).toBe(true);
  });

  it('reports what is missing from an empty multiple choice question, next to the fields', () => {
    const { issues } = validateForm(emptyForm('multiple_choice', BANK), { creating: true });
    const byPath = Object.fromEntries(issues.map((i) => [i.path, i.message]));
    expect(byPath.prompt).toBeDefined();
    expect(byPath['options.0.text']).toBe('Fill this in or remove the row');
    expect(byPath.optionsError).toBe('Mark exactly one option as correct');
  });

  it('asks for at least one correct option on multiple select', () => {
    const f = valid('multiple_select');
    f.options.forEach((o) => (o.correct = false));
    expect(validateForm(f, { creating: false }).issues).toContainEqual({
      path: 'optionsError',
      message: 'Mark at least one option as correct',
    });
  });

  it('requires accepted answers for auto-graded short answers but not for manual review', () => {
    const f = valid('short_answer');
    f.accepted = [{ value: '  ' }];
    expect(validateForm(f, { creating: false }).issues.map((i) => i.path)).toContain(
      'acceptedError',
    );
    f.grading = 'manual';
    expect(validateForm(f, { creating: false }).issues).toEqual([]);
  });

  it('rejects a minimum above the maximum for long answers', () => {
    const f = valid('long_answer');
    f.minWords = '300';
    expect(validateForm(f, { creating: false }).issues).toContainEqual({
      path: 'maxWords',
      message: 'Maximum words must be at least the minimum',
    });
  });

  it('flags text that is not a number once, on the field', () => {
    const f = valid('multiple_choice');
    f.points = 'lots';
    const points = validateForm(f, { creating: false }).issues.filter((i) => i.path === 'points');
    expect(points).toEqual([{ path: 'points', message: 'Enter a number' }]);
    f.points = '0';
    expect(validateForm(f, { creating: false }).issues).toContainEqual({
      path: 'points',
      message: 'Points must be greater than zero, up to 100',
    });
  });

  it('requires a bank only when creating', () => {
    const f = valid('true_false');
    f.bankId = '';
    expect(validateForm(f, { creating: true }).issues.map((i) => i.path)).toEqual(['bankId']);
    expect(validateForm(f, { creating: false }).issues).toEqual([]);
  });

  it('checks scenario follow-ups for the chosen kind only', () => {
    const f = valid('scenario');
    f.subKind = 'open_response';
    f.rubric = '';
    f.maxLength = '2000';
    expect(validateForm(f, { creating: false }).issues.map((i) => i.path)).toEqual(['rubric']);
    f.rubric = 'Reward discovery questions.';
    expect(validateForm(f, { creating: false }).issues).toEqual([]);
  });

  it('rejects a tag the contract does not allow', () => {
    const f = valid('true_false');
    f.tags = 'hail, bad!tag';
    expect(validateForm(f, { creating: false }).issues.map((i) => i.path)).toContain('tags');
  });
});

describe('buildPayload', () => {
  it('sends only the selected type and trims blanks to null', () => {
    const f = valid('true_false');
    f.explanation = '   ';
    f.categoryId = '';
    f.tags = 'Hail, hail , wind';
    const { payload } = buildPayload(f);
    expect(payload).toEqual({
      type: 'true_false',
      config: { correctAnswer: true },
      prompt: 'Which statement about permission is true?',
      explanation: null,
      points: 1,
      difficulty: 'medium',
      categoryId: null,
      competencyIds: [],
      tags: ['hail', 'wind'],
    });
  });

  it('drops empty accepted-answer rows', () => {
    const f = valid('short_answer');
    f.accepted = [{ value: 'A5' }, { value: '' }, { value: ' A5 Roofing ' }];
    expect(
      (buildPayload(f).payload.config as { acceptedAnswers: string[] }).acceptedAnswers,
    ).toEqual(['A5', 'A5 Roofing']);
  });
});

describe('fromVersion', () => {
  const base = {
    id: '00000000-0000-4000-8000-000000000001',
    questionId: '00000000-0000-4000-8000-000000000002',
    version: 3,
    prompt: 'Original prompt',
    explanation: 'Because.',
    points: 2.5,
    difficulty: 'hard' as const,
    category: { id: '00000000-0000-4000-8000-000000000003', name: 'Storm damage' },
    competencies: [{ id: '00000000-0000-4000-8000-000000000004', name: 'Inspection' }],
    tags: ['hail'],
    changeNote: null,
    createdAt: '2026-10-01T10:00:00.000Z',
    createdBy: null,
  };

  it('round-trips a version through the form without changing identifiers', () => {
    const version = {
      ...base,
      type: 'multiple_select' as const,
      config: {
        options: [
          { id: 'oAAA', text: 'Bruised shingles', correct: true },
          { id: 'oBBB', text: 'Moss', correct: false },
        ],
        scoring: 'partial' as const,
      },
    };
    const form = fromVersion(version, BANK);
    expect(form.points).toBe('2.5');
    expect(form.categoryId).toBe(base.category.id);
    expect(form.tags).toBe('hail');
    const { payload, issues } = validateForm(form, { creating: false });
    expect(issues).toEqual([]);
    expect(payload.config).toEqual(version.config);
    expect(payload.points).toBe(2.5);
  });

  it('keeps an open scenario response length when loading', () => {
    const form = fromVersion(
      {
        ...base,
        type: 'scenario',
        config: {
          scenario: 'A homeowner is upset.',
          subQuestion: {
            kind: 'open_response',
            prompt: 'Reply.',
            rubric: 'Empathy first.',
            sampleAnswer: null,
            maxLength: 800,
          },
        },
      },
      BANK,
    );
    expect(form.subKind).toBe('open_response');
    expect(form.maxLength).toBe('800');
    expect(form.rubric).toBe('Empathy first.');
  });

  it.each([
    [
      'ordering',
      {
        items: [
          { id: 'i1', text: 'First' },
          { id: 'i2', text: 'Second' },
        ],
        scoring: 'all_or_nothing',
      },
    ],
    [
      'matching',
      {
        pairs: [
          { leftId: 'l1', left: 'A', rightId: 'r1', right: 'B' },
          { leftId: 'l2', left: 'C', rightId: 'r2', right: 'D' },
        ],
        scoring: 'partial',
      },
    ],
    [
      'short_answer',
      {
        grading: 'auto',
        acceptedAnswers: ['A5'],
        caseSensitive: true,
        normalizeWhitespace: false,
        maxLength: 40,
        reviewGuidance: null,
      },
    ],
    ['long_answer', { rubric: 'Look for X.', sampleAnswer: null, minWords: null, maxWords: 100 }],
  ] as const)('round-trips %s', (type, config) => {
    const form = fromVersion(
      { ...base, type, config } as unknown as assessment.QuestionVersion,
      BANK,
    );
    expect(validateForm(form, { creating: false }).payload.config).toEqual(config);
  });
});

describe('withType', () => {
  it('keeps a single correct option when moving from multiple select to multiple choice', () => {
    const f = valid('multiple_select');
    const next = withType(f, 'multiple_choice');
    expect(next.options.filter((o) => o.correct)).toHaveLength(1);
    expect(next.options[0]!.id).toBe(f.options[0]!.id);
  });

  it('starts new rows for a type that had none', () => {
    const next = withType(emptyForm('true_false', BANK), 'matching');
    expect(next.pairs).toHaveLength(3);
  });
});

describe('formPath', () => {
  it.each([
    [['config', 'options', 1, 'text'], 'options.1.text'],
    [['config', 'options'], 'optionsError'],
    [['config', 'subQuestion', 'options', 0, 'text'], 'options.0.text'],
    [['config', 'subQuestion', 'options'], 'optionsError'],
    [['config', 'subQuestion', 'prompt'], 'subPrompt'],
    [['config', 'subQuestion', 'rubric'], 'rubric'],
    [['config', 'acceptedAnswers'], 'acceptedError'],
    [['config', 'acceptedAnswers', 2], 'accepted.2.value'],
    [['config', 'items', 0, 'text'], 'items.0.text'],
    [['config', 'pairs'], 'pairsError'],
    [['config', 'pairs', 1, 'right'], 'pairs.1.right'],
    [['config', 'maxWords'], 'maxWords'],
    [['prompt'], 'prompt'],
    [['tags', 3], 'tags'],
  ] as const)('maps %j to %s', (path, expected) => {
    expect(formPath(path)).toBe(expected);
  });
});

describe('setIn', () => {
  it('builds nested objects and arrays from a dotted path', () => {
    const out: Record<string, unknown> = {};
    setIn(out, 'options.1.text', { message: 'Required' });
    setIn(out, 'prompt', { message: 'Required' });
    expect(out).toEqual({
      options: [undefined, { text: { message: 'Required' } }],
      prompt: { message: 'Required' },
    });
  });
});
