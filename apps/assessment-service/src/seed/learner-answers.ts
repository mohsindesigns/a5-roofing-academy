import type { assessment } from '@a5/contracts';
import { correctAnswer, gradeResponse, round2 } from '../engine/question-types.js';
import { shuffle, type Rng } from '../engine/random.js';
import type { SeedQuestion } from './content/question-bank.js';

type Def = assessment.QuestionDefinition;
type Response = assessment.AnswerResponse;

/** One way a seeded learner could answer a question, with the points it earns. */
export interface AnswerOption {
  response: Response;
  awarded: number;
  /** Trainer feedback for written answers. */
  feedback?: string;
  /** Written answers are graded by a person, not automatically. */
  reviewed?: boolean;
}

export interface PlannedQuestion {
  points: number;
  options: AnswerOption[];
}

function wrongOptionIds(options: readonly assessment.ChoiceOption[], rng: Rng): string[] {
  return shuffle(
    options.filter((o) => !o.correct).map((o) => o.id),
    rng,
  );
}

function candidates(def: Def, seed: SeedQuestion | undefined, rng: Rng): Response[] {
  const right = correctAnswer(def);
  switch (def.type) {
    case 'multiple_choice': {
      const wrong = wrongOptionIds(def.config.options, rng)[0]!;
      return [
        {
          type: 'multiple_choice',
          optionId: (right as Extract<typeof right, { type: 'multiple_choice' }>).optionId,
        },
        { type: 'multiple_choice', optionId: wrong },
      ];
    }
    case 'multiple_select': {
      const correctIds = def.config.options.filter((o) => o.correct).map((o) => o.id);
      const wrong = wrongOptionIds(def.config.options, rng);
      const out: Response[] = [
        { type: 'multiple_select', optionIds: correctIds },
        { type: 'multiple_select', optionIds: [wrong[0]!] },
      ];
      if (def.config.scoring === 'partial') {
        for (let k = 1; k < correctIds.length; k++)
          out.push({ type: 'multiple_select', optionIds: correctIds.slice(0, k) });
        out.push({ type: 'multiple_select', optionIds: [...correctIds, wrong[0]!] });
      }
      return out;
    }
    case 'true_false':
      return [
        { type: 'true_false', value: def.config.correctAnswer },
        { type: 'true_false', value: !def.config.correctAnswer },
      ];
    case 'short_answer':
      return def.config.grading === 'auto'
        ? [
            { type: 'short_answer', text: def.config.acceptedAnswers[0]! },
            { type: 'short_answer', text: seed?.commonMistake ?? 'I am not sure' },
          ]
        : [
            { type: 'short_answer', text: seed?.written?.strong ?? '' },
            { type: 'short_answer', text: seed?.written?.weak ?? '' },
          ];
    case 'long_answer':
      return [
        { type: 'long_answer', text: seed?.written?.strong ?? '' },
        { type: 'long_answer', text: seed?.written?.weak ?? '' },
      ];
    case 'scenario': {
      const sub = def.config.subQuestion;
      if (sub.kind === 'open_response') {
        return [
          { type: 'scenario', text: seed?.written?.strong ?? '' },
          { type: 'scenario', text: seed?.written?.weak ?? '' },
        ];
      }
      return [
        { type: 'scenario', optionId: sub.options.find((o) => o.correct)!.id },
        { type: 'scenario', optionId: wrongOptionIds(sub.options, rng)[0]! },
      ];
    }
    case 'ordering': {
      const order = def.config.items.map((i) => i.id);
      const rotated = [...order.slice(1), order[0]!];
      const swapped = [order[1]!, order[0]!, ...order.slice(2)];
      return [
        { type: 'ordering', order },
        { type: 'ordering', order: rotated },
        ...(def.config.scoring === 'partial'
          ? [{ type: 'ordering' as const, order: swapped }]
          : []),
      ];
    }
    case 'matching': {
      const pairs = def.config.pairs;
      const right = Object.fromEntries(pairs.map((p) => [p.leftId, p.rightId]));
      const swapped = {
        ...right,
        [pairs[0]!.leftId]: pairs[1]!.rightId,
        [pairs[1]!.leftId]: pairs[0]!.rightId,
      };
      return [
        { type: 'matching', matches: right },
        { type: 'matching', matches: swapped },
      ];
    }
  }
}

/** The answers a learner could plausibly give to a question and the points each earns (graded by the real engine). */
export function answerOptions(
  def: Def,
  seed: SeedQuestion | undefined,
  points: number,
  rng: Rng,
): AnswerOption[] {
  const out: AnswerOption[] = [];
  const responses = candidates(def, seed, rng);
  responses.forEach((response, index) => {
    const grade = gradeResponse(def, response, points);
    if (grade.kind === 'auto') {
      out.push({ response, awarded: grade.awarded });
      return;
    }
    // Written answers: index 0 is the strong answer (full marks), index 1 the weak one (rubric: 0).
    const strong = index === 0;
    out.push({
      response,
      awarded: strong ? points : 0,
      feedback: strong ? seed?.written?.strongFeedback : seed?.written?.weakFeedback,
      reviewed: true,
    });
  });
  // One option per distinct score keeps the search small without losing reachable totals.
  const seen = new Set<number>();
  return out.filter((o) => {
    const key = Math.round(o.awarded * 100);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Pick one answer per question so the attempt's score lands as close as possible to `targetPercent`
 * while keeping its pass/fail outcome consistent with the listed score (a listed 80 on an 80% quiz
 * must pass; a 70 must not).
 */
export function chooseAnswers(
  questions: readonly PlannedQuestion[],
  target: { percent: number; passingPercent: number },
  rng: Rng,
): AnswerOption[] {
  const maxPoints = round2(questions.reduce((sum, q) => sum + q.points, 0));
  const maxCents = Math.round(maxPoints * 100);
  const targetCents = Math.round((target.percent / 100) * maxCents);
  const shouldPass = target.percent >= target.passingPercent;

  // Visit questions in random order so different learners miss different questions.
  const order = shuffle(
    questions.map((_, i) => i),
    rng,
  );
  // Shuffled option lists by question index; `picks` index into them.
  const shuffled = new Map<number, AnswerOption[]>();
  let states = new Map<number, number[]>([[0, []]]);
  for (const index of order) {
    const options = shuffle(questions[index]!.options, rng);
    const next = new Map<number, number[]>();
    for (const [sum, picks] of states) {
      options.forEach((option, optionIndex) => {
        const total = sum + Math.round(option.awarded * 100);
        if (!next.has(total)) next.set(total, [...picks, optionIndex]);
      });
    }
    states = next;
    shuffled.set(index, options);
  }

  let best: { sum: number; picks: number[] } | null = null;
  for (const [sum, picks] of states) {
    const passes = (sum / maxCents) * 100 + 1e-9 >= target.passingPercent;
    if (passes !== shouldPass) continue;
    if (!best || Math.abs(sum - targetCents) < Math.abs(best.sum - targetCents))
      best = { sum, picks };
  }
  if (!best)
    throw new Error(
      `No answer combination reaches ${target.percent}% on a ${maxPoints}-point attempt`,
    );
  const picks = best.picks;
  const chosen = new Array<AnswerOption>(questions.length);
  order.forEach((questionIndex, step) => {
    chosen[questionIndex] = shuffled.get(questionIndex)![picks[step]!]!;
  });
  return chosen;
}
