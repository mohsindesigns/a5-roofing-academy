import { get, type UseFormReturn } from 'react-hook-form';
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import { assessment } from '@a5/contracts';
import {
  Button,
  Checkbox,
  Field,
  IconButton,
  Input,
  Select,
  Switch,
  Textarea,
} from '@/components/ui';
import { moveItem } from '../learner/quiz-state';
import { newChoiceId, type QuestionFormValues } from './question-form-model';

export interface EditorProps {
  form: UseFormReturn<QuestionFormValues>;
  disabled: boolean;
}

/** Message for a form path, from the validation resolver. */
export function errorAt(form: UseFormReturn<QuestionFormValues>, path: string): string | undefined {
  const entry = get(form.formState.errors, path) as { message?: string } | undefined;
  return entry?.message;
}

/** Write a list or value. After a first failed save, re-check so messages clear as the author fixes things. */
function useSetter(form: UseFormReturn<QuestionFormValues>) {
  return <K extends keyof QuestionFormValues>(name: K, value: QuestionFormValues[K]) =>
    form.setValue(name, value as never, {
      shouldDirty: true,
      shouldValidate: form.formState.isSubmitted,
    });
}

function ListError({ message }: { message: string | undefined }) {
  return message ? (
    <p role="alert" className="mt-2 text-sm font-medium text-danger">
      {message}
    </p>
  ) : null;
}

const SCORING_LABELS: Record<assessment.ScoringMode, string> = {
  all_or_nothing: 'All or nothing: full points only when everything is right',
  partial: 'Partial credit: points in proportion to how much is right',
};

function ScoringField({ form, disabled, hint }: EditorProps & { hint?: string }) {
  return (
    <Field label="Scoring" hint={hint} error={errorAt(form, 'scoring')}>
      <Select disabled={disabled} {...form.register('scoring')}>
        {assessment.SCORING_MODES.map((m) => (
          <option key={m} value={m}>
            {SCORING_LABELS[m]}
          </option>
        ))}
      </Select>
    </Field>
  );
}

// ------------------------------------------------------------------ options (choice, select, scenario)

export function OptionsEditor({
  form,
  disabled,
  mode,
  max,
}: EditorProps & { mode: 'single' | 'multiple'; max: number }) {
  const set = useSetter(form);
  const options = form.watch('options');
  const update = (i: number, patch: Partial<(typeof options)[number]>) =>
    set(
      'options',
      options.map((o, idx) => (idx === i ? { ...o, ...patch } : o)),
    );
  const choose = (i: number) =>
    set(
      'options',
      options.map((o, idx) => ({ ...o, correct: idx === i })),
    );
  return (
    <fieldset>
      <legend className="mb-1 text-sm font-medium">
        Answer options{' '}
        <span className="font-normal text-text-tertiary">
          {mode === 'single' ? '(mark the one correct answer)' : '(mark every correct answer)'}
        </span>
      </legend>
      <ul className="grid gap-2">
        {options.map((o, i) => (
          <li key={o.id} className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-2">
            <span className="flex h-[var(--a5-control-height)] items-center">
              {mode === 'single' ? (
                <input
                  type="radio"
                  name="correct-option"
                  className="size-4 accent-brand-primary"
                  aria-label={`Option ${i + 1} is the correct answer`}
                  checked={o.correct}
                  disabled={disabled}
                  onChange={() => choose(i)}
                />
              ) : (
                <Checkbox
                  aria-label={`Option ${i + 1} is correct`}
                  checked={o.correct}
                  disabled={disabled}
                  onCheckedChange={(c) => update(i, { correct: c === true })}
                />
              )}
            </span>
            <Field
              label={`Option ${i + 1} text`}
              hideLabel
              error={errorAt(form, `options.${i}.text`)}
            >
              <Input
                value={o.text}
                maxLength={500}
                disabled={disabled}
                placeholder={`Option ${i + 1}`}
                onChange={(e) => update(i, { text: e.target.value })}
              />
            </Field>
            <IconButton
              label={`Remove option ${i + 1}`}
              disabled={disabled || options.length <= 2}
              onClick={() =>
                set(
                  'options',
                  options.filter((_, idx) => idx !== i),
                )
              }
            >
              <Trash2 className="size-4" />
            </IconButton>
          </li>
        ))}
      </ul>
      <ListError message={errorAt(form, 'optionsError')} />
      <Button
        className="mt-2"
        size="sm"
        leading={<Plus className="size-4" />}
        disabled={disabled || options.length >= max}
        onClick={() =>
          set('options', [...options, { id: newChoiceId('o'), text: '', correct: false }])
        }
      >
        Add option
      </Button>
    </fieldset>
  );
}

