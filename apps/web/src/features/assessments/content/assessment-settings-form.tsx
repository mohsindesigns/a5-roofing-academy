import { useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { assessment } from '@a5/contracts';
import {
  Button,
  Checkbox,
  Field,
  FieldGroup,
  Input,
  Notice,
  Select,
  Switch,
  Textarea,
  toast,
} from '@/components/ui';
import { UnsavedBar } from '@/app/shell/unsaved-bar';
import { applyServerErrors } from '@/lib/forms';
import { useUpdateAssessment } from '../api';
import { KIND_LABELS, REVEAL_HINTS, REVEAL_LABELS } from '../labels';
import { toRequest, toValues, type SettingsValues } from './settings-model';

function SwitchRow({
  checked,
  onChange,
  title,
  hint,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  title: string;
  hint?: string;
  disabled?: boolean;
}) {
  return (
    <label className="flex items-start gap-3">
      <Switch checked={checked} onCheckedChange={onChange} disabled={disabled} className="mt-0.5" />
      <span className="min-w-0">
        <span className="block font-medium">{title}</span>
        {hint && <span className="block text-sm text-text-secondary">{hint}</span>}
      </span>
    </label>
  );
}

export function AssessmentSettingsForm({
  detail,
  canEdit,
}: {
  detail: assessment.AssessmentDetail;
  canEdit: boolean;
}) {
  const update = useUpdateAssessment(detail.id);
  const [formError, setFormError] = useState<string | null>(null);
  const locked = !canEdit || detail.status === 'archived';
  const { register, control, handleSubmit, setError, reset, watch, formState } =
    useForm<SettingsValues>({
      values: toValues(detail),
      resetOptions: { keepDirtyValues: true },
    });
  const { errors, isDirty, isSubmitting } = formState;
  const limitAttempts = watch('limitAttempts');
  const limitTime = watch('limitTime');
  const policy = watch('revealCorrectAnswers');

  const save = handleSubmit(async (values) => {
    setFormError(null);
    const { request, issues } = toRequest(values);
    if (!request) {
      for (const i of issues) setError(i.field, { message: i.message });
      return;
    }
    try {
      const saved = await update.mutateAsync(request);
      reset(toValues(saved));
      toast.success('Settings saved');
    } catch (err) {
      setFormError(applyServerErrors(err, setError, ['title', 'description', 'kind']));
    }
  });

  return (
    <form onSubmit={save} noValidate className="grid max-w-2xl gap-10 pb-24">
      {detail.status === 'archived' && (
        <Notice tone="warning" title="This assessment is archived">
          Publish it again, or duplicate it, to make changes.
        </Notice>
      )}
      {detail.status === 'published' && !locked && (
        <Notice tone="information">
          Changes apply to attempts that start after you save. Attempts already in progress keep the
          settings they started with.
        </Notice>
      )}

      <FieldGroup title="Details">
        <Field label="Title" required error={errors.title?.message}>
          <Input maxLength={200} disabled={locked} {...register('title')} />
        </Field>
        <Field
          label="Description"
          optional
          hint="Learners read this before they start."
          error={errors.description?.message}
        >
          <Textarea rows={3} maxLength={5000} disabled={locked} {...register('description')} />
        </Field>
        <Field label="Type" error={errors.kind?.message}>
          <Select disabled={locked} {...register('kind')}>
            {assessment.ASSESSMENT_KINDS.map((k) => (
              <option key={k} value={k}>
                {KIND_LABELS[k]}
              </option>
            ))}
          </Select>
        </Field>
      </FieldGroup>

      <FieldGroup
        title="Passing and attempts"
        description="These values are what learners see on the intro screen and what the results use."
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Pass mark (%)" required error={errors.passingPercent?.message}>
            <Input
              type="number"
              inputMode="decimal"
              min={0}
              max={100}
              step="any"
              disabled={locked}
              {...register('passingPercent')}
            />
          </Field>
          <div className="grid content-start gap-2">
            <Controller
              control={control}
              name="limitAttempts"
              render={({ field }) => (
                <SwitchRow
                  checked={field.value}
                  onChange={field.onChange}
                  disabled={locked}
                  title="Limit attempts"
                  hint="Turn off to allow unlimited attempts."
                />
              )}
            />
            {limitAttempts && (
              <Field label="Attempts allowed" hideLabel error={errors.maxAttempts?.message}>
                <Input
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={100}
                  disabled={locked}
                  {...register('maxAttempts')}
                />
              </Field>
            )}
          </div>
        </div>
        <Field
          label="Wait between attempts"
          hint="Set 0 to let learners retry straight away."
          error={errors.cooldownValue?.message}
        >
          <div className="flex gap-2">
            <Input
              type="number"
              inputMode="numeric"
              min={0}
              className="max-w-[120px]"
              disabled={locked}
              {...register('cooldownValue')}
            />
            <Select
              aria-label="Unit for the wait between attempts"
              className="w-[140px]"
              disabled={locked}
              {...register('cooldownUnit')}
            >
              <option value="minutes">minutes</option>
              <option value="hours">hours</option>
              <option value="days">days</option>
            </Select>
          </div>
        </Field>
        <Controller
          control={control}
          name="allowStandalone"
          render={({ field }) => (
            <SwitchRow
              checked={field.value}
              onChange={field.onChange}
              disabled={locked}
              title="Allow practice outside a lesson"
              hint="Learners can start this from the assessment library without opening its lesson. Leave off to require the lesson."
            />
          )}
        />
      </FieldGroup>

      <FieldGroup
        title="Time limit"
        description="The server keeps the clock. A learner who leaves the page does not pause it."
      >
        <Controller
          control={control}
          name="limitTime"
          render={({ field }) => (
            <SwitchRow
              checked={field.value}
              onChange={field.onChange}
              disabled={locked}
              title="Limit the time"
              hint="Turn off for no time limit."
            />
          )}
        />
        {limitTime && (
          <Field label="Minutes allowed" error={errors.timeLimitMinutes?.message}>
            <Input
              type="number"
              inputMode="numeric"
              min={1}
              max={480}
              className="max-w-[140px]"
              disabled={locked}
              {...register('timeLimitMinutes')}
            />
          </Field>
        )}
      </FieldGroup>

      <FieldGroup title="Randomization">
        <Controller
          control={control}
          name="randomizeQuestions"
          render={({ field }) => (
            <SwitchRow
              checked={field.value}
              onChange={field.onChange}
              disabled={locked}
              title="Shuffle question order"
              hint="Each attempt shows the questions in a different order."
            />
          )}
        />
        <Controller
          control={control}
          name="randomizeOptions"
          render={({ field }) => (
            <SwitchRow
              checked={field.value}
              onChange={field.onChange}
              disabled={locked}
              title="Shuffle answer options"
              hint="Choices appear in a different order for each learner. Ordering and matching are always shuffled."
            />
          )}
        />
      </FieldGroup>

      <FieldGroup title="What learners see afterwards">
        <Controller
          control={control}
          name="revealScore"
          render={({ field }) => (
            <SwitchRow
              checked={field.value}
              onChange={field.onChange}
              disabled={locked}
              title="Show score and results by question"
              hint="Turn off to tell learners only whether they passed."
            />
          )}
        />
        <Field label="Show correct answers and explanations" hint={REVEAL_HINTS[policy]}>
          <Select disabled={locked} {...register('revealCorrectAnswers')}>
            {assessment.REVEAL_POLICIES.map((p) => (
              <option key={p} value={p}>
                {REVEAL_LABELS[p]}
              </option>
            ))}
          </Select>
        </Field>
        {policy === 'after_final_attempt' && !limitAttempts && (
          <Notice tone="warning">
            Attempts are unlimited, so learners will never reach their last attempt and answers will
            stay hidden.
          </Notice>
        )}
      </FieldGroup>

      <FieldGroup
        title="Manager notifications"
        description="Managers of the learner are notified when an attempt ends with one of these results."
      >
        <div className="grid gap-2">
          <Controller
            control={control}
            name="notifyFailed"
            render={({ field }) => (
              <label className="flex items-center gap-3">
                <Checkbox
                  checked={field.value}
                  onCheckedChange={(c) => field.onChange(c === true)}
                  disabled={locked}
                />
                <span>Learner did not pass</span>
              </label>
            )}
          />
          <Controller
            control={control}
            name="notifyPassed"
            render={({ field }) => (
              <label className="flex items-center gap-3">
                <Checkbox
                  checked={field.value}
                  onCheckedChange={(c) => field.onChange(c === true)}
                  disabled={locked}
                />
                <span>Learner passed</span>
              </label>
            )}
          />
        </div>
      </FieldGroup>

      {formError && (
        <p role="alert" className="rounded bg-danger-soft px-3 py-2 text-sm text-danger">
          {formError}
        </p>
      )}

      {isDirty && !locked && (
        <UnsavedBar
          actions={
            <>
              <Button onClick={() => reset(toValues(detail))} disabled={isSubmitting}>
                Discard
              </Button>
              <Button type="submit" variant="primary" loading={isSubmitting}>
                Save settings
              </Button>
            </>
          }
        >
          You have unsaved changes to this assessment.
        </UnsavedBar>
      )}
    </form>
  );
}
