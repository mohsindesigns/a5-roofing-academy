import { describe, expect, it } from 'vitest';
import { assessment } from '@a5/contracts';
import { allocatePools } from '../src/engine/allocation.js';
import { answersRevealed, isPassing, scorePercent, waitPhrase } from '../src/engine/policy.js';
import {
  correctAnswer,
  gradeResponse,
  initialOrder,
  isAnswered,
  learnerQuestion,
  needsReview,
  normalizeShortAnswer,
  validateResponse,
} from '../src/engine/question-types.js';
import { seededRng, shuffle } from '../src/engine/random.js';
import { sampleQuestions } from './harness.js';

const def = (body: { type: string; config: unknown }) => assessment.questionDefinitionSchema.parse({ type: body.type, config: body.config });

const mc = def(sampleQuestions.multipleChoice('q'));
const msAll = def(sampleQuestions.multipleSelect('q', 'all_or_nothing'));
const msPartial = def(sampleQuestions.multipleSelect('q', 'partial'));
const tf = def(sampleQuestions.trueFalse('q'));
const sa = def(sampleQuestions.shortAnswer('q'));
const la = def(sampleQuestions.longAnswer('q'));
const scChoice = def(sampleQuestions.scenarioChoice('q'));
const scOpen = def(sampleQuestions.scenarioOpen('q'));
const ord = def(sampleQuestions.ordering('q'));
const match = def(sampleQuestions.matching('q'));

const auto = (d: assessment.QuestionDefinition, response: assessment.AnswerResponse | null, points = 4) => {
  const grade = gradeResponse(d, response, points);
  if (grade.kind !== 'auto') throw new Error('expected automatic grading');
  return grade;
};

