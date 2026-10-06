import { useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import type { learning } from '@a5/contracts';
import { Button, DialogContent, DialogRoot, Field, Input, Select, toast } from '@/components/ui';
import { useProgramOptions } from '@/features/analytics/options';
import { PeoplePicker } from '@/features/people/people-picker';
import { applyServerErrors } from '@/lib/forms';
import { pluralize } from '@/lib/format';
import { endOfDayIso, useEnroll } from './api';

const schema = z.object({
  programId: z.string().min(1, 'Choose a program'),
  userIds: z.array(z.string()).min(1, 'Choose at least one person').max(500),
  dueDate: z.string(),
});
type Values = z.infer<typeof schema>;

/** Plain-language summary of a bulk enrollment result. */
export function describeEnrollResult(
  r: Pick<learning.BulkEnrollResult, 'created' | 'reactivated' | 'unchanged'>,
) {
  const parts: string[] = [];
  if (r.created) parts.push(`${pluralize(r.created, 'person', 'people')} enrolled`);
  if (r.reactivated) parts.push(`${r.reactivated} re-enrolled`);
  if (r.unchanged) parts.push(`${r.unchanged} already enrolled`);
  return parts.join(', ') || 'No changes';
}

/**
 * Assigns a published program to people in the caller's scope. The API is idempotent: people who
 * are already enrolled are reported as unchanged, withdrawn ones are re-enrolled.
 */
export function AssignDialog({
  open,
  onOpenChange,
  initialPeople,
  initialProgramId,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  initialPeople?: Array<{ id: string; displayName: string }>;
  initialProgramId?: string;
}) {
  const programs = useProgramOptions();
  const enroll = useEnroll();
  const [formError, setFormError] = useState<string | null>(null);
  const { register, control, handleSubmit, setError, reset, formState } = useForm<Values>({
    resolver: zodResolver(schema),
    values: {
      programId: initialProgramId ?? '',
      userIds: initialPeople?.map((p) => p.id) ?? [],
      dueDate: '',
    },
  });
  return (
    <DialogRoot
      open={open}
      onOpenChange={(o) => {
        setFormError(null);
        if (!o) reset();
        onOpenChange(o);
      }}
    >
      <DialogContent
        title="Assign a program"
        description="People see the program in their training as soon as you save. Without a due date, the program's default applies."
      >
        <form
          className="grid gap-4"
          onSubmit={handleSubmit(async (v) => {
            setFormError(null);
            try {
              const result = await enroll.mutateAsync({
                programId: v.programId,
                userIds: v.userIds,
                dueAt: v.dueDate ? endOfDayIso(v.dueDate) : undefined,
              });
              toast.success('Program assigned', describeEnrollResult(result));
              onOpenChange(false);
              reset();
            } catch (err) {
              setFormError(applyServerErrors(err, setError, ['programId', 'userIds', 'dueAt']));
            }
          })}
        >
          <Field label="Program" required error={formState.errors.programId?.message}>
            <Select {...register('programId')}>
              <option value="">Choose a program</option>
              {programs.data?.items.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.title}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="People" required error={formState.errors.userIds?.message}>
            <Controller
              control={control}
              name="userIds"
              render={({ field }) => (
                <PeoplePicker
                  value={field.value}
                  onChange={field.onChange}
                  initial={initialPeople}
                  max={500}
                  placeholder="Search people in your scope"
                />
              )}
            />
          </Field>
          <Field label="Due date" optional hint="Overrides the program's default due date.">
            <Input type="date" {...register('dueDate')} />
          </Field>
          {formError && (
            <p role="alert" className="rounded bg-danger-soft px-3 py-2 text-sm text-danger">
              {formError}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" variant="primary" loading={formState.isSubmitting}>
              Assign
            </Button>
          </div>
        </form>
      </DialogContent>
    </DialogRoot>
  );
}
