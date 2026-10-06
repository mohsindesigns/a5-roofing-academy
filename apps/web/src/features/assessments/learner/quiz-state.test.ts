import { describe, expect, it } from 'vitest';
import { learnerQuestions } from '../test-fixtures';
import {
  countAnswered,
  initialAnswers,
  isAnswered,
  moveItem,
  nextUnanswered,
  normalizeResponse,
  orderingItems,
  responseProblem,
  unansweredIndexes,
  usedChoices,
  wordCount,
} from './quiz-state';

const questions = learnerQuestions();
const q = (type: string) => questions.find((x) => x.type === type)!;

describe('isAnswered', () => {
  it('treats empty selections and blank text as unanswered', () => {
    expect(isAnswered(null)).toBe(false);
    expect(isAnswered({ type: 'multiple_select', optionIds: [] })).toBe(false);
    expect(isAnswered({ type: 'short_answer', text: '   ' })).toBe(false);
    expect(isAnswered({ type: 'long_answer', text: '' })).toBe(false);
    expect(isAnswered({ type: 'matching', matches: {} })).toBe(false);
    expect(isAnswered({ type: 'scenario', text: ' ' })).toBe(false);
  });

  it('counts real answers, including false', () => {
    expect(isAnswered({ type: 'true_false', value: false })).toBe(true);
    expect(isAnswered({ type: 'multiple_choice', optionId: 'a' })).toBe(true);
    expect(isAnswered({ type: 'multiple_select', optionIds: ['a'] })).toBe(true);
    expect(isAnswered({ type: 'scenario', optionId: 'x' })).toBe(true);
    expect(isAnswered({ type: 'ordering', order: ['i1', 'i2', 'i3'] })).toBe(true);
    expect(isAnswered({ type: 'matching', matches: { p1: 'c1' } })).toBe(true);
  });
});

describe('normalizeResponse', () => {
  it('turns an emptied input into a cleared answer', () => {
    expect(normalizeResponse({ type: 'short_answer', text: '' })).toBeNull();
    expect(normalizeResponse({ type: 'multiple_select', optionIds: [] })).toBeNull();
    expect(normalizeResponse({ type: 'short_answer', text: 'A5' })).toEqual({
      type: 'short_answer',
      text: 'A5',
    });
  });
});

describe('progress helpers', () => {
  it('starts from the answers the server already holds', () => {
    const resumed = questions.map((x, i) =>
      i === 0 ? { ...x, response: { type: 'multiple_choice' as const, optionId: 'a' } } : x,
    );
    const answers = initialAnswers(resumed);
    expect(countAnswered(resumed, answers)).toBe(1);
    expect(unansweredIndexes(resumed, answers)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('finds the next unanswered question after the current one, wrapping around', () => {
    const answers = initialAnswers(questions);
    answers[questions[0]!.id] = { type: 'multiple_choice', optionId: 'a' };
    answers[questions[2]!.id] = { type: 'true_false', value: true };
    expect(nextUnanswered(questions, answers, 0)).toBe(1);
    expect(nextUnanswered(questions, answers, 1)).toBe(3);
    expect(nextUnanswered(questions, answers, 7)).toBe(1);
    for (const x of questions) answers[x.id] = { type: 'true_false', value: true };
    expect(nextUnanswered(questions, answers, 0)).toBeNull();
  });
});

describe('responseProblem', () => {
  it('flags text that the server would refuse', () => {
    expect(
      responseProblem(q('short_answer'), { type: 'short_answer', text: 'x'.repeat(21) }),
    ).toMatch(/20 characters/);
    expect(
      responseProblem(q('short_answer'), { type: 'short_answer', text: 'x'.repeat(20) }),
    ).toBeNull();
    const words = (n: number) => Array.from({ length: n }, () => 'word').join(' ');
    expect(responseProblem(q('long_answer'), { type: 'long_answer', text: words(13) })).toMatch(
      /12 words/,
    );
    expect(responseProblem(q('long_answer'), { type: 'long_answer', text: words(12) })).toBeNull();
  });

  it('does not enforce the suggested minimum', () => {
    expect(responseProblem(q('long_answer'), { type: 'long_answer', text: 'short' })).toBeNull();
  });

  it('never flags a cleared answer', () => {
    expect(responseProblem(q('long_answer'), null)).toBeNull();
  });
});

describe('wordCount', () => {
  it('ignores extra whitespace', () => {
    expect(wordCount('  one   two\nthree ')).toBe(3);
    expect(wordCount('')).toBe(0);
  });
});

describe('ordering helpers', () => {
  const ordering = q('ordering') as Extract<
    ReturnType<typeof learnerQuestions>[number],
    { type: 'ordering' }
  >;

  it('moves an item up or down and stays within bounds', () => {
    expect(moveItem(['a', 'b', 'c'], 1, -1)).toEqual(['b', 'a', 'c']);
    expect(moveItem(['a', 'b', 'c'], 1, 1)).toEqual(['a', 'c', 'b']);
    expect(moveItem(['a', 'b', 'c'], 0, -1)).toEqual(['a', 'b', 'c']);
    expect(moveItem(['a', 'b', 'c'], 2, 1)).toEqual(['a', 'b', 'c']);
  });

  it('shows the drawn order until the learner answers, then the saved order', () => {
    expect(orderingItems(ordering, null).map((i) => i.id)).toEqual(['i3', 'i1', 'i2']);
    expect(
      orderingItems(ordering, { type: 'ordering', order: ['i1', 'i2', 'i3'] }).map((i) => i.id),
    ).toEqual(['i1', 'i2', 'i3']);
  });

  it('ignores a saved order that no longer matches the items', () => {
    expect(
      orderingItems(ordering, { type: 'ordering', order: ['i1', 'zzz', 'i3'] }).map((i) => i.id),
    ).toEqual(['i3', 'i1', 'i2']);
  });
});

describe('usedChoices', () => {
  it('lists choices taken by other prompts', () => {
    expect([...usedChoices({ p1: 'c1', p2: 'c2' }, 'p1')]).toEqual(['c2']);
  });
});
