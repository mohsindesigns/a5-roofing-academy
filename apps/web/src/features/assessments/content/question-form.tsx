import { useRef, useState } from 'react';
import { useBlocker } from 'react-router';
import { get, useForm, type FieldErrors, type Resolver } from 'react-hook-form';
import { assessment } from '@a5/contracts';
import {
  Button,
  ConfirmDialog,
  Field,
  FieldGroup,
  Input,
  MultiSelect,
  Notice,
  Select,
  Textarea,
  toast,
} from '@/components/ui';
import { UnsavedBar } from '@/app/shell/unsaved-bar';
import { ApiError } from '@/lib/api/errors';
import { useBank, useBanks, useCreateQuestion, useUpdateQuestion } from '../api';
import { DIFFICULTY_LABELS } from '../labels';
import {
  formPath,
  needsManualReview,
  setIn,
  validateForm,
  withType,
  type QuestionFormValues,
} from './question-form-model';
import { errorAt, TypeEditor } from './type-editors';

function makeResolver(creating: boolean): Resolver<QuestionFormValues> {
  return async (values) => {
    const { issues } = validateForm(values, { creating });
    if (issues.length === 0) return { values, errors: {} };
    const errors: Record<string, unknown> = {};
    for (const issue of issues) {
      if (!get(errors, issue.path))
        setIn(errors, issue.path, { type: 'validation', message: issue.message });
    }
    return { values: {}, errors: errors as FieldErrors<QuestionFormValues> };
  };
}

