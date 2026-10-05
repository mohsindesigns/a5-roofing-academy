import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import type { ai } from '@a5/contracts';
import { Button, Field, FieldGroup, Input, Notice, Select, Textarea, toast } from '@/components/ui';
import { UnsavedBar } from '@/app/shell/unsaved-bar';
import { ApiError, errorMessage } from '@/lib/api/errors';
import { DIFFICULTY_LABEL } from '@/features/ai-coach/ui';
import { pluralize } from '@/lib/format';
import { useCreateScenario, usePersonas, useRubrics, useUpdateScenario } from './api';
import {
  FIELD_NAMES,
  changedFields,
  emptyScenario,
  fromScenario,
  validateScenario,
  type ScenarioFormValues,
} from './scenario-model';

const PROVIDERS: Array<{ value: ScenarioFormValues['provider']; label: string }> = [
  { value: '', label: 'Organization default' },
  { value: 'anthropic', label: 'Anthropic Claude' },
  { value: 'openai', label: 'OpenAI' },
  { value: 'dev_simulator', label: 'Development simulator' },
];

/** The legend sits outside the fieldset's grid, so it needs its own space below. */
const GROUP = '[&>legend]:mb-4';

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

interface Props {
  mode: 'create' | 'edit';
  scenario?: ai.ScenarioDetail;
  /** The viewer cannot change this scenario (no permission, or archived). */
  readOnly?: boolean;
  onSaved: (scenario: ai.ScenarioDetail) => void;
  onCancel?: () => void;
}

