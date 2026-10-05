import type { assessment } from '@a5/contracts';
import { shuffle, type Rng } from './random.js';

/**
 * Question type registry: everything that differs per type (learner rendering, response validation,
 * grading, answer key, option shuffling) lives here, so adding a type is one new case per function
 * plus its Zod schema in @a5/contracts.
 */

type Def = assessment.QuestionDefinition;
type Response = assessment.AnswerResponse;
type OptionOrder = assessment.OptionOrder;
type LearnerQuestion = assessment.LearnerQuestion;
type CorrectAnswer = assessment.CorrectAnswer;

export type Grade =
  | { kind: 'auto'; correct: boolean; awarded: number }
  /** A person grades this answer. */
  | { kind: 'review' };

export function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/** Stored question versions were validated on write; this narrows the row to the typed union. */
export function toDefinition(row: { type: assessment.QuestionType; config: unknown }): Def {
  return { type: row.type, config: row.config } as Def;
}

function choiceOptions(def: Def): assessment.ChoiceOption[] | null {
  if (def.type === 'multiple_choice' || def.type === 'multiple_select') return def.config.options;
  if (def.type === 'scenario' && def.config.subQuestion.kind === 'multiple_choice') return def.config.subQuestion.options;
  return null;
}

/** A shuffled order that differs from the authored one whenever possible. */
function shuffledAwayFrom(ids: string[], rng: Rng): string[] {
  const out = shuffle(ids, rng);
  if (ids.length > 1 && out.every((id, i) => id === ids[i])) out.push(out.shift()!);
  return out;
}

/** Option order drawn for an attempt. Ordering and matching are always shuffled. */
export function initialOrder(def: Def, randomizeOptions: boolean, rng: Rng): OptionOrder {
  const options = choiceOptions(def);
  if (options) {
    const ids = options.map((o) => o.id);
    return { options: randomizeOptions ? shuffle(ids, rng) : ids };
  }
  if (def.type === 'ordering') return { items: shuffledAwayFrom(def.config.items.map((i) => i.id), rng) };
  if (def.type === 'matching') return { choices: shuffledAwayFrom(def.config.pairs.map((p) => p.rightId), rng) };
  return {};
}

/** Order the authored entries by a snapshot; entries missing from the snapshot keep authored order at the end. */
function ordered<T>(entries: readonly T[], key: (e: T) => string, order: readonly string[] | undefined): T[] {
  if (!order) return [...entries];
  const rank = new Map(order.map((id, i) => [id, i]));
  return [...entries].sort((a, b) => (rank.get(key(a)) ?? Number.MAX_SAFE_INTEGER) - (rank.get(key(b)) ?? Number.MAX_SAFE_INTEGER));
}

export interface LearnerBase {
  id: string;
  position: number;
  prompt: string;
  points: number;
  response: Response | null;
  savedAt: string | null;
}

/** The question as a learner sees it: snapshotted option order, no answer key, no rubric. */
export function learnerQuestion(def: Def, order: OptionOrder, base: LearnerBase): LearnerQuestion {
  const view = (o: { id: string; text: string }) => ({ id: o.id, text: o.text });
  switch (def.type) {
    case 'multiple_choice':
    case 'multiple_select':
      return { ...base, type: def.type, options: ordered(def.config.options, (o) => o.id, order.options).map(view) } as LearnerQuestion;
    case 'true_false':
      return { ...base, type: 'true_false' };
    case 'short_answer':
      return { ...base, type: 'short_answer', maxLength: def.config.maxLength };
    case 'long_answer':
      return { ...base, type: 'long_answer', minWords: def.config.minWords, maxWords: def.config.maxWords };
    case 'scenario': {
      const sub = def.config.subQuestion;
      return {
        ...base,
        type: 'scenario',
        scenario: def.config.scenario,
        subQuestion:
          sub.kind === 'multiple_choice'
            ? { kind: 'multiple_choice', prompt: sub.prompt, options: ordered(sub.options, (o) => o.id, order.options).map(view) }
            : { kind: 'open_response', prompt: sub.prompt, maxLength: sub.maxLength },
      };
    }
    case 'ordering':
      return { ...base, type: 'ordering', items: ordered(def.config.items, (i) => i.id, order.items).map(view) };
    case 'matching': {
      const pairs = def.config.pairs;
      return {
        ...base,
        type: 'matching',
        prompts: pairs.map((p) => ({ id: p.leftId, text: p.left })),
        choices: ordered(pairs, (p) => p.rightId, order.choices).map((p) => ({ id: p.rightId, text: p.right })),
      };
    }
  }
}

