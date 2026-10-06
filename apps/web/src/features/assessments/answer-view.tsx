import type { assessment } from '@a5/contracts';

type Answer = assessment.AnswerResponse;
type Correct = assessment.CorrectAnswer;

/** Id → text lookups for the choices of one question, whichever API shape they came from. */
export interface ChoiceLookup {
  /** Options of a choice or scenario question. */
  options: Record<string, string>;
  /** Items of an ordering question. */
  items: Record<string, string>;
  /** Left side of a matching question. */
  prompts: Record<string, string>;
  /** Right side of a matching question. */
  choices: Record<string, string>;
}

const empty = (): ChoiceLookup => ({ options: {}, items: {}, prompts: {}, choices: {} });
const index = (list: ReadonlyArray<{ id: string; text: string }>) =>
  Object.fromEntries(list.map((x) => [x.id, x.text]));

/** From a question as the learner received it (attempt or result screens). */
export function lookupFromLearner(q: assessment.LearnerQuestion): ChoiceLookup {
  const out = empty();
  switch (q.type) {
    case 'multiple_choice':
    case 'multiple_select':
      out.options = index(q.options);
      break;
    case 'scenario':
      if (q.subQuestion.kind === 'multiple_choice') out.options = index(q.subQuestion.options);
      break;
    case 'ordering':
      out.items = index(q.items);
      break;
    case 'matching':
      out.prompts = index(q.prompts);
      out.choices = index(q.choices);
      break;
    default:
      break;
  }
  return out;
}

/** From a stored question definition (reviewer screens). */
export function lookupFromDefinition(def: assessment.QuestionDefinition): ChoiceLookup {
  const out = empty();
  switch (def.type) {
    case 'multiple_choice':
    case 'multiple_select':
      out.options = index(def.config.options);
      break;
    case 'scenario':
      if (def.config.subQuestion.kind === 'multiple_choice')
        out.options = index(def.config.subQuestion.options);
      break;
    case 'ordering':
      out.items = index(def.config.items);
      break;
    case 'matching':
      out.prompts = Object.fromEntries(def.config.pairs.map((p) => [p.leftId, p.left]));
      out.choices = Object.fromEntries(def.config.pairs.map((p) => [p.rightId, p.right]));
      break;
    default:
      break;
  }
  return out;
}

const textOf = (map: Record<string, string>, id: string) => map[id] ?? 'An option that was removed';

function Text({ children }: { children: string }) {
  return <p className="break-words whitespace-pre-wrap">{children}</p>;
}

function List({ items, ordered }: { items: string[]; ordered?: boolean }) {
  const Tag = ordered ? 'ol' : 'ul';
  return (
    <Tag className={ordered ? 'list-decimal pl-5' : 'list-disc pl-5'}>
      {items.map((t, i) => (
        <li key={`${i}-${t}`} className="break-words">
          {t}
        </li>
      ))}
    </Tag>
  );
}

/** A learner's answer as readable text. */
export function ResponseView({
  response,
  lookup,
  empty: emptyText = 'No answer',
}: {
  response: Answer | null;
  lookup: ChoiceLookup;
  empty?: string;
}) {
  if (!response) return <p className="text-text-tertiary">{emptyText}</p>;
  switch (response.type) {
    case 'multiple_choice':
      return <Text>{textOf(lookup.options, response.optionId)}</Text>;
    case 'multiple_select':
      return response.optionIds.length ? (
        <List items={response.optionIds.map((id) => textOf(lookup.options, id))} />
      ) : (
        <p className="text-text-tertiary">{emptyText}</p>
      );
    case 'true_false':
      return <Text>{response.value ? 'True' : 'False'}</Text>;
    case 'short_answer':
    case 'long_answer':
      return response.text.trim() ? (
        <Text>{response.text}</Text>
      ) : (
        <p className="text-text-tertiary">{emptyText}</p>
      );
    case 'scenario':
      if (response.optionId !== undefined)
        return <Text>{textOf(lookup.options, response.optionId)}</Text>;
      return response.text?.trim() ? (
        <Text>{response.text}</Text>
      ) : (
        <p className="text-text-tertiary">{emptyText}</p>
      );
    case 'ordering':
      return <List ordered items={response.order.map((id) => textOf(lookup.items, id))} />;
    case 'matching': {
      const entries = Object.entries(response.matches);
      if (entries.length === 0) return <p className="text-text-tertiary">{emptyText}</p>;
      return (
        <ul className="grid gap-1">
          {entries.map(([promptId, choiceId]) => (
            <li key={promptId} className="break-words">
              {textOf(lookup.prompts, promptId)} <span aria-hidden>&rarr;</span>
              <span className="sr-only">matched with</span> {textOf(lookup.choices, choiceId)}
            </li>
          ))}
        </ul>
      );
    }
  }
}

