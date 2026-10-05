import type { assessment } from '@a5/contracts';

export type Item = assessment.AssessmentItem;
export type RequestItems = assessment.ReplaceAssessmentItemsRequest['items'];

/** The item list in the shape the replace endpoint expects, renumbered 1..n. */
export function toRequestItems(items: readonly Item[]): RequestItems {
  return items.map((it, i) =>
    it.kind === 'question'
      ? {
          kind: 'question' as const,
          id: it.id,
          questionId: it.question.id,
          points: it.points,
          position: i + 1,
        }
      : {
          kind: 'pool' as const,
          id: it.id,
          bankId: it.bank.id,
          categoryId: it.category?.id ?? null,
          difficulty: it.difficulty,
          tags: it.tags,
          count: it.count,
          points: it.points,
          position: i + 1,
        },
  );
}

/** Move one item up or down and return the full request. */
export function moveRequestItem(
  items: readonly Item[],
  index: number,
  delta: -1 | 1,
): RequestItems {
  const to = index + delta;
  if (index < 0 || to < 0 || to >= items.length) return toRequestItems(items);
  const next = [...items];
  const [moved] = next.splice(index, 1);
  next.splice(to, 0, moved as Item);
  return toRequestItems(next);
}

/** Append fixed questions (ignoring any already present). */
export function appendQuestions(
  items: readonly Item[],
  questionIds: readonly string[],
): RequestItems {
  const have = new Set(items.flatMap((i) => (i.kind === 'question' ? [i.question.id] : [])));
  const base = toRequestItems(items);
  const added = questionIds
    .filter((id) => !have.has(id))
    .map((questionId, i) => ({
      kind: 'question' as const,
      questionId,
      points: null,
      position: base.length + i + 1,
    }));
  return [...base, ...added];
}

export function fixedQuestionIds(items: readonly Item[]): Set<string> {
  return new Set(items.flatMap((i) => (i.kind === 'question' ? [i.question.id] : [])));
}

/** Plain-language description of a pool rule's filters. */
export function describePoolFilters(item: Extract<Item, { kind: 'pool' }>): string {
  const parts = [
    item.category ? `Category: ${item.category.name}` : 'Any category',
    item.difficulty ? `Difficulty: ${item.difficulty}` : 'Any difficulty',
  ];
  if (item.tags.length) parts.push(`Tagged ${item.tags.join(', ')}`);
  return parts.join(' · ');
}
