import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { ArrowDown, ArrowUp, Check } from 'lucide-react';
import { Button, IconButton, Input, Select, Textarea } from '@/components/ui';
import { Markdown } from '@/components/markdown';
import { cn } from '@/lib/cn';
import {
  moveItem,
  normalizeResponse,
  orderingItems,
  usedChoices,
  wordCount,
  type Answer,
  type Question,
} from './quiz-state';

export interface ChangeOptions {
  /** Send to the server now instead of after a typing pause. */
  immediate?: boolean;
}

export interface QuestionInputProps {
  question: Question;
  value: Answer | null;
  onChange: (value: Answer | null, options?: ChangeOptions) => void;
  disabled?: boolean;
  /** A reason the latest answer was not stored, shown next to the field. */
  problem?: string | null;
}

/** One-line instruction under the prompt, per question type. */
export function questionHint(q: Question): string {
  switch (q.type) {
    case 'multiple_choice':
      return 'Choose one answer.';
    case 'multiple_select':
      return 'Select every answer that applies.';
    case 'true_false':
      return 'Choose true or false.';
    case 'short_answer':
      return 'Type a short answer.';
    case 'long_answer':
      return 'Write your answer in full sentences.';
    case 'scenario':
      return q.subQuestion.kind === 'multiple_choice'
        ? 'Read the scenario, then choose one answer.'
        : 'Read the scenario, then write your response.';
    case 'ordering':
      return 'Put the items in the correct order.';
    case 'matching':
      return 'Match each item on the left with its partner.';
  }
}

// ------------------------------------------------------------------ choice cards

interface ChoiceOption {
  id: string;
  text: string;
}

function ChoiceGroup({
  options,
  selected,
  mode,
  onChange,
  labelledBy,
  describedBy,
  disabled,
}: {
  options: readonly ChoiceOption[];
  selected: readonly string[];
  mode: 'single' | 'multiple';
  onChange: (ids: string[]) => void;
  labelledBy: string;
  describedBy?: string;
  disabled?: boolean;
}) {
  const name = useId();
  return (
    <div
      role={mode === 'single' ? 'radiogroup' : 'group'}
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      className="grid gap-2"
    >
      {options.map((o) => {
        const checked = selected.includes(o.id);
        return (
          <label
            key={o.id}
            className={cn(
              'flex cursor-pointer items-start gap-3 rounded-lg border px-4 py-3 text-base transition-colors has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-focus',
              checked
                ? 'border-brand-primary bg-surface-selected'
                : 'border-border-strong bg-surface hover:bg-surface-hover',
              disabled && 'cursor-not-allowed opacity-60',
            )}
          >
            <input
              type={mode === 'single' ? 'radio' : 'checkbox'}
              name={name}
              value={o.id}
              checked={checked}
              disabled={disabled}
              className="sr-only"
              onChange={() => {
                if (mode === 'single') onChange([o.id]);
                else onChange(checked ? selected.filter((id) => id !== o.id) : [...selected, o.id]);
              }}
            />
            <span
              aria-hidden
              className={cn(
                'mt-0.5 flex size-[18px] shrink-0 items-center justify-center border-2 bg-surface',
                mode === 'single' ? 'rounded-full' : 'rounded-sm',
                checked ? 'border-brand-primary' : 'border-text-tertiary',
                mode === 'multiple' && checked && 'bg-brand-primary',
              )}
            >
              {mode === 'single' && checked && (
                <span className="size-2 rounded-full bg-brand-primary" />
              )}
              {mode === 'multiple' && checked && (
                <Check className="size-3 text-text-inverse" strokeWidth={3.5} />
              )}
            </span>
            <span className="min-w-0 flex-1 break-words">{o.text}</span>
          </label>
        );
      })}
    </div>
  );
}

const TRUE_FALSE: ChoiceOption[] = [
  { id: 'true', text: 'True' },
  { id: 'false', text: 'False' },
];

// ------------------------------------------------------------------ text

function Counter({ id, children, over }: { id: string; children: ReactNode; over?: boolean }) {
  return (
    <p
      id={id}
      className={cn(
        'tabular mt-1.5 text-xs',
        over ? 'font-medium text-danger' : 'text-text-tertiary',
      )}
    >
      {children}
    </p>
  );
}

function ShortText({
  question,
  value,
  onChange,
  disabled,
  labelledBy,
}: QuestionInputProps & {
  question: Extract<Question, { type: 'short_answer' }>;
  labelledBy: string;
}) {
  const counterId = useId();
  const text = value?.type === 'short_answer' ? value.text : '';
  return (
    <div>
      <Input
        value={text}
        maxLength={question.maxLength}
        disabled={disabled}
        autoComplete="off"
        aria-labelledby={labelledBy}
        aria-describedby={counterId}
        onChange={(e) =>
          onChange(normalizeResponse({ type: 'short_answer', text: e.target.value }))
        }
      />
      <Counter id={counterId}>
        {text.length} of {question.maxLength} characters
      </Counter>
    </div>
  );
}