describe('grading by question type', () => {
  it('multiple choice is all or nothing', () => {
    expect(auto(mc, { type: 'multiple_choice', optionId: 'a' }, 2)).toEqual({ kind: 'auto', correct: true, awarded: 2 });
    expect(auto(mc, { type: 'multiple_choice', optionId: 'b' }, 2)).toEqual({ kind: 'auto', correct: false, awarded: 0 });
  });

  it('unanswered questions score zero and never need review', () => {
    expect(auto(mc, null)).toMatchObject({ correct: false, awarded: 0 });
    expect(auto(msPartial, { type: 'multiple_select', optionIds: [] })).toMatchObject({ awarded: 0 });
    expect(auto(la, { type: 'long_answer', text: '   ' })).toMatchObject({ awarded: 0 });
    expect(needsReview(la, { type: 'long_answer', text: '   ' })).toBe(false);
    expect(needsReview(la, { type: 'long_answer', text: 'Something' })).toBe(true);
  });

  it('multiple select is all or nothing when configured so', () => {
    const all = { type: 'multiple_select' as const, optionIds: ['a', 'b', 'c'] };
    expect(auto(msAll, all)).toMatchObject({ correct: true, awarded: 4 });
    expect(auto(msAll, { type: 'multiple_select', optionIds: ['a', 'b'] })).toMatchObject({ correct: false, awarded: 0 });
    expect(auto(msAll, { type: 'multiple_select', optionIds: ['a', 'b', 'c', 'd'] })).toMatchObject({ correct: false, awarded: 0 });
  });

  it('multiple select awards partial credit: (correct picks - wrong picks) / correct options, never below zero', () => {
    expect(auto(msPartial, { type: 'multiple_select', optionIds: ['a', 'b', 'c'] })).toMatchObject({ correct: true, awarded: 4 });
    expect(auto(msPartial, { type: 'multiple_select', optionIds: ['a', 'b'] })).toEqual({ kind: 'auto', correct: false, awarded: 2.67 });
    expect(auto(msPartial, { type: 'multiple_select', optionIds: ['a'] })).toMatchObject({ correct: false, awarded: 1.33 });
    // two right, one wrong: (2 - 1) / 3
    expect(auto(msPartial, { type: 'multiple_select', optionIds: ['a', 'b', 'd'] })).toMatchObject({ correct: false, awarded: 1.33 });
    // all right plus one wrong: (3 - 1) / 3, not full marks
    expect(auto(msPartial, { type: 'multiple_select', optionIds: ['a', 'b', 'c', 'e'] })).toMatchObject({ correct: false, awarded: 2.67 });
    // more wrong than right floors at zero
    expect(auto(msPartial, { type: 'multiple_select', optionIds: ['a', 'd', 'e'] })).toMatchObject({ correct: false, awarded: 0 });
  });

  it('true/false compares the boolean', () => {
    expect(auto(tf, { type: 'true_false', value: false }, 1)).toMatchObject({ correct: true, awarded: 1 });
    expect(auto(tf, { type: 'true_false', value: true }, 1)).toMatchObject({ correct: false, awarded: 0 });
  });

  it('short answers normalise case, whitespace and trailing punctuation', () => {
    for (const text of ['100', ' 100 ', 'One Hundred', 'one   hundred', 'ONE HUNDRED.', 'one hundred!']) {
      expect(auto(sa, { type: 'short_answer', text }, 1)).toMatchObject({ correct: true });
    }
    expect(auto(sa, { type: 'short_answer', text: '10' }, 1)).toMatchObject({ correct: false });
    expect(auto(sa, { type: 'short_answer', text: '1 00' }, 1)).toMatchObject({ correct: false });
  });

  it('short answers can be case sensitive and whitespace exact', () => {
    const strict = def({
      type: 'short_answer',
      config: { grading: 'auto', acceptedAnswers: ['RCV'], caseSensitive: true, normalizeWhitespace: false, maxLength: 20 },
    });
    expect(auto(strict, { type: 'short_answer', text: 'RCV' }, 1)).toMatchObject({ correct: true });
    expect(auto(strict, { type: 'short_answer', text: 'rcv' }, 1)).toMatchObject({ correct: false });
    expect(normalizeShortAnswer('  A  b ', { caseSensitive: true, normalizeWhitespace: false })).toBe('  A  b ');
    expect(normalizeShortAnswer('  A  b ', { caseSensitive: false, normalizeWhitespace: true })).toBe('a b');
  });

  it('open question types wait for a reviewer', () => {
    const manualShort = def({ type: 'short_answer', config: { grading: 'manual', acceptedAnswers: [], maxLength: 100 } });
    expect(gradeResponse(manualShort, { type: 'short_answer', text: 'x' }, 1).kind).toBe('review');
    expect(gradeResponse(la, { type: 'long_answer', text: 'an answer' }, 4).kind).toBe('review');
    expect(gradeResponse(scOpen, { type: 'scenario', text: 'an answer' }, 2).kind).toBe('review');
    expect(assessment.requiresManualReview(scOpen)).toBe(true);
    expect(assessment.requiresManualReview(scChoice)).toBe(false);
    expect(assessment.requiresManualReview(sa)).toBe(false);
  });

  it('scenario with a multiple choice sub-question grades automatically', () => {
    expect(auto(scChoice, { type: 'scenario', optionId: 'a' }, 2)).toMatchObject({ correct: true, awarded: 2 });
    expect(auto(scChoice, { type: 'scenario', optionId: 'b' }, 2)).toMatchObject({ correct: false, awarded: 0 });
  });

  it('ordering scores the share of items in the right position', () => {
    expect(auto(ord, { type: 'ordering', order: ['one', 'two', 'three', 'four'] })).toMatchObject({ correct: true, awarded: 4 });
    expect(auto(ord, { type: 'ordering', order: ['two', 'one', 'three', 'four'] })).toEqual({ kind: 'auto', correct: false, awarded: 2 });
    expect(auto(ord, { type: 'ordering', order: ['four', 'three', 'two', 'one'] })).toMatchObject({ awarded: 0 });
    const strict = def({ type: 'ordering', config: { scoring: 'all_or_nothing', items: [{ id: 'x', text: 'X' }, { id: 'y', text: 'Y' }, { id: 'z', text: 'Z' }] } });
    expect(auto(strict, { type: 'ordering', order: ['x', 'z', 'y'] }, 3)).toMatchObject({ correct: false, awarded: 0 });
  });

  it('matching scores the share of correct pairs', () => {
    const all = { l1: 'r1', l2: 'r2', l3: 'r3', l4: 'r4' };
    expect(auto(match, { type: 'matching', matches: all })).toMatchObject({ correct: true, awarded: 4 });
    expect(auto(match, { type: 'matching', matches: { ...all, l1: 'r2', l2: 'r1' } })).toMatchObject({ correct: false, awarded: 2 });
    expect(auto(match, { type: 'matching', matches: { l1: 'r1' } })).toMatchObject({ correct: false, awarded: 1 });
  });

  it('exposes the answer key per type', () => {
    expect(correctAnswer(mc)).toEqual({ type: 'multiple_choice', optionId: 'a' });
    expect(correctAnswer(msAll)).toEqual({ type: 'multiple_select', optionIds: ['a', 'b', 'c'] });
    expect(correctAnswer(ord)).toEqual({ type: 'ordering', order: ['one', 'two', 'three', 'four'] });
    expect(correctAnswer(match)).toEqual({ type: 'matching', matches: { l1: 'r1', l2: 'r2', l3: 'r3', l4: 'r4' } });
    expect(correctAnswer(scOpen)).toMatchObject({ type: 'scenario', optionId: null });
  });
});