// ------------------------------------------------------------------ per type

function TrueFalseEditor({ form, disabled }: EditorProps) {
  const value = form.watch('trueFalseAnswer');
  return (
    <fieldset>
      <legend className="mb-1 text-sm font-medium">Correct answer</legend>
      <div className="flex gap-4">
        {(['true', 'false'] as const).map((v) => (
          <label key={v} className="flex items-center gap-2">
            <input
              type="radio"
              name="true-false-answer"
              className="size-4 accent-brand-primary"
              checked={value === v}
              disabled={disabled}
              onChange={() => form.setValue('trueFalseAnswer', v, { shouldDirty: true })}
            />
            {v === 'true' ? 'True' : 'False'}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function ShortAnswerEditor({ form, disabled }: EditorProps) {
  const set = useSetter(form);
  const grading = form.watch('grading');
  const accepted = form.watch('accepted');
  return (
    <div className="grid gap-4">
      <Field
        label="Grading"
        hint="Short answers can be marked automatically against a list of accepted answers, or read by a trainer."
        error={errorAt(form, 'grading')}
      >
        <Select disabled={disabled} {...form.register('grading')}>
          <option value="auto">Automatic: compare with accepted answers</option>
          <option value="manual">A trainer reviews each answer</option>
        </Select>
      </Field>
      {grading === 'auto' ? (
        <fieldset>
          <legend className="mb-1 text-sm font-medium">Accepted answers</legend>
          <ul className="grid gap-2">
            {accepted.map((a, i) => (
              <li key={i} className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-2">
                <Field
                  label={`Accepted answer ${i + 1}`}
                  hideLabel
                  error={errorAt(form, `accepted.${i}.value`)}
                >
                  <Input
                    value={a.value}
                    maxLength={200}
                    disabled={disabled}
                    placeholder="An answer that counts as correct"
                    onChange={(e) =>
                      set(
                        'accepted',
                        accepted.map((x, idx) => (idx === i ? { value: e.target.value } : x)),
                      )
                    }
                  />
                </Field>
                <IconButton
                  label={`Remove accepted answer ${i + 1}`}
                  disabled={disabled || accepted.length <= 1}
                  onClick={() =>
                    set(
                      'accepted',
                      accepted.filter((_, idx) => idx !== i),
                    )
                  }
                >
                  <Trash2 className="size-4" />
                </IconButton>
              </li>
            ))}
          </ul>
          <ListError message={errorAt(form, 'acceptedError')} />
          <Button
            className="mt-2"
            size="sm"
            leading={<Plus className="size-4" />}
            disabled={disabled || accepted.length >= 20}
            onClick={() => set('accepted', [...accepted, { value: '' }])}
          >
            Add accepted answer
          </Button>
          <div className="mt-4 grid gap-3">
            <label className="flex items-start gap-3">
              <Switch
                className="mt-0.5"
                checked={form.watch('caseSensitive')}
                disabled={disabled}
                onCheckedChange={(c) => form.setValue('caseSensitive', c, { shouldDirty: true })}
              />
              <span>
                <span className="block font-medium">Match capital letters exactly</span>
                <span className="block text-sm text-text-secondary">
                  Off by default, so &quot;alpine&quot; and &quot;Alpine&quot; both count.
                </span>
              </span>
            </label>
            <label className="flex items-start gap-3">
              <Switch
                className="mt-0.5"
                checked={form.watch('normalizeWhitespace')}
                disabled={disabled}
                onCheckedChange={(c) =>
                  form.setValue('normalizeWhitespace', c, { shouldDirty: true })
                }
              />
              <span>
                <span className="block font-medium">Ignore extra spaces</span>
                <span className="block text-sm text-text-secondary">
                  Leading, trailing and repeated spaces are ignored when comparing.
                </span>
              </span>
            </label>
          </div>
        </fieldset>
      ) : (
        <Field
          label="Guidance for reviewers"
          optional
          hint="What a good answer contains. Only trainers see this."
          error={errorAt(form, 'reviewGuidance')}
        >
          <Textarea
            rows={3}
            maxLength={5000}
            disabled={disabled}
            {...form.register('reviewGuidance')}
          />
        </Field>
      )}
      <Field
        label="Longest answer (characters)"
        hint="Learners cannot type more than this."
        error={errorAt(form, 'maxLength')}
      >
        <Input
          type="number"
          inputMode="numeric"
          min={1}
          max={500}
          className="max-w-[160px]"
          disabled={disabled}
          {...form.register('maxLength')}
        />
      </Field>
    </div>
  );
}

function LongAnswerEditor({ form, disabled }: EditorProps) {
  return (
    <div className="grid gap-4">
      <p className="rounded-lg bg-information-soft px-4 py-2.5 text-sm text-information">
        Long answers are always read and scored by a trainer.
      </p>
      <Field
        label="Scoring rubric"
        required
        hint="What a strong answer includes. Only trainers see this."
        error={errorAt(form, 'rubric')}
      >
        <Textarea rows={5} maxLength={5000} disabled={disabled} {...form.register('rubric')} />
      </Field>
      <Field
        label="Sample answer"
        optional
        hint="Shown to trainers, and to learners when correct answers are revealed."
        error={errorAt(form, 'sampleAnswer')}
      >
        <Textarea
          rows={4}
          maxLength={5000}
          disabled={disabled}
          {...form.register('sampleAnswer')}
        />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Suggested minimum words" optional error={errorAt(form, 'minWords')}>
          <Input
            type="number"
            inputMode="numeric"
            min={0}
            disabled={disabled}
            {...form.register('minWords')}
          />
        </Field>
        <Field
          label="Maximum words"
          optional
          hint="Learners cannot save an answer longer than this."
          error={errorAt(form, 'maxWords')}
        >
          <Input
            type="number"
            inputMode="numeric"
            min={1}
            disabled={disabled}
            {...form.register('maxWords')}
          />
        </Field>
      </div>
    </div>
  );
}

function ScenarioEditor({ form, disabled }: EditorProps) {
  const kind = form.watch('subKind');
  return (
    <div className="grid gap-4">
      <Field
        label="Scenario"
        required
        hint="The situation the learner reads. Supports basic Markdown."
        error={errorAt(form, 'scenario')}
      >
        <Textarea rows={5} maxLength={5000} disabled={disabled} {...form.register('scenario')} />
      </Field>
      <Field label="What the learner does" error={errorAt(form, 'subKind')}>
        <Select disabled={disabled} {...form.register('subKind')}>
          <option value="multiple_choice">Choose the best response (marked automatically)</option>
          <option value="open_response">Write a response (a trainer reviews it)</option>
        </Select>
      </Field>
      <Field label="Follow-up question" required error={errorAt(form, 'subPrompt')}>
        <Textarea rows={2} maxLength={2000} disabled={disabled} {...form.register('subPrompt')} />
      </Field>
      {kind === 'multiple_choice' ? (
        <OptionsEditor form={form} disabled={disabled} mode="single" max={10} />
      ) : (
        <>
          <Field
            label="Scoring rubric"
            required
            hint="What a strong response includes. Only trainers see this."
            error={errorAt(form, 'rubric')}
          >
            <Textarea rows={4} maxLength={5000} disabled={disabled} {...form.register('rubric')} />
          </Field>
          <Field label="Sample response" optional error={errorAt(form, 'sampleAnswer')}>
            <Textarea
              rows={3}
              maxLength={5000}
              disabled={disabled}
              {...form.register('sampleAnswer')}
            />
          </Field>
          <Field label="Longest response (characters)" error={errorAt(form, 'maxLength')}>
            <Input
              type="number"
              inputMode="numeric"
              min={50}
              max={5000}
              className="max-w-[160px]"
              disabled={disabled}
              {...form.register('maxLength')}
            />
          </Field>
        </>
      )}
    </div>
  );
}

function OrderingEditor({ form, disabled }: EditorProps) {
  const set = useSetter(form);
  const items = form.watch('items');
  return (
    <div className="grid gap-4">
      <fieldset>
        <legend className="mb-1 text-sm font-medium">
          Items in the correct order{' '}
          <span className="font-normal text-text-tertiary">
            (learners always see them shuffled)
          </span>
        </legend>
        <ol className="grid gap-2">
          {items.map((item, i) => (
            <li
              key={item.id}
              className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-2"
            >
              <span
                aria-hidden
                className="tabular flex h-[var(--a5-control-height)] w-6 items-center justify-center text-sm font-medium text-text-secondary"
              >
                {i + 1}
              </span>
              <Field
                label={`Item ${i + 1} text`}
                hideLabel
                error={errorAt(form, `items.${i}.text`)}
              >
                <Input
                  value={item.text}
                  maxLength={300}
                  disabled={disabled}
                  placeholder={`Step ${i + 1}`}
                  onChange={(e) =>
                    set(
                      'items',
                      items.map((x, idx) => (idx === i ? { ...x, text: e.target.value } : x)),
                    )
                  }
                />
              </Field>
              <div className="flex">
                <IconButton
                  label={`Move item ${i + 1} up`}
                  disabled={disabled || i === 0}
                  onClick={() => set('items', moveItem(items, i, -1))}
                >
                  <ArrowUp className="size-4" />
                </IconButton>
                <IconButton
                  label={`Move item ${i + 1} down`}
                  disabled={disabled || i === items.length - 1}
                  onClick={() => set('items', moveItem(items, i, 1))}
                >
                  <ArrowDown className="size-4" />
                </IconButton>
                <IconButton
                  label={`Remove item ${i + 1}`}
                  disabled={disabled || items.length <= 2}
                  onClick={() =>
                    set(
                      'items',
                      items.filter((_, idx) => idx !== i),
                    )
                  }
                >
                  <Trash2 className="size-4" />
                </IconButton>
              </div>
            </li>
          ))}
        </ol>
        <ListError message={errorAt(form, 'itemsError')} />
        <Button
          className="mt-2"
          size="sm"
          leading={<Plus className="size-4" />}
          disabled={disabled || items.length >= 10}
          onClick={() => set('items', [...items, { id: newChoiceId('i'), text: '' }])}
        >
          Add item
        </Button>
      </fieldset>
      <ScoringField
        form={form}
        disabled={disabled}
        hint="Partial credit scores the share of items in the right position."
      />
    </div>
  );
}

function MatchingEditor({ form, disabled }: EditorProps) {
  const set = useSetter(form);
  const pairs = form.watch('pairs');
  const update = (i: number, patch: Partial<(typeof pairs)[number]>) =>
    set(
      'pairs',
      pairs.map((p, idx) => (idx === i ? { ...p, ...patch } : p)),
    );
  return (
    <div className="grid gap-4">
      <fieldset>
        <legend className="mb-1 text-sm font-medium">
          Matching pairs{' '}
          <span className="font-normal text-text-tertiary">
            (learners see the right side shuffled)
          </span>
        </legend>
        <ul className="grid gap-2">
          {pairs.map((p, i) => (
            <li
              key={p.leftId}
              className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] items-start gap-2"
            >
              <Field
                label={`Pair ${i + 1}, left side`}
                hideLabel
                error={errorAt(form, `pairs.${i}.left`)}
              >
                <Input
                  value={p.left}
                  maxLength={300}
                  disabled={disabled}
                  placeholder="Left side"
                  onChange={(e) => update(i, { left: e.target.value })}
                />
              </Field>
              <Field
                label={`Pair ${i + 1}, right side`}
                hideLabel
                error={errorAt(form, `pairs.${i}.right`)}
              >
                <Input
                  value={p.right}
                  maxLength={300}
                  disabled={disabled}
                  placeholder="Its match"
                  onChange={(e) => update(i, { right: e.target.value })}
                />
              </Field>
              <IconButton
                label={`Remove pair ${i + 1}`}
                disabled={disabled || pairs.length <= 2}
                onClick={() =>
                  set(
                    'pairs',
                    pairs.filter((_, idx) => idx !== i),
                  )
                }
              >
                <Trash2 className="size-4" />
              </IconButton>
            </li>
          ))}
        </ul>
        <ListError message={errorAt(form, 'pairsError')} />
        <Button
          className="mt-2"
          size="sm"
          leading={<Plus className="size-4" />}
          disabled={disabled || pairs.length >= 10}
          onClick={() =>
            set('pairs', [
              ...pairs,
              { leftId: newChoiceId('l'), left: '', rightId: newChoiceId('r'), right: '' },
            ])
          }
        >
          Add pair
        </Button>
      </fieldset>
      <ScoringField
        form={form}
        disabled={disabled}
        hint="Partial credit scores the share of pairs matched correctly."
      />
    </div>
  );
}

/** The part of the editor that depends on the question type. */
export function TypeEditor({ form, disabled }: EditorProps) {
  const type = form.watch('type');
  switch (type) {
    case 'multiple_choice':
      return <OptionsEditor form={form} disabled={disabled} mode="single" max={10} />;
    case 'multiple_select':
      return (
        <div className="grid gap-4">
          <OptionsEditor form={form} disabled={disabled} mode="multiple" max={12} />
          <ScoringField
            form={form}
            disabled={disabled}
            hint="Partial credit awards correct picks minus wrong picks, never below zero."
          />
        </div>
      );
    case 'true_false':
      return <TrueFalseEditor form={form} disabled={disabled} />;
    case 'short_answer':
      return <ShortAnswerEditor form={form} disabled={disabled} />;
    case 'long_answer':
      return <LongAnswerEditor form={form} disabled={disabled} />;
    case 'scenario':
      return <ScenarioEditor form={form} disabled={disabled} />;
    case 'ordering':
      return <OrderingEditor form={form} disabled={disabled} />;
    case 'matching':
      return <MatchingEditor form={form} disabled={disabled} />;
  }
}
