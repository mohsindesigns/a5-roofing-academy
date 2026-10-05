import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { ai } from '@a5/contracts';
import { Button, DialogContent, DialogRoot, Field, Input, Textarea, toast } from '@/components/ui';
import { ApiError, errorMessage } from '@/lib/api/errors';
import { friendlyIssue } from './scenario-model';
import { useCreatePersona, useUpdatePersona } from './api';

interface PersonaValues {
  name: string;
  description: string;
  temperament: string;
  speakingStyle: string;
  background: string;
  /** One trait per line. */
  traits: string;
  changeNote: string;
}

const FIELDS = [
  'name',
  'description',
  'temperament',
  'speakingStyle',
  'background',
  'traits',
  'changeNote',
] as const;

function toValues(p?: ai.Persona): PersonaValues {
  return {
    name: p?.name ?? '',
    description: p?.description ?? '',
    temperament: p?.temperament ?? '',
    speakingStyle: p?.speakingStyle ?? '',
    background: p?.background ?? '',
    traits: p?.traits.join('\n') ?? '',
    changeNote: '',
  };
}

function toRequest(v: PersonaValues) {
  return {
    name: v.name,
    description: v.description,
    temperament: v.temperament,
    speakingStyle: v.speakingStyle,
    background: v.background,
    traits: v.traits
      .split('\n')
      .map((t) => t.trim())
      .filter(Boolean),
  };
}

export function PersonaDialog({
  persona,
  onClose,
}: {
  /** Omit to create a persona. */
  persona?: ai.Persona;
  onClose: () => void;
}) {
  const { register, handleSubmit, setError, formState } = useForm<PersonaValues>({
    defaultValues: toValues(persona),
  });
  const [formError, setFormError] = useState<string | null>(null);
  const create = useCreatePersona();
  const update = useUpdatePersona(persona?.id ?? '');
  const saving = create.isPending || update.isPending;
  const errors = formState.errors;

  const submit = handleSubmit(async (values) => {
    setFormError(null);
    const body = toRequest(values);
    const parsed = ai.createPersonaRequestSchema.safeParse(body);
    if (!parsed.success) {
      const seen = new Set<string>();
      for (const issue of parsed.error.issues) {
        const field = String(issue.path[0] ?? '');
        if (!(FIELDS as readonly string[]).includes(field) || seen.has(field)) continue;
        seen.add(field);
        setError(field as keyof PersonaValues, { type: 'validate', message: friendlyIssue(issue) });
      }
      return;
    }
    try {
      if (persona) {
        await update.mutateAsync({
          ...parsed.data,
          ...(values.changeNote.trim() && { changeNote: values.changeNote.trim() }),
        });
        toast.success('Persona saved', 'Scenarios that use it have a new prompt version.');
      } else {
        await create.mutateAsync(parsed.data);
        toast.success('Persona created');
      }
      onClose();
    } catch (err) {
      if (err instanceof ApiError && err.fields.length > 0) {
        for (const f of err.fields) {
          const name = f.path.split('.')[0] ?? '';
          if ((FIELDS as readonly string[]).includes(name))
            setError(name as keyof PersonaValues, { type: 'server', message: f.message });
        }
        setFormError(err.message);
      } else setFormError(errorMessage(err));
    }
  });

  return (
    <DialogRoot open onOpenChange={(open) => !open && !saving && onClose()}>
      <DialogContent
        size="lg"
        title={persona ? `Edit ${persona.name}` : 'New persona'}
        description={
          persona
            ? 'Saving creates a new prompt version for every live scenario that uses this persona.'
            : 'A homeowner character that scenarios can share.'
        }
        dismissible={!saving}
        footer={
          <>
            <Button onClick={onClose} disabled={saving}>
              Cancel
            </Button>
            <Button type="submit" form="persona-form" variant="primary" loading={saving}>
              {persona ? 'Save persona' : 'Create persona'}
            </Button>
          </>
        }
      >
        <form id="persona-form" onSubmit={submit} noValidate className="grid gap-4">
          <Field label="Name" required error={errors.name?.message}>
            <Input autoComplete="off" {...register('name')} />
          </Field>
          <Field
            label="Description"
            required
            error={errors.description?.message}
            hint="Who this homeowner is and how they behave at the door."
          >
            <Textarea rows={4} {...register('description')} />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Temperament" required error={errors.temperament?.message}>
              <Textarea rows={3} {...register('temperament')} />
            </Field>
            <Field label="Speaking style" required error={errors.speakingStyle?.message}>
              <Textarea rows={3} {...register('speakingStyle')} />
            </Field>
          </div>
          <Field label="Background" required error={errors.background?.message}>
            <Textarea rows={4} {...register('background')} />
          </Field>
          <Field
            label="Traits"
            optional
            error={errors.traits?.message}
            hint="One per line, up to 12."
          >
            <Textarea rows={4} {...register('traits')} />
          </Field>
          {persona && (
            <Field label="Note for this change" optional error={errors.changeNote?.message}>
              <Input maxLength={300} {...register('changeNote')} />
            </Field>
          )}
          {formError && (
            <p role="alert" className="rounded bg-danger-soft px-3 py-2 text-sm text-danger">
              {formError}
            </p>
          )}
        </form>
      </DialogContent>
    </DialogRoot>
  );
}