describe('response validation', () => {
  it('rejects answers that do not fit the question', () => {
    expect(validateResponse(mc, { type: 'true_false', value: true })).toMatch(/does not fit/);
    expect(validateResponse(mc, { type: 'multiple_choice', optionId: 'zzz' })).toMatch(/does not belong/);
    expect(validateResponse(msPartial, { type: 'multiple_select', optionIds: ['a', 'a'] })).toMatch(/only once/);
    expect(validateResponse(sa, { type: 'short_answer', text: 'x'.repeat(61) })).toMatch(/60 characters/);
    expect(validateResponse(la, { type: 'long_answer', text: Array(301).fill('word').join(' ') })).toMatch(/300 words/);
    expect(validateResponse(ord, { type: 'ordering', order: ['one', 'two'] })).toMatch(/every item/);
    expect(validateResponse(ord, { type: 'ordering', order: ['one', 'one', 'two', 'three'] })).toMatch(/every item/);
    expect(validateResponse(match, { type: 'matching', matches: { l1: 'r1', l2: 'r1' } })).toMatch(/only once/);
    expect(validateResponse(scChoice, { type: 'scenario', text: 'free text' })).toMatch(/Choose one/);
    expect(validateResponse(scOpen, { type: 'scenario', optionId: 'a' })).toMatch(/Write your response/);
  });

  it('accepts partial work in progress and valid answers', () => {
    expect(validateResponse(match, { type: 'matching', matches: { l1: 'r3' } })).toBeNull();
    expect(validateResponse(msPartial, { type: 'multiple_select', optionIds: [] })).toBeNull();
    expect(validateResponse(ord, { type: 'ordering', order: ['four', 'one', 'three', 'two'] })).toBeNull();
    expect(isAnswered({ type: 'matching', matches: {} })).toBe(false);
    expect(isAnswered({ type: 'true_false', value: false })).toBe(true);
  });
});