export function ScenarioForm({ mode, scenario, readOnly = false, onSaved, onCancel }: Props) {
  const saved = scenario ? fromScenario(scenario) : emptyScenario();
  const { register, handleSubmit, setError, reset, setValue, watch, formState } =
    useForm<ScenarioFormValues>({ defaultValues: saved });
  const [formError, setFormError] = useState<string | null>(null);
  const personas = usePersonas();
  const rubrics = useRubrics();
  const create = useCreateScenario();
  const update = useUpdateScenario(scenario?.id ?? '');
  const errors = formState.errors;
  const saving = create.isPending || update.isPending;

  // After a save (or a refetch from elsewhere) the form tracks the saved scenario again.
  useEffect(() => {
    if (scenario) reset(fromScenario(scenario));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scenario?.id, scenario?.updatedAt]);

  // Choosing a rubric offers its default pass mark when creating.
  const rubricId = watch('rubricId');
  useEffect(() => {
    if (mode !== 'create' || !rubricId) return;
    const rubric = rubrics.data?.items.find((r) => r.id === rubricId);
    if (rubric && !formState.dirtyFields.passingScore)
      setValue('passingScore', String(rubric.currentVersion.passingScore));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rubricId, rubrics.data]);

  const personaOptions = [...(personas.data?.items ?? [])].filter((p) => !p.archived);
  if (scenario && !personaOptions.some((p) => p.id === scenario.persona.id))
    personaOptions.unshift({ id: scenario.persona.id, name: scenario.persona.name } as ai.Persona);
  const rubricOptions = [...(rubrics.data?.items ?? [])].filter((r) => !r.archived);
  if (scenario && !rubricOptions.some((r) => r.id === scenario.rubric.id))
    rubricOptions.unshift({
      id: scenario.rubric.id,
      title: scenario.rubric.title,
    } as (typeof rubricOptions)[number]);

  const submit = handleSubmit(async (values) => {
    setFormError(null);
    const result = validateScenario(values);
    if (!result.ok) {
      for (const i of result.issues) setError(i.field, { type: 'validate', message: i.message });
      setFormError('Some fields need attention. They are marked below.');
      return;
    }
    try {
      if (mode === 'create') {
        const created = await create.mutateAsync(result.request);
        toast.success('Scenario created', 'It is a draft until you publish it.');
        onSaved(created);
      } else if (scenario) {
        const patch = changedFields(result.request, fromScenario(scenario));
        const next = await update.mutateAsync(patch);
        // Track the saved values again, so the unsaved-changes bar goes away.
        reset(fromScenario(next));
        toast.success('Scenario saved');
        onSaved(next);
      }
    } catch (err) {
      if (err instanceof ApiError) {
        let mapped = false;
        for (const f of err.fields) {
          const name = f.path.split('.')[0] ?? '';
          if ((FIELD_NAMES as readonly string[]).includes(name)) {
            setError(name as keyof ScenarioFormValues, { type: 'server', message: f.message });
            mapped = true;
          }
        }
        if (err.code === 'SCENARIO_TITLE_TAKEN') {
          setError('title', { type: 'server', message: err.message });
          mapped = true;
        }
        setFormError(mapped ? 'Some fields need attention. They are marked below.' : err.message);
      } else setFormError(errorMessage(err));
    }
  });

  const modelErrors = Boolean(
    errors.provider ||
    errors.model ||
    errors.evaluationModel ||
    errors.effort ||
    errors.evaluationEffort ||
    errors.temperature ||
    errors.maxOutputTokens,
  );
  const changed = Object.keys(formState.dirtyFields).filter((k) => k !== 'changeNote').length;
  const live = scenario?.status === 'published';

  return (
    <form onSubmit={submit} noValidate className={mode === 'edit' && changed > 0 ? 'pb-20' : ''}>
      <fieldset disabled={readOnly || saving} className="grid min-w-0 gap-10">
        {live && !readOnly && (
          <Notice tone="information" title="This scenario is live">
            Saving creates a new prompt version. Conversations that start afterward use it;
            conversations already in progress keep the version they began with.
          </Notice>
        )}

        <FieldGroup
          className={GROUP}
          title="The situation"
          description="What the learner walks into. The brief and objection are shown to learners."
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Title" required error={errors.title?.message} className="sm:col-span-2">
              <Input autoComplete="off" {...register('title')} />
            </Field>
            <Field
              label="Category"
              required
              error={errors.category?.message}
              hint="Groups scenarios for learners, such as Price or Insurance."
            >
              <Input autoComplete="off" {...register('category')} />
            </Field>
            <Field label="Difficulty" required error={errors.difficulty?.message}>
              <Select {...register('difficulty')}>
                {Object.entries(DIFFICULTY_LABEL).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field
              label="Objection"
              required
              error={errors.objection?.message}
              hint="The homeowner's line the learner has to handle."
              className="sm:col-span-2"
            >
              <Input {...register('objection')} />
            </Field>
            <Field
              label="Brief for the learner"
              required
              error={errors.repBrief?.message}
              hint="What the representative knows before the door opens."
              className="sm:col-span-2"
            >
              <Textarea rows={4} {...register('repBrief')} />
            </Field>
          </div>
        </FieldGroup>

        <FieldGroup
          className={GROUP}
          title="The homeowner"
          description="Written to the AI in the second person. Never shown to learners."
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Persona" required error={errors.personaId?.message}>
              <Select {...register('personaId')}>
                <option value="">Choose a persona</option>
                {personaOptions.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field
              label="Opening line"
              required
              error={errors.openingLine?.message}
              hint="The first thing the homeowner says."
            >
              <Input {...register('openingLine')} />
            </Field>
            <Field label="Background" required error={errors.background?.message}>
              <Textarea rows={4} {...register('background')} />
            </Field>
            <Field label="Property context" required error={errors.propertyContext?.message}>
              <Textarea rows={4} {...register('propertyContext')} />
            </Field>
            <Field label="What triggered the visit" required error={errors.trigger?.message}>
              <Textarea rows={3} {...register('trigger')} />
            </Field>
            <Field
              label="Hidden concern"
              required
              error={errors.hiddenConcern?.message}
              hint="Revealed only after the learner genuinely discovers it."
            >
              <Textarea rows={3} {...register('hiddenConcern')} />
            </Field>
            <Field
              label="Extra instructions"
              optional
              error={errors.aiInstructions?.message}
              hint="When to soften, when to end the conversation."
              className="sm:col-span-2"
            >
              <Textarea rows={3} {...register('aiInstructions')} />
            </Field>
          </div>
        </FieldGroup>

        <FieldGroup className={GROUP} title="Scoring" description="How the conversation is judged.">
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Rubric" required error={errors.rubricId?.message}>
              <Select {...register('rubricId')}>
                <option value="">Choose a rubric</option>
                {rubricOptions.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.title}
                  </option>
                ))}
              </Select>
            </Field>
            <Field
              label="Pass mark"
              required
              error={errors.passingScore?.message}
              hint="Overall score needed to pass, 0 to 100."
            >
              <Input
                type="number"
                inputMode="numeric"
                min={0}
                max={100}
                {...register('passingScore')}
              />
            </Field>
            <Field
              label="Turn limit"
              required
              error={errors.maxTurns?.message}
              hint="Learner messages allowed, 2 to 60."
            >
              <Input type="number" inputMode="numeric" min={2} max={60} {...register('maxTurns')} />
            </Field>
            <Field
              label="Expected behaviors"
              optional
              error={errors.expectedBehaviors?.message}
              hint="One per line. The evaluator looks for these."
              className="sm:col-span-3"
            >
              <Textarea rows={5} {...register('expectedBehaviors')} />
            </Field>
            <Field
              label="Required talking points"
              optional
              error={errors.requiredTalkingPoints?.message}
              hint="One per line. Points the learner should cover."
              className="sm:col-span-3"
            >
              <Textarea rows={4} {...register('requiredTalkingPoints')} />
            </Field>
            <Field
              label="Forbidden claims"
              optional
              error={errors.forbiddenClaims?.message}
              hint="One per line. Statements the learner must never make."
              className="sm:col-span-3"
            >
              <Textarea rows={4} {...register('forbiddenClaims')} />
            </Field>
          </div>
        </FieldGroup>

        <details
          open={modelErrors ? true : undefined}
          className="group rounded-lg border border-border"
        >
          <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between px-4 text-md font-semibold [&::-webkit-details-marker]:hidden">
            Model settings
            <span aria-hidden className="text-sm font-normal text-text-secondary group-open:hidden">
              Show
            </span>
            <span
              aria-hidden
              className="hidden text-sm font-normal text-text-secondary group-open:inline"
            >
              Hide
            </span>
          </summary>
          <div className="grid gap-4 border-t border-divider p-4 sm:grid-cols-2">
            <p className="text-sm text-text-secondary sm:col-span-2">
              Leave these blank to use the organization defaults. Settings a model does not support
              are ignored.
            </p>
            <Field label="Provider" error={errors.provider?.message}>
              <Select {...register('provider')}>
                {PROVIDERS.map((p) => (
                  <option key={p.value} value={p.value}>
                    {p.label}
                  </option>
                ))}
              </Select>
            </Field>
            <span className="hidden sm:block" />
            <Field label="Conversation model" optional error={errors.model?.message}>
              <Input className="font-mono" autoComplete="off" {...register('model')} />
            </Field>
            <Field label="Scoring model" optional error={errors.evaluationModel?.message}>
              <Input className="font-mono" autoComplete="off" {...register('evaluationModel')} />
            </Field>
            <Field label="Reply effort" optional error={errors.effort?.message}>
              <Select {...register('effort')}>
                <option value="">Default</option>
                {EFFORTS.map((e) => (
                  <option key={e} value={e}>
                    {e}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Scoring effort" optional error={errors.evaluationEffort?.message}>
              <Select {...register('evaluationEffort')}>
                <option value="">Default</option>
                {EFFORTS.map((e) => (
                  <option key={e} value={e}>
                    {e}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Temperature" optional error={errors.temperature?.message} hint="0 to 1">
              <Input
                type="number"
                inputMode="decimal"
                step="0.1"
                min={0}
                max={1}
                {...register('temperature')}
              />
            </Field>
            <Field label="Longest reply (tokens)" optional error={errors.maxOutputTokens?.message}>
              <Input type="number" inputMode="numeric" min={64} {...register('maxOutputTokens')} />
            </Field>
          </div>
        </details>

        {mode === 'edit' && !readOnly && (
          <Field
            label="Note for this change"
            optional
            hint="Saved with the new prompt version so others can see why it changed."
            error={errors.changeNote?.message}
          >
            <Input maxLength={300} {...register('changeNote')} />
          </Field>
        )}

        {formError && (
          <p role="alert" className="rounded bg-danger-soft px-3 py-2 text-sm text-danger">
            {formError}
          </p>
        )}

        {mode === 'create' && (
          <div className="flex justify-end gap-2 border-t border-divider pt-5">
            {onCancel && (
              <Button onClick={onCancel} disabled={saving}>
                Cancel
              </Button>
            )}
            <Button type="submit" variant="primary" loading={saving}>
              Create scenario
            </Button>
          </div>
        )}
      </fieldset>

      {mode === 'edit' && !readOnly && changed > 0 && (
        <UnsavedBar
          actions={
            <>
              <Button
                disabled={saving}
                onClick={() => {
                  reset(saved);
                  setFormError(null);
                }}
              >
                Discard
              </Button>
              <Button type="submit" variant="primary" loading={saving}>
                Save changes
              </Button>
            </>
          }
        >
          <span className="font-medium">Unsaved changes</span>
          <span className="text-text-secondary"> in {pluralize(changed, 'field')}</span>
        </UnsavedBar>
      )}
    </form>
  );
}
