import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import {
  Button,
  DialogContent,
  DialogRoot,
  Field,
  Input,
  MultiSelect,
  Skeleton,
  Textarea,
  toast,
} from '@/components/ui';
import { errorMessage } from '@/lib/api/errors';
import { applyServerErrors } from '@/lib/forms';
import {
  useAssignTemplate,
  useCloneTemplate,
  useCreateTemplate,
  useDefinitionOptions,
  useTemplateStarters,
  useUpdateTemplate,
} from './api';
import type { StarterKey, TemplateDetail } from './types';

const CENTER_TEMPLATES = '/certification-center/templates';

const createSchema = z.object({
  name: z.string().trim().min(1, 'Give the template a name').max(120),
  description: z.string().trim().max(500),
});

/** New template from one of the starter designs. */
export function CreateTemplateDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const navigate = useNavigate();
  const starters = useTemplateStarters();
  const create = useCreateTemplate();
  const [starter, setStarter] = useState<StarterKey>('classic');
  const [formError, setFormError] = useState<string | null>(null);
  const { register, handleSubmit, setError, formState, reset } = useForm<
    z.infer<typeof createSchema>
  >({
    resolver: zodResolver(createSchema),
    defaultValues: { name: '', description: '' },
  });
  return (
    <DialogRoot
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          reset();
          setFormError(null);
        }
        onOpenChange(next);
      }}
    >
      <DialogContent
        title="New certificate template"
        description="Start from a starter design, then change anything in the designer."
        dismissible={!create.isPending}
        footer={
          <>
            <Button onClick={() => onOpenChange(false)} disabled={create.isPending}>
              Cancel
            </Button>
            <Button
              type="submit"
              form="create-template"
              variant="primary"
              loading={create.isPending}
            >
              Create and open designer
            </Button>
          </>
        }
      >
        <form
          id="create-template"
          className="grid gap-4"
          noValidate
          onSubmit={handleSubmit(async (v) => {
            setFormError(null);
            try {
              const created = await create.mutateAsync({
                name: v.name,
                description: v.description || null,
                starter,
              });
              toast.success(`${created.name} created`);
              onOpenChange(false);
              navigate(`${CENTER_TEMPLATES}/${created.id}`);
            } catch (err) {
              setFormError(applyServerErrors(err, setError, ['name', 'description']));
            }
          })}
        >
          <Field label="Name" required error={formState.errors.name?.message}>
            <Input autoFocus {...register('name')} />
          </Field>
          <Field label="Description" optional error={formState.errors.description?.message}>
            <Textarea rows={2} {...register('description')} />
          </Field>
          <fieldset className="grid gap-2">
            <legend className="mb-1 text-sm font-medium">Starter design</legend>
            {starters.isPending ? (
              <Skeleton className="h-20 w-full" />
            ) : starters.isError ? (
              <p role="alert" className="rounded bg-danger-soft px-3 py-2 text-sm text-danger">
                {errorMessage(starters.error)}
              </p>
            ) : (
              starters.data.items.map((s) => (
                <label
                  key={s.key}
                  className="flex cursor-pointer items-start gap-3 rounded-lg border border-border-strong bg-surface p-3 has-[:checked]:border-brand-secondary has-[:checked]:bg-brand-secondary-soft"
                >
                  <input
                    type="radio"
                    name="starter"
                    className="mt-1 accent-[var(--a5-brand-secondary)]"
                    checked={starter === s.key}
                    onChange={() => setStarter(s.key)}
                  />
                  <span>
                    <span className="block font-medium">{s.name}</span>
                    <span className="block text-sm text-text-secondary">{s.description}</span>
                  </span>
                </label>
              ))
            )}
          </fieldset>
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