describe('option order snapshots', () => {
  it('is reproducible for a seed and never leaks the answer for ordering', () => {
    const a = initialOrder(mc, true, seededRng('attempt-1'));
    const b = initialOrder(mc, true, seededRng('attempt-1'));
    expect(a).toEqual(b);
    expect([...(a.options ?? [])].sort()).toEqual(['a', 'b', 'c', 'd']);
    expect(initialOrder(mc, false, seededRng('x')).options).toEqual(['a', 'b', 'c', 'd']);
    for (let i = 0; i < 25; i++) {
      expect(initialOrder(ord, false, seededRng(`o${i}`)).items).not.toEqual(['one', 'two', 'three', 'four']);
    }
  });

  it('renders options in the snapshotted order without the answer key', () => {
    const view = learnerQuestion(mc, { options: ['c', 'a', 'd', 'b'] }, { id: 'id', position: 1, prompt: 'p', points: 1, response: null, savedAt: null });
    expect(view.type).toBe('multiple_choice');
    if (view.type !== 'multiple_choice') return;
    expect(view.options.map((o) => o.id)).toEqual(['c', 'a', 'd', 'b']);
    expect(JSON.stringify(view)).not.toContain('correct');
    const matchView = learnerQuestion(match, { choices: ['r4', 'r2', 'r1', 'r3'] }, { id: 'id', position: 1, prompt: 'p', points: 1, response: null, savedAt: null });
    if (matchView.type !== 'matching') throw new Error('expected matching');
    expect(matchView.prompts.map((p) => p.id)).toEqual(['l1', 'l2', 'l3', 'l4']);
    expect(matchView.choices.map((c) => c.id)).toEqual(['r4', 'r2', 'r1', 'r3']);
  });

  it('shuffles without losing items', () => {
    const items = Array.from({ length: 20 }, (_, i) => i);
    const shuffled = shuffle(items, seededRng('s'));
    expect([...shuffled].sort((x, y) => x - y)).toEqual(items);
    expect(shuffled).not.toEqual(items);
  });
});

describe('pool allocation', () => {
  it('finds an assignment when overlapping pools make a greedy draw fail', () => {
    // Pool A can only use q1; pool B (2 questions) can use q1..q3. Greedy B-first could take q1.
    const result = allocatePools([
      { key: 'B', count: 2, candidates: ['q1', 'q2', 'q3'] },
      { key: 'A', count: 1, candidates: ['q1'] },
    ]);
    expect(result.ok).toBe(true);
    expect(result.assigned.get('A')).toEqual(['q1']);
    expect(result.assigned.get('B')!.sort()).toEqual(['q2', 'q3']);
  });

  it('reports which pool falls short when the pools cannot be satisfied together', () => {
    const result = allocatePools([
      { key: 'A', count: 2, candidates: ['q1', 'q2'] },
      { key: 'B', count: 2, candidates: ['q2', 'q3'] },
    ]);
    expect(result.ok).toBe(false);
    expect(result.shortfalls).toHaveLength(1);
    expect(result.shortfalls[0]).toMatchObject({ required: 2, assigned: 1 });
  });

  it('draws distinct questions at random', () => {
    const candidates = Array.from({ length: 12 }, (_, i) => `q${i}`);
    const draws = new Set<string>();
    for (let i = 0; i < 20; i++) {
      const result = allocatePools([{ key: 'p', count: 4, candidates }], seededRng(`draw-${i}`));
      const chosen = result.assigned.get('p')!;
      expect(new Set(chosen).size).toBe(4);
      draws.add([...chosen].sort().join());
    }
    expect(draws.size).toBeGreaterThan(5);
  });
});

