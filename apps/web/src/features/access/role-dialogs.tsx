import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useForm } from 'react-hook-form';
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
import { applyServerErrors } from '@/lib/forms';
import { useCreateRole, useUpdateRole } from './api';
import { SCOPE_LABELS } from './scope';

const schema = z.object({
  name: z.string().trim().min(1, 'Required').max(80),
  description: z.string().trim().max(500),
  dataScope: z.enum(['own', 'managed', 'organization']),
  cloneFromRoleId: z.string(),
});
type Values = z.infer<typeof schema>;

/** Create a custom role, optionally cloned from an existing one. */
export function CreateRoleDialog({
  open,
  onOpenChange,
  roles,
  cloneFrom,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  roles: identity.RoleSummary[];
  cloneFrom?: string;
}) {
  const navigate = useNavigate();
  const create = useCreateRole();
  const [formError, setFormError] = useState<string | null>(null);
  const source = roles.find((r) => r.id === cloneFrom);
  const { register, handleSubmit, setError, formState, reset } = useForm<Values>({
    resolver: zodResolver(schema),
    values: {
      name: source ? `${source.name} (copy)` : '',
      description: '',
      dataScope: source && source.dataScope !== 'platform' ? source.dataScope : 'own',
      cloneFromRoleId: cloneFrom ?? '',
    },
  });
  return (
    <DialogRoot
      open={open}
      onOpenChange={(o) => {
        if (!o) {
          reset();
          setFormError(null);
        }
        onOpenChange(o);
      }}
    >
      <DialogContent
        title={source ? `Clone ${source.name}` : 'New custom role'}
        description="Custom roles combine any permissions you hold yourself."
      >
        <form
          id="create-role"
          className="grid gap-4"
          onSubmit={handleSubmit(async (v) => {
            setFormError(null);
            try {
              const role = await create.mutateAsync({
                name: v.name,
                description: v.description || null,
                dataScope: v.dataScope,
                cloneFromRoleId: v.cloneFromRoleId || undefined,
              });
              toast.success(`${role.name} created`);
              onOpenChange(false);
              navigate(`/admin/roles/${role.id}`);
            } catch (err) {
              setFormError(applyServerErrors(err, setError, ['name', 'description', 'dataScope']));
            }
          })}
        >
          <Field label="Name" required error={formState.errors.name?.message}>
            <Input autoFocus {...register('name')} />
          </Field>
          <Field label="Description" optional error={formState.errors.description?.message}>
            <Textarea rows={2} {...register('description')} />
          </Field>
          <Field label="Data scope" hint="Whose records the role's permissions apply to.">
            <Select {...register('dataScope')}>
              {(['own', 'managed', 'organization'] as const).map((s) => (
                <option key={s} value={s}>
                  {SCOPE_LABELS[s].label} — {SCOPE_LABELS[s].description}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Start from" optional>
            <Select {...register('cloneFromRoleId')}>
              <option value="">No permissions (empty role)</option>
              {roles.map((r) => (
                <option key={r.id} value={r.id}>
                  Copy of {r.name}
                </option>
              ))}
            </Select>
          </Field>
          {formError && (
            <p role="alert" className="rounded bg-danger-soft px-3 py-2 text-sm text-danger">
              {formError}
            </p>
          )}
        </form>
        <div className="mt-5 flex justify-end gap-2">
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            type="submit"
            form="create-role"
            variant="primary"
            loading={formState.isSubmitting}
          >
            Create role
          </Button>
        </div>
      </DialogContent>
    </DialogRoot>
  );
}

const editSchema = schema.omit({ cloneFromRoleId: true });

export function EditRoleDialog({
  role,
  open,
  onOpenChange,
}: {
  role: identity.RoleDetail;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const update = useUpdateRole(role.id);
  const [formError, setFormError] = useState<string | null>(null);
  const { register, handleSubmit, setError, formState } = useForm<z.infer<typeof editSchema>>({
    resolver: zodResolver(editSchema),
    values: {
      name: role.name,
      description: role.description ?? '',
      dataScope: role.dataScope === 'platform' ? 'organization' : role.dataScope,
    },
  });
  return (
    <DialogRoot open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="Edit role"
        description="Changing the data scope applies to everyone with this role immediately."
      >
        <form
          className="grid gap-4"
          onSubmit={handleSubmit(async (v) => {
            setFormError(null);
            try {
              await update.mutateAsync({
                name: v.name,
                description: v.description || null,
                dataScope: v.dataScope,
              });
              toast.success('Role updated');
              onOpenChange(false);
            } catch (err) {
              setFormError(applyServerErrors(err, setError, ['name', 'description', 'dataScope']));
            }
          })}
        >
          <Field label="Name" required error={formState.errors.name?.message}>
            <Input {...register('name')} />
          </Field>
          <Field label="Description" optional>
            <Textarea rows={2} {...register('description')} />
          </Field>
          <Field label="Data scope">
            <Select {...register('dataScope')}>
              {(['own', 'managed', 'organization'] as const).map((s) => (
                <option key={s} value={s}>
                  {SCOPE_LABELS[s].label}
                </option>
              ))}
            </Select>
          </Field>
          {formError && (
            <p role="alert" className="rounded bg-danger-soft px-3 py-2 text-sm text-danger">
              {formError}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" variant="primary" loading={formState.isSubmitting}>
              Save
            </Button>
          </div>
        </form>
      </DialogContent>
    </DialogRoot>
  );
}