/** The answer key for a question, shown only when the API reveals it. */
export function CorrectAnswerView({ correct, lookup }: { correct: Correct; lookup: ChoiceLookup }) {
  switch (correct.type) {
    case 'multiple_choice':
      return <Text>{textOf(lookup.options, correct.optionId)}</Text>;
    case 'multiple_select':
      return <List items={correct.optionIds.map((id) => textOf(lookup.options, id))} />;
    case 'true_false':
      return <Text>{correct.value ? 'True' : 'False'}</Text>;
    case 'short_answer':
      return correct.acceptedAnswers.length ? (
        <List items={correct.acceptedAnswers} />
      ) : (
        <p className="text-text-tertiary">Reviewed by a trainer</p>
      );
    case 'long_answer':
      return correct.sampleAnswer ? (
        <Text>{correct.sampleAnswer}</Text>
      ) : (
        <p className="text-text-tertiary">Reviewed by a trainer</p>
      );
    case 'scenario':
      if (correct.optionId) return <Text>{textOf(lookup.options, correct.optionId)}</Text>;
      return correct.sampleAnswer ? (
        <Text>{correct.sampleAnswer}</Text>
      ) : (
        <p className="text-text-tertiary">Reviewed by a trainer</p>
      );
    case 'ordering':
      return <List ordered items={correct.order.map((id) => textOf(lookup.items, id))} />;
    case 'matching':
      return (
        <ul className="grid gap-1">
          {Object.entries(correct.matches).map(([promptId, choiceId]) => (
            <li key={promptId} className="break-words">
              {textOf(lookup.prompts, promptId)} <span aria-hidden>&rarr;</span>
              <span className="sr-only">matched with</span> {textOf(lookup.choices, choiceId)}
            </li>
          ))}
        </ul>
      );
  }
}

/** The answer key of a stored question definition (mirrors the service; used by reviewer screens). */
export function correctAnswerOf(def: assessment.QuestionDefinition): Correct {
  switch (def.type) {
    case 'multiple_choice':
      return {
        type: 'multiple_choice',
        optionId: def.config.options.find((o) => o.correct)?.id ?? '',
      };
    case 'multiple_select':
      return {
        type: 'multiple_select',
        optionIds: def.config.options.filter((o) => o.correct).map((o) => o.id),
      };
    case 'true_false':
      return { type: 'true_false', value: def.config.correctAnswer };
    case 'short_answer':
      return { type: 'short_answer', acceptedAnswers: def.config.acceptedAnswers };
    case 'long_answer':
      return { type: 'long_answer', sampleAnswer: def.config.sampleAnswer ?? null };
    case 'scenario': {
      const sub = def.config.subQuestion;
      return sub.kind === 'multiple_choice'
        ? {
            type: 'scenario',
            optionId: sub.options.find((o) => o.correct)?.id ?? null,
            sampleAnswer: null,
          }
        : { type: 'scenario', optionId: null, sampleAnswer: sub.sampleAnswer ?? null };
    }
    case 'ordering':
      return { type: 'ordering', order: def.config.items.map((i) => i.id) };
    case 'matching':
      return {
        type: 'matching',
        matches: Object.fromEntries(def.config.pairs.map((p) => [p.leftId, p.rightId])),
      };
  }
}

/** Heading for the answer key: written answers have a sample, not a single correct answer. */
export function correctAnswerLabel(correct: Correct): string {
  if (correct.type === 'long_answer') return 'Sample answer';
  if (correct.type === 'scenario' && correct.optionId === null) return 'Sample answer';
  return 'Correct answer';
}