export function QuestionForm({
  initial,
  question,
  readOnly,
  seededFrom,
  onCreated,
  onReloadLatest,
}: {
  initial: QuestionFormValues;
  /** Present when editing an existing question. */
  question?: assessment.QuestionDetail;
  readOnly: boolean;
  /** Version number the form was filled from, when that is not the current version. */
  seededFrom?: number;
  onCreated: (id: string) => void;
  onReloadLatest: () => void;
}) {
  const creating = !question;
  const create = useCreateQuestion();
  const update = useUpdateQuestion(question?.id ?? '');
  const banks = useBanks();
  const [formError, setFormError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);
  const leaving = useRef(false);

  const form = useForm<QuestionFormValues>({
    defaultValues: initial,
    resolver: makeResolver(creating),
    mode: 'onSubmit',
    reValidateMode: 'onChange',
  });
  const { register, handleSubmit, setError, reset, watch, formState } = form;
  const bankId = watch('bankId');
  const type = watch('type');
  const bank = useBank(bankId || undefined);
  const dirty = formState.isDirty;

  // Warn before leaving with unsaved work. A save that is about to navigate away is allowed through.
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      dirty && !leaving.current && currentLocation.pathname !== nextLocation.pathname,
  );

  const save = handleSubmit(async (values) => {
    setFormError(null);
    setConflict(null);
    const { payload } = validateForm(values, { creating });
    try {
      if (!question) {
        const created = await create.mutateAsync({
          ...payload,
          bankId: values.bankId,
        } as assessment.CreateQuestionRequest);
        leaving.current = true;
        toast.success('Question created');
        onCreated(created.id);
        return;
      }
      const saved = await update.mutateAsync({
        ...payload,
        changeNote: values.changeNote.trim() || null,
        expectedVersion: question.currentVersion.version,
      } as assessment.UpdateQuestionRequest);
      if (saved.currentVersion.version === question.currentVersion.version) {
        toast.info(
          'Nothing changed',
          'The content matches the current version, so no new version was saved.',
        );
        reset(values);
      } else {
        toast.success(
          `Saved as version ${saved.currentVersion.version}`,
          'Assessments use the new version for attempts that start from now on.',
        );
      }
    } catch (err) {
      if (err instanceof ApiError && err.code === 'QUESTION_CHANGED') {
        setConflict(err.message);
        return;
      }
      if (err instanceof ApiError && err.fields.length > 0) {
        for (const f of err.fields)
          setError(formPath(f.path.split('.')) as never, { message: f.message });
        setFormError(err.message);
        return;
      }
      setFormError(err instanceof Error ? err.message : 'The question could not be saved.');
    }
  });

  const changeType = (next: assessment.QuestionType) => {
    reset(withType(form.getValues(), next), { keepDefaultValues: true });
  };

  const categories = bank.data?.categories ?? [];
  const competencies = bank.data?.competencies ?? [];
  const manual = needsManualReview(watch());

  return (
    <form onSubmit={save} noValidate className="grid max-w-3xl gap-10 pb-24">
      {readOnly && (
        <Notice
          tone="warning"
          title={
            question?.status === 'archived'
              ? 'This question is archived'
              : 'You can view this question but not edit it'
          }
        >
          {question?.status === 'archived'
            ? 'Restore it to make changes. Archived questions are not drawn into new attempts.'
            : 'Your role does not include editing questions.'}
        </Notice>
      )}
      {seededFrom !== undefined && (
        <Notice tone="information" title={`Started from version ${seededFrom}`}>
          Saving creates a new version with this content. The versions in between are kept.
        </Notice>
      )}
      {conflict && (
        <Notice
          tone="danger"
          title="Someone else saved this question"
          action={
            <Button size="sm" onClick={onReloadLatest}>
              Load the latest version
            </Button>
          }
        >
          {conflict}
        </Notice>
      )}

      <FieldGroup title="Question">
        <div className="grid gap-4 sm:grid-cols-2">
          {creating ? (
            <>
              <Field label="Question type" error={errorAt(form, 'type')}>
                <Select
                  value={type}
                  disabled={readOnly}
                  onChange={(e) => changeType(e.target.value as assessment.QuestionType)}
                >
                  {assessment.QUESTION_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {assessment.QUESTION_TYPE_LABELS[t]}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Question bank" required error={errorAt(form, 'bankId')}>
                <Select
                  disabled={readOnly || banks.isPending}
                  {...register('bankId', { onChange: () => form.setValue('categoryId', '') })}
                >
                  <option value="">Choose a bank</option>
                  {banks.data?.items
                    .filter((b) => !b.archived)
                    .map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.title}
                      </option>
                    ))}
                </Select>
              </Field>
            </>
          ) : (
            <>
              <Field
                label="Question type"
                hint="The type is fixed once a question exists. Create a new question to use a different type."
              >
                <Input value={assessment.QUESTION_TYPE_LABELS[type]} readOnly disabled />
              </Field>
              <Field label="Question bank">
                <Input value={question.bank.title} readOnly disabled />
              </Field>
            </>
          )}
        </div>
        <Field
          label="Question text"
          required
          hint="Supports basic Markdown: bold, lists and links."
          error={errorAt(form, 'prompt')}
        >
          <Textarea rows={4} maxLength={5000} disabled={readOnly} {...register('prompt')} />
        </Field>
      </FieldGroup>

      <FieldGroup
        title="Answer"
        description={
          manual
            ? 'A trainer reads and scores written answers for this question.'
            : 'Marked automatically when the learner submits.'
        }
      >
        <TypeEditor form={form} disabled={readOnly} />
      </FieldGroup>

      <FieldGroup title="Details">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Points" required error={errorAt(form, 'points')}>
            <Input
              type="number"
              inputMode="decimal"
              min={0}
              max={100}
              step="any"
              disabled={readOnly}
              {...register('points')}
            />
          </Field>
          <Field label="Difficulty" error={errorAt(form, 'difficulty')}>
            <Select disabled={readOnly} {...register('difficulty')}>
              {assessment.DIFFICULTIES.map((d) => (
                <option key={d} value={d}>
                  {DIFFICULTY_LABELS[d]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Category" optional error={errorAt(form, 'categoryId')}>
            <Select
              disabled={readOnly || !bankId}
              value={watch('categoryId')}
              onChange={(e) => form.setValue('categoryId', e.target.value, { shouldDirty: true })}
            >
              <option value="">No category</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field
            label="Tags"
            optional
            hint="Separate with commas. Random draws can filter by tag."
            error={errorAt(form, 'tags')}
          >
            <Input disabled={readOnly} autoComplete="off" {...register('tags')} />
          </Field>
        </div>
        {competencies.length > 0 && (
          <Field
            label="Competencies"
            optional
            hint="The skills this question tests."
            error={errorAt(form, 'competencyIds')}
          >
            <MultiSelect
              options={competencies.map((c) => ({ value: c.id, label: c.name }))}
              value={watch('competencyIds')}
              onChange={(ids) => form.setValue('competencyIds', ids, { shouldDirty: true })}
              placeholder="Add a competency"
              max={10}
            />
          </Field>
        )}
        <Field
          label="Explanation"
          optional
          hint="Shown with the correct answer when the assessment reveals answers. Explain why, not only what."
          error={errorAt(form, 'explanation')}
        >
          <Textarea rows={3} maxLength={5000} disabled={readOnly} {...register('explanation')} />
        </Field>
        {!creating && !readOnly && (
          <Field
            label="What changed?"
            optional
            hint="Saved with the new version so others can see why it changed."
            error={errorAt(form, 'changeNote')}
          >
            <Input maxLength={500} autoComplete="off" {...register('changeNote')} />
          </Field>
        )}
      </FieldGroup>

      {formError && (
        <p role="alert" className="rounded bg-danger-soft px-3 py-2 text-sm text-danger">
          {formError}
        </p>
      )}

      {creating && !readOnly && (
        <div className="flex justify-end gap-2 border-t border-divider pt-5">
          <Button type="submit" variant="primary" loading={formState.isSubmitting}>
            Create question
          </Button>
        </div>
      )}
      {!creating && !readOnly && dirty && (
        <UnsavedBar
          actions={
            <>
              <Button onClick={() => reset(initial)} disabled={formState.isSubmitting}>
                Discard
              </Button>
              <Button type="submit" variant="primary" loading={formState.isSubmitting}>
                Save as version {question.currentVersion.version + 1}
              </Button>
            </>
          }
        >
          You have unsaved changes. Saving creates version {question.currentVersion.version + 1};
          earlier versions are kept.
        </UnsavedBar>
      )}

      <ConfirmDialog
        open={blocker.state === 'blocked'}
        onOpenChange={(o) => !o && blocker.state === 'blocked' && blocker.reset()}
        title="Leave without saving?"
        description="Your changes to this question have not been saved."
        confirmLabel="Leave"
        tone="danger"
        onConfirm={() => blocker.state === 'blocked' && blocker.proceed()}
      />
    </form>
  );
}
