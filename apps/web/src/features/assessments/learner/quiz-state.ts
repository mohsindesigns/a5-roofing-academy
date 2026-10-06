import type { assessment } from '@a5/contracts';

export type Answer = assessment.AnswerResponse;
export type Question = assessment.LearnerQuestion;
/** Local answers by attempt-question id. `null` means unanswered. */
export type Answers = Record<string, Answer | null>;

export function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/** Mirrors the service: an empty selection or blank text is not an answer. */
export function isAnswered(response: Answer | null | undefined): boolean {
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

/** Collapse "nothing entered" shapes to null so clearing an input clears the saved answer. */
export function normalizeResponse(response: Answer | null): Answer | null {
  return isAnswered(response) ? response : null;
}

export function initialAnswers(questions: readonly Question[]): Answers {
  const out: Answers = {};
  for (const q of questions) out[q.id] = q.response;
  return out;
}

export function countAnswered(questions: readonly Question[], answers: Answers): number {
  return questions.filter((q) => isAnswered(answers[q.id])).length;
}

/** Zero-based indexes of unanswered questions, in order. */
export function unansweredIndexes(questions: readonly Question[], answers: Answers): number[] {
  const out: number[] = [];
  questions.forEach((q, i) => {
    if (!isAnswered(answers[q.id])) out.push(i);
  });
  return out;
}

/** The next unanswered question after `from` (wrapping around), or null when all are answered. */
export function nextUnanswered(
  questions: readonly Question[],
  answers: Answers,
  from: number,
): number | null {
  const pending = unansweredIndexes(questions, answers);
  if (pending.length === 0) return null;
  return pending.find((i) => i > from) ?? pending[0] ?? null;
}

/**
 * The same limits the service enforces on save. Checking them here keeps autosave from sending a
 * request that is certain to be refused; the learner sees the reason next to the field instead.
 */
export function responseProblem(question: Question, response: Answer | null): string | null {
  if (!response) return null;
  switch (question.type) {
    case 'short_answer':
      return response.type === 'short_answer' && response.text.length > question.maxLength
        ? `Keep your answer to ${question.maxLength} characters or fewer.`
        : null;
    case 'long_answer':
      return response.type === 'long_answer' &&
        question.maxWords !== null &&
        wordCount(response.text) > question.maxWords
        ? `Keep your answer to ${question.maxWords} words or fewer.`
        : null;
    case 'scenario':
      return response.type === 'scenario' &&
        question.subQuestion.kind === 'open_response' &&
        (response.text ?? '').length > question.subQuestion.maxLength
        ? `Keep your response to ${question.subQuestion.maxLength} characters or fewer.`
        : null;
    default:
      return null;
  }
}

/** Reorder helper for the ordering question: moves one item by `delta` positions. */
export function moveItem<T>(list: readonly T[], from: number, delta: number): T[] {
  const to = from + delta;
  if (from < 0 || from >= list.length || to < 0 || to >= list.length) return [...list];
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item as T);
  return next;
}

/** Current order of an ordering question: the saved answer, otherwise the order it was drawn in. */
export function orderingItems(
  question: Extract<Question, { type: 'ordering' }>,
  response: Answer | null,
) {
  if (response?.type !== 'ordering' || response.order.length !== question.items.length)
    return question.items;
  const byId = new Map(question.items.map((i) => [i.id, i]));
  const ordered = response.order.map((id) => byId.get(id));
  return ordered.every(Boolean) ? (ordered as typeof question.items) : question.items;
}

/** Ids already used by other prompts of a matching question (each choice can be used once). */
export function usedChoices(matches: Record<string, string>, exceptPromptId: string): Set<string> {
  return new Set(
    Object.entries(matches)
      .filter(([promptId]) => promptId !== exceptPromptId)
      .map(([, choiceId]) => choiceId),
  );
}