function LongText({
  question,
  value,
  onChange,
  disabled,
  labelledBy,
}: QuestionInputProps & {
  question: Extract<Question, { type: 'long_answer' }>;
  labelledBy: string;
}) {
  const counterId = useId();
  const text = value?.type === 'long_answer' ? value.text : '';
  const words = wordCount(text);
  const over = question.maxWords !== null && words > question.maxWords;
  const under = question.minWords !== null && words > 0 && words < question.minWords;
  return (
    <div>
      <Textarea
        rows={10}
        value={text}
        maxLength={30_000}
        disabled={disabled}
        aria-labelledby={labelledBy}
        aria-describedby={counterId}
        aria-invalid={over || undefined}
        onChange={(e) => onChange(normalizeResponse({ type: 'long_answer', text: e.target.value }))}
      />
      <Counter id={counterId} over={over}>
        {words} {words === 1 ? 'word' : 'words'}
        {question.minWords ? ` · suggested at least ${question.minWords}` : ''}
        {question.maxWords !== null ? ` · limit ${question.maxWords}` : ''}
        {under ? ' · a little more detail would help' : ''}
      </Counter>
    </div>
  );
}

// ------------------------------------------------------------------ ordering

function OrderingInput({
  question,
  value,
  onChange,
  disabled,
  labelledBy,
}: QuestionInputProps & { question: Extract<Question, { type: 'ordering' }>; labelledBy: string }) {
  const hintId = useId();
  const items = orderingItems(question, value);
  const answered = value?.type === 'ordering' && value.order.length === question.items.length;
  const [announcement, setAnnouncement] = useState('');
  const refocus = useRef<{ id: string; dir: 'up' | 'down' } | null>(null);
  const buttons = useRef(new Map<string, HTMLButtonElement>());

  useEffect(() => {
    const target = refocus.current;
    if (!target) return;
    refocus.current = null;
    buttons.current.get(`${target.id}:${target.dir}`)?.focus();
  });

  const commit = (order: string[]) => onChange({ type: 'ordering', order }, { immediate: true });

  const move = (index: number, delta: -1 | 1) => {
    const next = moveItem(items, index, delta);
    const item = items[index];
    if (!item) return;
    const newIndex = index + delta;
    refocus.current = {
      id: item.id,
      dir:
        delta === -1
          ? newIndex === 0
            ? 'down'
            : 'up'
          : newIndex === items.length - 1
            ? 'up'
            : 'down',
    };
    setAnnouncement(`${item.text} moved to position ${newIndex + 1} of ${items.length}.`);
    commit(next.map((i) => i.id));
  };

  return (
    <div>
      <p id={hintId} className="mb-2 text-sm text-text-secondary">
        Use the arrow buttons to move an item up or down. The first item should come first.
      </p>
      <ol aria-labelledby={labelledBy} aria-describedby={hintId} className="grid gap-2">
        {items.map((item, i) => (
          <li
            key={item.id}
            className="flex items-center gap-3 rounded-lg border border-border-strong bg-surface py-2 pr-2 pl-3"
          >
            <span
              aria-hidden
              className="tabular flex size-6 shrink-0 items-center justify-center rounded-full bg-surface-sunken text-sm font-medium text-text-secondary"
            >
              {i + 1}
            </span>
            <span className="min-w-0 flex-1 break-words text-base">
              <span className="sr-only">
                Position {i + 1} of {items.length}:{' '}
              </span>
              {item.text}
            </span>
            <IconButton
              ref={(el) => {
                if (el) buttons.current.set(`${item.id}:up`, el);
                else buttons.current.delete(`${item.id}:up`);
              }}
              label={`Move ${item.text} up`}
              variant="secondary"
              disabled={disabled || i === 0}
              onClick={() => move(i, -1)}
            >
              <ArrowUp className="size-4" />
            </IconButton>
            <IconButton
              ref={(el) => {
                if (el) buttons.current.set(`${item.id}:down`, el);
                else buttons.current.delete(`${item.id}:down`);
              }}
              label={`Move ${item.text} down`}
              variant="secondary"
              disabled={disabled || i === items.length - 1}
              onClick={() => move(i, 1)}
            >
              <ArrowDown className="size-4" />
            </IconButton>
          </li>
        ))}
      </ol>
      {!answered && !disabled && (
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <Button onClick={() => commit(items.map((i) => i.id))}>Keep this order</Button>
          <span className="text-sm text-text-secondary">
            Not answered yet. Move an item or keep the order shown.
          </span>
        </div>
      )}
      <p role="status" className="sr-only">
        {announcement}
      </p>
    </div>
  );
}

// ------------------------------------------------------------------ matching

