import { describe, expect, it } from 'vitest';
import type { assessment } from '@a5/contracts';
import {
  appendQuestions,
  describePoolFilters,
  fixedQuestionIds,
  moveRequestItem,
  toRequestItems,
} from './item-model';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const question = (n: number, points: number | null = null): assessment.AssessmentItem => ({
  id: uuid(100 + n),
  position: n,
  kind: 'question',
  points,
  question: {
    id: uuid(n),
    status: 'active',
    version: 1,
    type: 'multiple_choice',
    prompt: `Question ${n}`,
    difficulty: 'medium',
    points: 1,
    category: null,
  },
});

const pool: assessment.AssessmentItem = {
  id: uuid(200),
  position: 3,
  kind: 'pool',
  points: 2,
  bank: { id: uuid(300), title: 'A5 Sales Core' },
  category: { id: uuid(301), name: 'Storm damage' },
  difficulty: 'hard',
  tags: ['hail', 'wind'],
  count: 2,
  available: 9,
};

const items = [question(1), question(2, 2.5), pool];

describe('toRequestItems', () => {
  it('keeps item ids and renumbers positions from 1', () => {
    expect(toRequestItems(items)).toEqual([
      { kind: 'question', id: uuid(101), questionId: uuid(1), points: null, position: 1 },
      { kind: 'question', id: uuid(102), questionId: uuid(2), points: 2.5, position: 2 },
      {
        kind: 'pool',
        id: uuid(200),
        bankId: uuid(300),
        categoryId: uuid(301),
        difficulty: 'hard',
        tags: ['hail', 'wind'],
        count: 2,
        points: 2,
        position: 3,
      },
    ]);
  });
});

describe('moveRequestItem', () => {
  it('moves an item up or down', () => {
    expect(moveRequestItem(items, 1, -1).map((i) => i.id)).toEqual([
      uuid(102),
      uuid(101),
      uuid(200),
    ]);
    expect(moveRequestItem(items, 1, 1).map((i) => i.id)).toEqual([
      uuid(101),
      uuid(200),
      uuid(102),
    ]);
  });

  it('numbers positions after a move', () => {
    expect(moveRequestItem(items, 2, -1).map((i) => i.position)).toEqual([1, 2, 3]);
  });

  it('leaves the order alone at either end', () => {
    expect(moveRequestItem(items, 0, -1).map((i) => i.id)).toEqual(items.map((i) => i.id));
    expect(moveRequestItem(items, 2, 1).map((i) => i.id)).toEqual(items.map((i) => i.id));
  });
});

describe('appendQuestions', () => {
  it('adds new questions after the existing items', () => {
    const next = appendQuestions(items, [uuid(7), uuid(8)]);
    expect(next).toHaveLength(5);
    expect(next[3]).toEqual({ kind: 'question', questionId: uuid(7), points: null, position: 4 });
    expect(next[4]).toMatchObject({ questionId: uuid(8), position: 5 });
  });

  it('skips a question that is already in the assessment', () => {
    expect(appendQuestions(items, [uuid(1), uuid(9)])).toHaveLength(4);
  });
});

describe('helpers', () => {
  it('lists the fixed questions', () => {
    expect([...fixedQuestionIds(items)]).toEqual([uuid(1), uuid(2)]);
  });

  it('describes a random draw in plain words', () => {
    expect(describePoolFilters(pool as Extract<assessment.AssessmentItem, { kind: 'pool' }>)).toBe(
      'Category: Storm damage · Difficulty: hard · Tagged hail, wind',
    );
    expect(
      describePoolFilters({
        ...(pool as Extract<assessment.AssessmentItem, { kind: 'pool' }>),
        category: null,
        difficulty: null,
        tags: [],
      }),
    ).toBe('Any category · Any difficulty');
  });
});
