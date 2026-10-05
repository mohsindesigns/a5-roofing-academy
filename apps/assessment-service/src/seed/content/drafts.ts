import { createHash } from 'node:crypto';
import { assessment } from '@a5/contracts';

/**
 * Authoring helpers for seed questions. Options are written as text (+ correct flag); ids are
 * derived from the question key and position with a hash, so they are stable across seeds and never
 * reveal the answer.
 */

export type Opt = readonly [text: string, correct?: boolean];

export type Draft =
  | { type: 'multiple_choice'; options: readonly Opt[] }
  | { type: 'multiple_select'; options: readonly Opt[]; scoring: assessment.ScoringMode }
  | { type: 'true_false'; answer: boolean }
  | { type: 'short_answer'; accepted: readonly string[]; grading?: 'auto' | 'manual'; guidance?: string; maxLength?: number }
  | { type: 'long_answer'; rubric: string; sampleAnswer: string; minWords?: number; maxWords?: number }
  | {
      type: 'scenario';
      scenario: string;
      sub:
        | { kind: 'multiple_choice'; prompt: string; options: readonly Opt[] }
        | { kind: 'open_response'; prompt: string; rubric: string; sampleAnswer: string; maxLength?: number };
    }
  | { type: 'ordering'; items: readonly string[]; scoring?: assessment.ScoringMode }
  | { type: 'matching'; pairs: ReadonlyArray<readonly [left: string, right: string]>; scoring?: assessment.ScoringMode };

export const mc = (...options: Opt[]): Draft => ({ type: 'multiple_choice', options });
export const ms = (scoring: assessment.ScoringMode, ...options: Opt[]): Draft => ({ type: 'multiple_select', scoring, options });
export const tf = (answer: boolean): Draft => ({ type: 'true_false', answer });
export const ordering = (items: string[], scoring: assessment.ScoringMode = 'all_or_nothing'): Draft => ({ type: 'ordering', items, scoring });
export const matching = (pairs: Array<readonly [string, string]>, scoring: assessment.ScoringMode = 'all_or_nothing'): Draft => ({
  type: 'matching',
  pairs,
  scoring,
});

export function choiceId(questionKey: string, slot: string): string {
  return createHash('sha1').update(`a5-seed-choice:${questionKey}:${slot}`).digest('hex').slice(0, 10);
}

function options(key: string, prefix: string, list: readonly Opt[]) {
  return list.map(([text, correct], i) => ({ id: `${prefix}${choiceId(key, `${prefix}${i}`)}`, text, correct: correct === true }));
}

/** Turn an authored draft into a validated question definition (defaults applied). */
export function materialize(key: string, draft: Draft): assessment.QuestionDefinition {
  let def: unknown;
  switch (draft.type) {
    case 'multiple_choice':
      def = { type: draft.type, config: { options: options(key, 'o', draft.options) } };
      break;
    case 'multiple_select':
      def = { type: draft.type, config: { options: options(key, 'o', draft.options), scoring: draft.scoring } };
      break;
    case 'true_false':
      def = { type: draft.type, config: { correctAnswer: draft.answer } };
      break;
    case 'short_answer':
      def = {
        type: draft.type,
        config: {
          grading: draft.grading ?? 'auto',
          acceptedAnswers: [...draft.accepted],
          caseSensitive: false,
          normalizeWhitespace: true,
          maxLength: draft.maxLength ?? 200,
          reviewGuidance: draft.guidance ?? null,
        },
      };
      break;
    case 'long_answer':
      def = {
        type: draft.type,
        config: { rubric: draft.rubric, sampleAnswer: draft.sampleAnswer, minWords: draft.minWords ?? null, maxWords: draft.maxWords ?? null },
      };
      break;
    case 'scenario':
      def = {
        type: draft.type,
        config: {
          scenario: draft.scenario,
          subQuestion:
            draft.sub.kind === 'multiple_choice'
              ? { kind: 'multiple_choice', prompt: draft.sub.prompt, options: options(key, 'o', draft.sub.options) }
              : { kind: 'open_response', prompt: draft.sub.prompt, rubric: draft.sub.rubric, sampleAnswer: draft.sub.sampleAnswer, maxLength: draft.sub.maxLength ?? 2000 },
        },
      };
      break;
    case 'ordering':
      def = {
        type: draft.type,
        config: { items: draft.items.map((text, i) => ({ id: `i${choiceId(key, `i${i}`)}`, text })), scoring: draft.scoring ?? 'all_or_nothing' },
      };
      break;
    case 'matching':
      def = {
        type: draft.type,
        config: {
          pairs: draft.pairs.map(([left, right], i) => ({
            leftId: `l${choiceId(key, `l${i}`)}`,
            left,
            rightId: `r${choiceId(key, `r${i}`)}`,
            right,
          })),
          scoring: draft.scoring ?? 'all_or_nothing',
        },
      };
      break;
  }
  return assessment.questionDefinitionSchema.parse(def);
}
