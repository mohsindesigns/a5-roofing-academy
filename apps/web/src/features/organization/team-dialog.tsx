import { useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import type { identity } from '@a5/contracts';
import {
  Button,
  DialogContent,
  DialogRoot,
  Field,
  Input,
  Select,
  Textarea,
  toast,
} from '@/components/ui';
import { PeoplePicker } from '@/features/people/people-picker';
import { applyServerErrors } from '@/lib/forms';
import { useDepartments, useLocations, useSaveTeam } from './api';

const schema = z.object({
  name: z.string().trim().min(1, 'Required').max(120),
  description: z.string().trim().max(500),
  locationId: z.string(),
  departmentId: z.string(),
  managerIds: z.array(z.string()).max(10),
});
type Values = z.infer<typeof schema>;

export function TeamDialog({
  team,
  open,
  onOpenChange,
  onSaved,
}: {
  team?: identity.TeamSummary;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onSaved?: (team: identity.TeamDetail) => void;
}) {
  const save = useSaveTeam();
  const locations = useLocations();
  const departments = useDepartments();
  const [formError, setFormError] = useState<string | null>(null);
  const { register, control, handleSubmit, setError, formState } = useForm<Values>({
    resolver: zodResolver(schema),
    values: {
      name: team?.name ?? '',
      description: team?.description ?? '',
      locationId: team?.location?.id ?? '',
      departmentId: team?.department?.id ?? '',
      managerIds: team?.managers.map((m) => m.id) ?? [],
    },
  });
  return (
    <DialogRoot
      open={open}
      onOpenChange={(o) => {
        setFormError(null);
        onOpenChange(o);
      }}
    >
      <DialogContent
        title={team ? `Edit ${team.name}` : 'New team'}
        description="Team managers can follow the training of every member."
      >
        <form
          className="grid gap-4"
          onSubmit={handleSubmit(async (v) => {
            setFormError(null);
            try {
              const saved = await save.mutateAsync({
                id: team?.id,
                body: {
                  name: v.name,
                  description: v.description || null,
                  locationId: v.locationId || null,
                  departmentId: v.departmentId || null,
                  managerIds: v.managerIds,
                },
              });
              toast.success(team ? 'Team updated' : `${saved.name} created`);
              onOpenChange(false);
              onSaved?.(saved);
            } catch (err) {
              setFormError(
                applyServerErrors(err, setError, [
                  'name',
                  'description',
                  'locationId',
                  'departmentId',
                  'managerIds',
                ]),
              );
            }
          })}
        >
          <Field label="Name" required error={formState.errors.name?.message}>
            <Input autoFocus {...register('name')} />
          </Field>
          <Field label="Description" optional>
            <Textarea rows={2} {...register('description')} />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Location" optional error={formState.errors.locationId?.message}>
              <Select {...register('locationId')}>
                <option value="">No location</option>
                {locations.data?.items.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Department" optional error={formState.errors.departmentId?.message}>
              <Select {...register('departmentId')}>
                <option value="">No department</option>
                {departments.data?.items.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <Field label="Managers" optional error={formState.errors.managerIds?.message}>
            <Controller
              control={control}
              name="managerIds"
              render={({ field }) => (
                <PeoplePicker
                  value={field.value}
                  onChange={field.onChange}
                  initial={team?.managers ?? []}
                  max={10}
                />
              )}
            />
          </Field>
          {formError && (
            <p role="alert" className="rounded bg-danger-soft px-3 py-2 text-sm text-danger">
              {formError}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" variant="primary" loading={formState.isSubmitting}>
              {team ? 'Save' : 'Create team'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </DialogRoot>
  );
}