export function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/** True when the response contains an actual answer (an empty selection or blank text is no answer). */
export function isAnswered(response: Response | null): boolean {
  if (!response) return false;
  switch (response.type) {
    case 'multiple_select':
      return response.optionIds.length > 0;
    case 'short_answer':
    case 'long_answer':
      return response.text.trim().length > 0;
    case 'scenario':
      return response.optionId !== undefined || (response.text ?? '').trim().length > 0;
    case 'ordering':
      return response.order.length > 0;
    case 'matching':
      return Object.keys(response.matches).length > 0;
    default:
      return true;
  }
}

/**
 * Check that a response fits the question. Returns a message for the learner, or null when valid.
 * Partially completed answers (e.g. some matches) are valid so autosave can store work in progress.
 */
export function validateResponse(def: Def, response: Response): string | null {
  if (response.type !== def.type) return 'This answer does not fit the question type. Reload the question and try again.';
  const unknownOption = 'One of the selected options does not belong to this question. Reload the question and try again.';
  switch (response.type) {
    case 'multiple_choice': {
      const ids = new Set((def as Extract<Def, { type: 'multiple_choice' }>).config.options.map((o) => o.id));
      return ids.has(response.optionId) ? null : unknownOption;
    }
    case 'multiple_select': {
      const ids = new Set((def as Extract<Def, { type: 'multiple_select' }>).config.options.map((o) => o.id));
      if (new Set(response.optionIds).size !== response.optionIds.length) return 'Each option can be selected only once.';
      return response.optionIds.every((id) => ids.has(id)) ? null : unknownOption;
    }
    case 'true_false':
      return null;
    case 'short_answer': {
      const max = (def as Extract<Def, { type: 'short_answer' }>).config.maxLength;
      return response.text.length > max ? `Keep your answer to ${max} characters or fewer.` : null;
    }
    case 'long_answer': {
      const max = (def as Extract<Def, { type: 'long_answer' }>).config.maxWords;
      return max !== null && wordCount(response.text) > max ? `Keep your answer to ${max} words or fewer.` : null;
    }
    case 'scenario': {
      const sub = (def as Extract<Def, { type: 'scenario' }>).config.subQuestion;
      if (sub.kind === 'multiple_choice') {
        if (response.optionId === undefined) return 'Choose one of the options for this scenario.';
        return sub.options.some((o) => o.id === response.optionId) ? null : unknownOption;
      }
      if (response.text === undefined) return 'Write your response to this scenario.';
      return response.text.length > sub.maxLength ? `Keep your response to ${sub.maxLength} characters or fewer.` : null;
    }
    case 'ordering': {
      const ids = (def as Extract<Def, { type: 'ordering' }>).config.items.map((i) => i.id);
      const given = response.order;
      const valid = given.length === ids.length && new Set(given).size === given.length && given.every((id) => ids.includes(id));
      return valid ? null : 'Place every item exactly once.';
    }
    case 'matching': {
      const pairs = (def as Extract<Def, { type: 'matching' }>).config.pairs;
      const left = new Set(pairs.map((p) => p.leftId));
      const right = new Set(pairs.map((p) => p.rightId));
      const entries = Object.entries(response.matches);
      if (!entries.every(([l, r]) => left.has(l) && right.has(r))) return unknownOption;
      const used = entries.map(([, r]) => r);
      return new Set(used).size === used.length ? null : 'Each answer on the right can be used only once.';
    }
  }
}

export function normalizeShortAnswer(text: string, config: { caseSensitive: boolean; normalizeWhitespace: boolean }): string {
  let value = text.normalize('NFKC');
  value = config.normalizeWhitespace ? value.trim().replace(/\s+/g, ' ') : value;
  // Trailing sentence punctuation never changes the meaning of a short answer.
  value = value.replace(/[.!?]+$/u, '');
  return config.caseSensitive ? value : value.toLocaleLowerCase('en-US');
}

function ratioGrade(ratio: number, points: number): Grade {
  const bounded = Math.min(1, Math.max(0, ratio));
  return { kind: 'auto', correct: bounded >= 1, awarded: round2(points * bounded) };
}