describe('policies', () => {
  it('computes percentages and pass marks without rounding surprises', () => {
    expect(scorePercent(7, 8)).toBe(87.5);
    expect(scorePercent(2, 3)).toBe(66.67);
    expect(isPassing(80, 80)).toBe(true);
    expect(isPassing(79.99, 80)).toBe(false);
  });

  it('applies reveal policies', () => {
    const state = (over: Partial<Parameters<typeof answersRevealed>[1]> = {}) => ({ closed: true, passed: false, attemptsUsed: 1, maxAttempts: 3, ...over });
    expect(answersRevealed('never', state({ passed: true }))).toBe(false);
    expect(answersRevealed('after_submit', state())).toBe(true);
    expect(answersRevealed('after_submit', state({ closed: false }))).toBe(false);
    expect(answersRevealed('after_pass', state())).toBe(false);
    expect(answersRevealed('after_pass', state({ passed: true }))).toBe(true);
    expect(answersRevealed('after_final_attempt', state())).toBe(false);
    expect(answersRevealed('after_final_attempt', state({ attemptsUsed: 3 }))).toBe(true);
    expect(answersRevealed('after_final_attempt', state({ attemptsUsed: 50, maxAttempts: null }))).toBe(false);
  });

  it('phrases waits for learners', () => {
    const now = new Date('2026-10-05T15:00:00Z');
    expect(waitPhrase(new Date(now.getTime() + 30_000), now)).toBe('1 minute');
    expect(waitPhrase(new Date(now.getTime() + 10 * 60_000), now)).toBe('10 minutes');
    expect(waitPhrase(new Date(now.getTime() + 65 * 60_000), now)).toBe('1 hour 5 minutes');
    expect(waitPhrase(new Date(now.getTime() + 24 * 3_600_000), now)).toBe('24 hours');
  });
});

describe('question contracts', () => {
  const parse = (body: Record<string, unknown>) => assessment.createQuestionRequestSchema.safeParse({ bankId: '0190a3b2-0000-7000-8000-000000000001', ...body });

  it('accepts every sample question type', () => {
    const samples = [
      sampleQuestions.multipleChoice('x'),
      sampleQuestions.multipleSelect('x', 'all_or_nothing'),
      sampleQuestions.multipleSelect('x', 'partial'),
      sampleQuestions.trueFalse('x'),
      sampleQuestions.shortAnswer('x'),
      sampleQuestions.longAnswer('x'),
      sampleQuestions.scenarioChoice('x'),
      sampleQuestions.scenarioOpen('x'),
      sampleQuestions.ordering('x'),
      sampleQuestions.matching('x'),
    ];
    for (const sample of samples) {
      const parsed = parse(sample);
      expect(parsed.success, `${sample.type}: ${parsed.success ? '' : JSON.stringify(parsed.error.issues)}`).toBe(true);
    }
  });

  it('requires exactly one correct option for multiple choice', () => {
    const none = sampleQuestions.multipleChoice('x', { config: { options: [{ id: 'a', text: 'A', correct: false }, { id: 'b', text: 'B', correct: false }] } });
    const two = sampleQuestions.multipleChoice('x', { config: { options: [{ id: 'a', text: 'A', correct: true }, { id: 'b', text: 'B', correct: true }] } });
    expect(parse(none).success).toBe(false);
    expect(parse(two).success).toBe(false);
  });

  it('rejects duplicate option ids and a single option', () => {
    const dup = sampleQuestions.multipleChoice('x', { config: { options: [{ id: 'a', text: 'A', correct: true }, { id: 'a', text: 'B', correct: false }] } });
    const single = sampleQuestions.multipleChoice('x', { config: { options: [{ id: 'a', text: 'A', correct: true }] } });
    expect(parse(dup).success).toBe(false);
    expect(parse(single).success).toBe(false);
  });

  it('requires accepted answers for automatically graded short answers', () => {
    const empty = sampleQuestions.shortAnswer('x', { config: { grading: 'auto', acceptedAnswers: [] } });
    const manual = sampleQuestions.shortAnswer('x', { config: { grading: 'manual', acceptedAnswers: [] } });
    expect(parse(empty).success).toBe(false);
    expect(parse(manual).success).toBe(true);
  });

  it('validates long answer word limits and normalises tags', () => {
    const bad = sampleQuestions.longAnswer('x', { config: { rubric: 'r', minWords: 50, maxWords: 10 } });
    expect(parse(bad).success).toBe(false);
    const tagged = parse(sampleQuestions.trueFalse('x', { tags: ['Hail', ' hail ', 'Week-2'] }));
    expect(tagged.success && tagged.data.tags).toEqual(['hail', 'week-2']);
  });
});
