import { Controller, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { type identity } from '@a5/contracts';
import {
  Button,
  Checkbox,
  Field,
  FieldGroup,
  Input,
  MultiSelect,
  Select,
  Switch,
} from '@/components/ui';
import { useRoles } from '@/features/access/api';
import { useDepartments, useLocations, useTeams } from '@/features/organization/api';
import { PeoplePicker } from './people-picker';

const formSchema = z.object({
  email: z.email('Enter a valid email address').trim(),
  firstName: z.string().trim().min(1, 'Required').max(80),
  lastName: z.string().trim().min(1, 'Required').max(80),
  employeeId: z.string().trim().max(40),
  jobTitle: z.string().trim().max(120),
  phone: z
    .string()
    .trim()
    .max(32)
    .regex(/^[+0-9 ().-]*$/, 'Use digits, spaces and + ( ) - only'),
  hiredAt: z.string(),
  locationId: z.string(),
  departmentId: z.string(),
  teamIds: z.array(z.string()),
  managerIds: z.array(z.string()),
  trainerIds: z.array(z.string()),
  roleIds: z.array(z.string()),
  sendInvitation: z.boolean(),
});

export type PersonFormValues = z.infer<typeof formSchema>;

export function toRequest(v: PersonFormValues) {
  const blank = (s: string) => (s.trim() === '' ? null : s.trim());
  return {
    email: v.email,
    firstName: v.firstName,
    lastName: v.lastName,
    employeeId: blank(v.employeeId),
    jobTitle: blank(v.jobTitle),
    phone: blank(v.phone),
    hiredAt: blank(v.hiredAt),
    locationId: blank(v.locationId),
    departmentId: blank(v.departmentId),
    teamIds: v.teamIds,
    managerIds: v.managerIds,
    trainerIds: v.trainerIds,
  };
}

export function emptyPerson(): PersonFormValues {
  return {
    email: '',
    firstName: '',
    lastName: '',
    employeeId: '',
    jobTitle: 'Sales Representative',
    phone: '',
    hiredAt: '',
    locationId: '',
    departmentId: '',
    teamIds: [],
    managerIds: [],
    trainerIds: [],
    roleIds: [],
    sendInvitation: true,
  };
}

export function fromDetail(u: identity.UserDetail): PersonFormValues {
  return {
    email: u.email,
    firstName: u.firstName,
    lastName: u.lastName,
    employeeId: u.employeeId ?? '',
    jobTitle: u.jobTitle ?? '',
    phone: u.phone ?? '',
    hiredAt: u.hiredAt ?? '',
    locationId: u.location?.id ?? '',
    departmentId: u.department?.id ?? '',
    teamIds: u.teams.map((t) => t.id),
    managerIds: u.managers.map((m) => m.id),
    trainerIds: u.trainers.map((t) => t.id),
    roleIds: u.roles.map((r) => r.id),
    sendInvitation: false,
  };
}

interface PersonFormProps {
  mode: 'create' | 'edit';
  defaultValues: PersonFormValues;
  initialPeople?: Array<{ id: string; displayName: string }>;
  selfId?: string;
  submitLabel: string;
  onSubmit: (
    values: PersonFormValues,
    setError: ReturnType<typeof useForm<PersonFormValues>>['setError'],
  ) => Promise<void>;
  onCancel: () => void;
  formError?: string | null;
}

export function PersonForm({
  mode,
  defaultValues,
  initialPeople = [],
  selfId,
  submitLabel,
  onSubmit,
  onCancel,
  formError,
}: PersonFormProps) {
  const { register, control, handleSubmit, setError, formState } = useForm<PersonFormValues>({
    resolver: zodResolver(
      mode === 'create'
        ? formSchema.refine((v) => v.roleIds.length > 0, {
            path: ['roleIds'],
            message: 'Assign at least one role',
          })
        : formSchema,
    ),
    defaultValues,
  });
  const locations = useLocations();
  const departments = useDepartments();
  const teams = useTeams();
  const roles = useRoles();
  const errors = formState.errors;

  return (
    <form onSubmit={handleSubmit((v) => onSubmit(v, setError))} className="grid gap-8" noValidate>
      <FieldGroup title="Profile">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="First name" required error={errors.firstName?.message}>
            <Input autoComplete="off" {...register('firstName')} />
          </Field>
          <Field label="Last name" required error={errors.lastName?.message}>
            <Input autoComplete="off" {...register('lastName')} />
          </Field>
          <Field
            label="Work email"
            required
            error={errors.email?.message}
            hint={
              mode === 'create'
                ? 'The invitation is sent here and it becomes their sign-in.'
                : undefined
            }
          >
            <Input type="email" autoComplete="off" {...register('email')} />
          </Field>
          <Field label="Job title" optional error={errors.jobTitle?.message}>
            <Input {...register('jobTitle')} />
          </Field>
          <Field label="Employee ID" optional error={errors.employeeId?.message}>
            <Input className="font-mono" {...register('employeeId')} />
          </Field>
          <Field label="Mobile phone" optional error={errors.phone?.message}>
            <Input type="tel" inputMode="tel" {...register('phone')} />
          </Field>
          <Field label="Start date" optional error={errors.hiredAt?.message}>
            <Input type="date" {...register('hiredAt')} />
          </Field>
        </div>
      </FieldGroup>

      <FieldGroup
        title="Placement"
        description="Placement decides which managers and trainers can follow this person's training."
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Location" optional error={errors.locationId?.message}>
            <Select {...register('locationId')}>
              <option value="">No location</option>
              {locations.data?.items.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Department" optional error={errors.departmentId?.message}>
            <Select {...register('departmentId')}>
              <option value="">No department</option>
              {departments.data?.items.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Teams" optional error={errors.teamIds?.message} className="sm:col-span-2">
            <Controller
              control={control}
              name="teamIds"
              render={({ field }) => (
                <MultiSelect
                  options={(teams.data?.items ?? []).map((t) => ({
                    value: t.id,
                    label: t.name,
                    description: t.location?.name,
                  }))}
                  value={field.value}
                  onChange={field.onChange}
                  placeholder="Select teams"
                />
              )}
            />
          </Field>
          <Field
            label="Direct managers"
            optional
            error={errors.managerIds?.message}
            hint="In addition to the managers of their teams."
          >
            <Controller
              control={control}
              name="managerIds"
              render={({ field }) => (
                <PeoplePicker
                  value={field.value}
                  onChange={field.onChange}
                  initial={initialPeople}
                  excludeIds={selfId ? [selfId] : []}
                  max={10}
                />
              )}
            />
          </Field>
          <Field label="Assigned trainers" optional error={errors.trainerIds?.message}>
            <Controller
              control={control}
              name="trainerIds"
              render={({ field }) => (
                <PeoplePicker
                  value={field.value}
                  onChange={field.onChange}
                  initial={initialPeople}
                  excludeIds={selfId ? [selfId] : []}
                  max={10}
                />
              )}
            />
          </Field>
        </div>
      </FieldGroup>

      {mode === 'create' && (
        <FieldGroup title="Access">
          <Controller
            control={control}
            name="roleIds"
            render={({ field }) => (
              <div
                role="group"
                aria-label="Roles"
                className="grid gap-px overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-2"
              >
                {roles.data?.items.map((r) => {
                  const checked = field.value.includes(r.id);
                  return (
                    <label
                      key={r.id}
                      className="flex cursor-pointer items-start gap-3 bg-surface px-4 py-3 hover:bg-surface-hover"
                    >
                      <Checkbox
                        className="mt-0.5"
                        checked={checked}
                        onCheckedChange={(c) =>
                          field.onChange(
                            c ? [...field.value, r.id] : field.value.filter((x) => x !== r.id),
                          )
                        }
                      />
                      <span className="min-w-0">
                        <span className="block font-medium">{r.name}</span>
                        <span className="block text-sm text-text-secondary">{r.description}</span>
                      </span>
                    </label>
                  );
                })}
              </div>
            )}
          />
          {errors.roleIds?.message && (
            <p role="alert" className="-mt-2 text-xs font-medium text-danger">
              {errors.roleIds.message}
            </p>
          )}
          <Controller
            control={control}
            name="sendInvitation"
            render={({ field }) => (
              <label className="flex items-center gap-3">
                <Switch checked={field.value} onCheckedChange={field.onChange} />
                <span>
                  <span className="block font-medium">Send invitation now</span>
                  <span className="block text-sm text-text-secondary">
                    They receive an email with a link to set a password. The link expires in 72
                    hours.
                  </span>
                </span>
              </label>
            )}
          />
        </FieldGroup>
      )}

      {formError && (
        <p role="alert" className="rounded bg-danger-soft px-3 py-2 text-sm text-danger">
          {formError}
        </p>
      )}
      <div className="flex justify-end gap-2 border-t border-divider pt-5">
        <Button onClick={onCancel} disabled={formState.isSubmitting}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" loading={formState.isSubmitting}>
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}

// Keep the contract in sync with the form for create requests.
export type CreatePersonRequest = identity.CreateUserRequest;