/** Grade one answer. Unanswered questions score zero and never need review. */
export function gradeResponse(def: Def, response: Response | null, points: number): Grade {
  if (!isAnswered(response) || !response || response.type !== def.type) return { kind: 'auto', correct: false, awarded: 0 };
  switch (def.type) {
    case 'multiple_choice': {
      const r = response as Extract<Response, { type: 'multiple_choice' }>;
      const correct = def.config.options.find((o) => o.correct)?.id === r.optionId;
      return ratioGrade(correct ? 1 : 0, points);
    }
    case 'multiple_select': {
      const r = response as Extract<Response, { type: 'multiple_select' }>;
      const correctIds = new Set(def.config.options.filter((o) => o.correct).map((o) => o.id));
      const selected = new Set(r.optionIds);
      const hits = [...selected].filter((id) => correctIds.has(id)).length;
      const wrong = selected.size - hits;
      const exact = hits === correctIds.size && wrong === 0;
      if (def.config.scoring === 'all_or_nothing') return ratioGrade(exact ? 1 : 0, points);
      return exact ? ratioGrade(1, points) : ratioGrade((hits - wrong) / correctIds.size, points);
    }
    case 'true_false': {
      const r = response as Extract<Response, { type: 'true_false' }>;
      return ratioGrade(r.value === def.config.correctAnswer ? 1 : 0, points);
    }
    case 'short_answer': {
      if (def.config.grading === 'manual') return { kind: 'review' };
      const r = response as Extract<Response, { type: 'short_answer' }>;
      const given = normalizeShortAnswer(r.text, def.config);
      const match = def.config.acceptedAnswers.some((a) => normalizeShortAnswer(a, def.config) === given);
      return ratioGrade(match ? 1 : 0, points);
    }
    case 'long_answer':
      return { kind: 'review' };
    case 'scenario': {
      const sub = def.config.subQuestion;
      if (sub.kind === 'open_response') return { kind: 'review' };
      const r = response as Extract<Response, { type: 'scenario' }>;
      return ratioGrade(sub.options.find((o) => o.correct)?.id === r.optionId ? 1 : 0, points);
    }
    case 'ordering': {
      const r = response as Extract<Response, { type: 'ordering' }>;
      const expected = def.config.items.map((i) => i.id);
      const inPlace = expected.filter((id, i) => r.order[i] === id).length;
      if (def.config.scoring === 'all_or_nothing') return ratioGrade(inPlace === expected.length ? 1 : 0, points);
      return ratioGrade(inPlace / expected.length, points);
    }
    case 'matching': {
      const r = response as Extract<Response, { type: 'matching' }>;
      const pairs = def.config.pairs;
      const right = pairs.filter((p) => r.matches[p.leftId] === p.rightId).length;
      if (def.config.scoring === 'all_or_nothing') return ratioGrade(right === pairs.length ? 1 : 0, points);
      return ratioGrade(right / pairs.length, points);
    }
  }
}

/** Whether an answered question goes to a reviewer. */
export function needsReview(def: Def, response: Response | null): boolean {
  return isAnswered(response) && gradeResponse(def, response, 1).kind === 'review';
}

export function correctAnswer(def: Def): CorrectAnswer {
  switch (def.type) {
    case 'multiple_choice':
      return { type: 'multiple_choice', optionId: def.config.options.find((o) => o.correct)!.id };
    case 'multiple_select':
      return { type: 'multiple_select', optionIds: def.config.options.filter((o) => o.correct).map((o) => o.id) };
    case 'true_false':
      return { type: 'true_false', value: def.config.correctAnswer };
    case 'short_answer':
      return { type: 'short_answer', acceptedAnswers: def.config.acceptedAnswers };
    case 'long_answer':
      return { type: 'long_answer', sampleAnswer: def.config.sampleAnswer ?? null };
    case 'scenario': {
      const sub = def.config.subQuestion;
      return sub.kind === 'multiple_choice'
        ? { type: 'scenario', optionId: sub.options.find((o) => o.correct)!.id, sampleAnswer: null }
        : { type: 'scenario', optionId: null, sampleAnswer: sub.sampleAnswer ?? null };
    }
    case 'ordering':
      return { type: 'ordering', order: def.config.items.map((i) => i.id) };
    case 'matching':
      return { type: 'matching', matches: Object.fromEntries(def.config.pairs.map((p) => [p.leftId, p.rightId])) };
  }
}

/** Learner-facing outcome of a graded (or pending) answer. */
export function outcomeOf(answer: {
  response: Response | null;
  needs_review: boolean;
  graded_at: Date | null;
  is_correct: boolean | null;
  awarded_points: number | null;
}): assessment.QuestionOutcome {
  if (answer.needs_review && !answer.graded_at) return 'pending_review';
  if (!isAnswered(answer.response)) return 'unanswered';
  if (answer.is_correct) return 'correct';
  if ((answer.awarded_points ?? 0) > 0) return 'partial';
  return 'incorrect';
}