/** Rename or clone: both ask for one name. */
export function NameTemplateDialog({
  template,
  mode,
  open,
  onOpenChange,
}: {
  template: Pick<TemplateDetail, 'id' | 'name'>;
  mode: 'rename' | 'clone';
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const navigate = useNavigate();
  const rename = useUpdateTemplate(template.id);
  const clone = useCloneTemplate(template.id);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState(mode === 'clone' ? `${template.name} (copy)` : template.name);
  const pending = rename.isPending || clone.isPending;
  const invalid = name.trim().length === 0 || name.trim().length > 120;
  const submit = () => {
    setError(null);
    if (mode === 'rename') {
      rename.mutate(
        { name: name.trim() },
        {
          onSuccess: () => {
            toast.success('Template renamed');
            onOpenChange(false);
          },
          onError: (err) => setError(errorMessage(err)),
        },
      );
    } else {
      clone.mutate(name.trim(), {
        onSuccess: (created) => {
          toast.success(`Cloned as ${created.name}`);
          onOpenChange(false);
          navigate(`${CENTER_TEMPLATES}/${created.id}`);
        },
        onError: (err) => setError(errorMessage(err)),
      });
    }
  };
  return (
    <DialogRoot open={open} onOpenChange={onOpenChange}>
      <DialogContent
        size="sm"
        title={mode === 'rename' ? 'Rename template' : 'Clone template'}
        description={
          mode === 'clone' ? 'The copy starts from the current version of this design.' : undefined
        }
        dismissible={!pending}
        footer={
          <>
            <Button onClick={() => onOpenChange(false)} disabled={pending}>
              Cancel
            </Button>
            <Button variant="primary" loading={pending} disabled={invalid} onClick={submit}>
              {mode === 'rename' ? 'Rename' : 'Clone'}
            </Button>
          </>
        }
      >
        <Field label="Name" required>
          <Input autoFocus value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
        </Field>
        {error && (
          <p role="alert" className="mt-3 rounded bg-danger-soft px-3 py-2 text-sm text-danger">
            {error}
          </p>
        )}
      </DialogContent>
    </DialogRoot>
  );
}

/** Use this template for several certifications at once. */
export function AssignTemplateDialog({
  template,
  open,
  onOpenChange,
}: {
  template: Pick<TemplateDetail, 'id' | 'name' | 'usedBy'>;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const definitions = useDefinitionOptions();
  const assign = useAssignTemplate(template.id);
  const [ids, setIds] = useState<string[]>(template.usedBy.map((u) => u.id));
  const [error, setError] = useState<string | null>(null);
  const options = (definitions.data?.items ?? []).map((d) => ({ value: d.id, label: d.name }));
  const original = new Set(template.usedBy.map((u) => u.id));
  const added = ids.filter((id) => !original.has(id));
  return (
    <DialogRoot open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="Use for certifications"
        description={`Choose the certifications that print ${template.name}. To stop using it, assign a different template from the certification.`}
        dismissible={!assign.isPending}
        footer={
          <>
            <Button onClick={() => onOpenChange(false)} disabled={assign.isPending}>
              Cancel
            </Button>
            <Button
              variant="primary"
              loading={assign.isPending}
              disabled={added.length === 0}
              onClick={() => {
                setError(null);
                assign.mutate(added, {
                  onSuccess: () => {
                    toast.success(
                      `Assigned to ${added.length} ${added.length === 1 ? 'certification' : 'certifications'}`,
                    );
                    onOpenChange(false);
                  },
                  onError: (err) => setError(errorMessage(err)),
                });
              }}
            >
              Assign
            </Button>
          </>
        }
      >
        <Field label="Certifications">
          <MultiSelect
            options={options}
            value={ids}
            // Certifications already using the template stay selected: removing one here does nothing.
            onChange={(next) =>
              setIds([...new Set([...template.usedBy.map((u) => u.id), ...next])])
            }
            selectedLabels={Object.fromEntries(template.usedBy.map((u) => [u.id, u.name]))}
            loading={definitions.isPending}
            placeholder="Search certifications"
          />
        </Field>
        {error && (
          <p role="alert" className="mt-3 rounded bg-danger-soft px-3 py-2 text-sm text-danger">
            {error}
          </p>
        )}
      </DialogContent>
    </DialogRoot>
  );
}