function MatchingInput({
  question,
  value,
  onChange,
  disabled,
}: QuestionInputProps & { question: Extract<Question, { type: 'matching' }> }) {
  const matches = value?.type === 'matching' ? value.matches : {};
  const set = (promptId: string, choiceId: string) => {
    const next = { ...matches };
    if (choiceId) next[promptId] = choiceId;
    else delete next[promptId];
    onChange(normalizeResponse({ type: 'matching', matches: next }), { immediate: true });
  };
  return (
    <ul className="grid gap-2">
      {question.prompts.map((p) => {
        const used = usedChoices(matches, p.id);
        const selectId = `${question.id}-${p.id}`;
        return (
          <li
            key={p.id}
            className="grid gap-2 rounded-lg border border-border-strong bg-surface px-4 py-3 sm:grid-cols-2 sm:items-center sm:gap-4"
          >
            <label htmlFor={selectId} className="min-w-0 break-words text-base font-medium">
              {p.text}
            </label>
            <Select
              id={selectId}
              value={matches[p.id] ?? ''}
              disabled={disabled}
              onChange={(e) => set(p.id, e.target.value)}
            >
              <option value="">Choose a match</option>
              {question.choices.map((c) => (
                <option key={c.id} value={c.id} disabled={used.has(c.id)}>
                  {c.text}
                  {used.has(c.id) ? ' (used)' : ''}
                </option>
              ))}
            </Select>
          </li>
        );
      })}
    </ul>
  );
}

// ------------------------------------------------------------------ scenario

function ScenarioInput({
  question,
  value,
  onChange,
  disabled,
}: QuestionInputProps & { question: Extract<Question, { type: 'scenario' }> }) {
  const promptId = useId();
  const counterId = useId();
  const sub = question.subQuestion;
  return (
    <div className="grid gap-5">
      <div className="rounded-lg border border-border bg-surface-sunken/60 px-4 py-3">
        <p className="mb-1 text-xs font-medium text-text-tertiary">Scenario</p>
        <Markdown className="text-base [&_p]:mb-2">{question.scenario}</Markdown>
      </div>
      <div>
        <div id={promptId} className="mb-3 font-medium">
          <Markdown>{sub.prompt}</Markdown>
        </div>
        {sub.kind === 'multiple_choice' ? (
          <ChoiceGroup
            options={sub.options}
            selected={value?.type === 'scenario' && value.optionId ? [value.optionId] : []}
            mode="single"
            labelledBy={promptId}
            disabled={disabled}
            onChange={([id]) =>
              onChange(id ? { type: 'scenario', optionId: id } : null, { immediate: true })
            }
          />
        ) : (
          <div>
            <Textarea
              rows={8}
              value={value?.type === 'scenario' ? (value.text ?? '') : ''}
              maxLength={sub.maxLength}
              disabled={disabled}
              aria-labelledby={promptId}
              aria-describedby={counterId}
              onChange={(e) =>
                onChange(normalizeResponse({ type: 'scenario', text: e.target.value }))
              }
            />
            <Counter id={counterId}>
              {value?.type === 'scenario' ? (value.text ?? '').length : 0} of {sub.maxLength}{' '}
              characters
            </Counter>
          </div>
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ dispatcher

/** The answer control for one question. Used by the quiz player and by the editor preview. */
export function QuestionInput(props: QuestionInputProps & { promptId: string }) {
  const { question, value, onChange, disabled, promptId } = props;
  const problemId = useId();
  let control: ReactNode;
  switch (question.type) {
    case 'multiple_choice':
      control = (
        <ChoiceGroup
          options={question.options}
          selected={value?.type === 'multiple_choice' ? [value.optionId] : []}
          mode="single"
          labelledBy={promptId}
          describedBy={props.problem ? problemId : undefined}
          disabled={disabled}
          onChange={([id]) =>
            onChange(id ? { type: 'multiple_choice', optionId: id } : null, { immediate: true })
          }
        />
      );
      break;
    case 'multiple_select':
      control = (
        <ChoiceGroup
          options={question.options}
          selected={value?.type === 'multiple_select' ? value.optionIds : []}
          mode="multiple"
          labelledBy={promptId}
          disabled={disabled}
          onChange={(ids) =>
            onChange(normalizeResponse({ type: 'multiple_select', optionIds: ids }), {
              immediate: true,
            })
          }
        />
      );
      break;
    case 'true_false':
      control = (
        <ChoiceGroup
          options={TRUE_FALSE}
          selected={value?.type === 'true_false' ? [String(value.value)] : []}
          mode="single"
          labelledBy={promptId}
          disabled={disabled}
          onChange={([id]) =>
            onChange(id ? { type: 'true_false', value: id === 'true' } : null, { immediate: true })
          }
        />
      );
      break;
    case 'short_answer':
      control = <ShortText {...props} question={question} labelledBy={promptId} />;
      break;
    case 'long_answer':
      control = <LongText {...props} question={question} labelledBy={promptId} />;
      break;
    case 'scenario':
      control = <ScenarioInput {...props} question={question} />;
      break;
    case 'ordering':
      control = <OrderingInput {...props} question={question} labelledBy={promptId} />;
      break;
    case 'matching':
      control = <MatchingInput {...props} question={question} />;
      break;
  }
  return (
    <div>
      {control}
      {props.problem && (
        <p id={problemId} role="alert" className="mt-2 text-sm font-medium text-danger">
          {props.problem}
        </p>
      )}
    </div>
  );
}
