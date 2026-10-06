import { useState } from 'react';
import {
  Controller,
  useForm,
  type FieldErrors,
  type FieldValues,
  type Path,
  type UseFormReturn,
} from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { certification as c } from '@a5/contracts';
import {
  Button,
  Field,
  Input,
  MultiSelect,
  Notice,
  Select,
  SheetContent,
  Skeleton,
  Switch,
  DialogRoot,
  toast,
} from '@/components/ui';
import { PeoplePicker } from '@/features/people/people-picker';
import { errorMessage } from '@/lib/api/errors';
import { applyServerErrors } from '@/lib/forms';
import { formatDate, formatDateTime } from '@/lib/format';
import {
  useDefinitionOptions,
  useSaveSignatory,
  useSaveStamp,
  useSignatures,
  useUploadSignature,
  useUploadStampImage,
} from '../api';
import { ImageUploader } from '../image-upload';
import type { Signatory, Stamp } from '../types';

const dateRule = (v: { effectiveFrom: string; effectiveTo: string }) =>
  !v.effectiveFrom || !v.effectiveTo || v.effectiveFrom <= v.effectiveTo;
const dateMessage = {
  path: ['effectiveTo'],
  message: 'The end date must be on or after the start date',
};

const signatorySchema = z
  .object({
    name: z.string().trim().min(1, 'Required').max(120),
    title: z.string().trim().min(1, 'Required').max(120),
    department: z.string().trim().max(120),
    active: z.boolean(),
    effectiveFrom: z.string(),
    effectiveTo: z.string(),
    allowedCertificationIds: z.array(z.string()),
    userIds: z.array(z.string()).max(1),
  })
  .refine(dateRule, dateMessage);
type SignatoryValues = z.infer<typeof signatorySchema>;

const stampSchema = z
  .object({
    name: z.string().trim().min(1, 'Required').max(120),
    kind: c.stampKindSchema,
    departmentName: z.string().trim().max(120),
    active: z.boolean(),
    effectiveFrom: z.string(),
    effectiveTo: z.string(),
    allowedCertificationIds: z.array(z.string()),
  })
  .refine(dateRule, dateMessage);
type StampValues = z.infer<typeof stampSchema>;

const STAMP_KIND_LABEL: Record<z.infer<typeof c.stampKindSchema>, string> = {
  company: 'Company seal',
  certification: 'Certification seal',
  department: 'Department seal',
};
export { STAMP_KIND_LABEL };

interface UsageValues {
  active: boolean;
  effectiveFrom: string;
  effectiveTo: string;
  allowedCertificationIds: string[];
}

/** Date range during which an item may be used, and the certifications allowed to use it. */
function UsageFields<T extends FieldValues & UsageValues>({
  form,
  noun,
  plural,
}: {
  form: UseFormReturn<T>;
  noun: string;
  plural: string;
}) {
  const definitions = useDefinitionOptions();
  const options = (definitions.data?.items ?? []).map((d) => ({ value: d.id, label: d.name }));
  const { register, control } = form;
  const errors = form.formState.errors as FieldErrors<UsageValues>;
  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Usable from" optional error={errors.effectiveFrom?.message}>
          <Input type="date" {...register('effectiveFrom' as Path<T>)} />
        </Field>
        <Field label="Usable until" optional error={errors.effectiveTo?.message}>
          <Input type="date" {...register('effectiveTo' as Path<T>)} />
        </Field>
      </div>
      <Controller
        control={control}
        name={'allowedCertificationIds' as Path<T>}
        render={({ field }) => (
          <Field
            label="Allowed certifications"
            optional
            hint={`Leave empty to let every certification use this ${noun}.`}
            error={errors.allowedCertificationIds?.message}
          >
            <MultiSelect
              options={options}
              value={field.value as string[]}
              onChange={field.onChange}
              loading={definitions.isPending}
              placeholder="Search certifications"
            />
          </Field>
        )}
      />
      <Controller
        control={control}
        name={'active' as Path<T>}
        render={({ field }) => (
          <div className="flex items-start gap-3">
            <Switch
              id={`${noun}-active`}
              aria-labelledby={`${noun}-active-label`}
              checked={field.value as boolean}
              onCheckedChange={field.onChange}
            />
            <div>
              <label
                id={`${noun}-active-label`}
                htmlFor={`${noun}-active`}
                className="text-sm font-medium"
              >
                Active
              </label>
              <p className="text-xs text-text-secondary">
                Inactive {plural} cannot be chosen for new certificates. Issued certificates are not
                affected.
              </p>
            </div>
          </div>
        )}
      />
    </>
  );
}

// ------------------------------------------------------------------ signatory

function SignatureHistory({ id }: { id: string }) {
  const versions = useSignatures(id, true);
  if (versions.isPending) return <Skeleton className="h-16 w-full" />;
  if (versions.isError) {
    return (
      <p role="alert" className="text-sm text-danger">
        {errorMessage(versions.error)}
      </p>
    );
  }
  if (versions.data.items.length === 0)
    return <p className="text-sm text-text-secondary">No signature uploaded yet.</p>;
  return (
    <ol className="divide-y divide-divider rounded-lg border border-border bg-surface">
      {versions.data.items.map((v, i) => (
        <li key={v.id} className="flex items-center gap-3 px-3 py-2">
          {v.previewUrl && (
            <img
              src={v.previewUrl}
              alt={`Signature version ${v.version}`}
              className="h-9 w-20 shrink-0 rounded border border-border bg-white object-contain"
            />
          )}
          <div className="min-w-0 text-sm">
            <p className="font-medium">
              Version {v.version}
              {i === 0 && <span className="ml-2 text-xs font-normal text-success">Current</span>}
            </p>
            <p className="text-xs text-text-secondary">
              {v.width} × {v.height} px · {formatDateTime(v.uploadedAt)}
              {v.uploadedBy ? ` · ${v.uploadedBy.displayName}` : ''}
            </p>
          </div>
        </li>
      ))}
    </ol>
  );
}

export function SignatorySheet({
  signatory,
  open,
  onOpenChange,
}: {
  signatory: Signatory | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  // After creating, the sheet carries on with the saved record so a signature can be uploaded.
  const [saved, setSaved] = useState<Signatory | null>(signatory);
  const save = useSaveSignatory(saved?.id ?? null);
  const upload = useUploadSignature(saved?.id ?? '');
  const [formError, setFormError] = useState<string | null>(null);
  const form = useForm<SignatoryValues>({
    resolver: zodResolver(signatorySchema),
    defaultValues: {
      name: signatory?.name ?? '',
      title: signatory?.title ?? '',
      department: signatory?.department ?? '',
      active: signatory?.active ?? true,
      effectiveFrom: signatory?.effectiveFrom ?? '',
      effectiveTo: signatory?.effectiveTo ?? '',
      allowedCertificationIds: signatory?.allowedCertificationIds ?? [],
      userIds: signatory?.userId ? [signatory.userId] : [],
    },
  });
  const { register, handleSubmit, setError, control, formState } = form;

  return (
    <DialogRoot open={open} onOpenChange={onOpenChange}>
      <SheetContent
        title={saved ? saved.name : 'New signatory'}
        description="People whose name, title and signature can appear on certificates."
        footer={
          <>
            <Button onClick={() => onOpenChange(false)}>{saved ? 'Close' : 'Cancel'}</Button>
            <Button type="submit" form="signatory-form" variant="primary" loading={save.isPending}>
              {saved ? 'Save changes' : 'Create signatory'}
            </Button>
          </>
        }
      >
        <form
          id="signatory-form"
          noValidate
          className="grid gap-4"
          onSubmit={handleSubmit(async (v) => {
            setFormError(null);
            try {
              const result = await save.mutateAsync({
                name: v.name,
                title: v.title,
                department: v.department || null,
                userId: v.userIds[0] ?? null,
                active: v.active,
                effectiveFrom: v.effectiveFrom || null,
                effectiveTo: v.effectiveTo || null,
                allowedCertificationIds: v.allowedCertificationIds,
              });
              toast.success(saved ? 'Signatory saved' : `${result.name} added`);
              setSaved(result);
            } catch (err) {
              setFormError(
                applyServerErrors(err, setError, [
                  'name',
                  'title',
                  'department',
                  'effectiveFrom',
                  'effectiveTo',
                  'allowedCertificationIds',
                ]),
              );
            }
          })}
        >
          <Field label="Name" required error={formState.errors.name?.message}>
            <Input autoFocus={!saved} {...register('name')} />
          </Field>
          <Field
            label="Title"
            required
            error={formState.errors.title?.message}
            hint="Printed under the signature, for example Director of Sales Enablement."
          >
            <Input {...register('title')} />
          </Field>
          <Field label="Department" optional error={formState.errors.department?.message}>
            <Input {...register('department')} />
          </Field>
          <Controller
            control={control}
            name="userIds"
            render={({ field }) => (
              <Field
                label="Linked person"
                optional
                hint="The academy account this signatory belongs to."
              >
                <PeoplePicker
                  value={field.value}
                  onChange={field.onChange}
                  max={1}
                  initial={
                    signatory?.userId ? [{ id: signatory.userId, displayName: signatory.name }] : []
                  }
                />
              </Field>
            )}
          />
          <UsageFields form={form} noun="signatory" plural="signatories" />
          {formError && (
            <p role="alert" className="rounded bg-danger-soft px-3 py-2 text-sm text-danger">
              {formError}
            </p>
          )}
        </form>

        <div className="mt-8 border-t border-divider pt-5">
          <h3 className="text-sm font-semibold">Signature image</h3>
          {saved ? (
            <div className="mt-3 grid gap-4">
              <ImageUploader
                purpose="signature"
                label="signature"
                currentUrl={saved.currentSignature?.previewUrl ?? null}
                currentAlt={`${saved.name}'s signature`}
                uploadLabel="Upload signature"
                onUpload={async (file) => {
                  const updated = await upload.mutateAsync(file);
                  setSaved(updated);
                  toast.success('Signature uploaded');
                }}
              />
              <Notice tone="information">
                A new signature applies to certificates issued from now on. Certificates already
                issued keep the signature they were issued with.
              </Notice>
              <SignatureHistory id={saved.id} />
            </div>
          ) : (
            <p className="mt-2 text-sm text-text-secondary">
              Create the signatory first, then upload a signature.
            </p>
          )}
        </div>
      </SheetContent>
    </DialogRoot>
  );
}

// ------------------------------------------------------------------ stamp

export function StampSheet({
  stamp,
  open,
  onOpenChange,
}: {
  stamp: Stamp | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [saved, setSaved] = useState<Stamp | null>(stamp);
  const save = useSaveStamp(saved?.id ?? null);
  const upload = useUploadStampImage(saved?.id ?? '');
  const [formError, setFormError] = useState<string | null>(null);
  const form = useForm<StampValues>({
    resolver: zodResolver(stampSchema),
    defaultValues: {
      name: stamp?.name ?? '',
      kind: stamp?.kind ?? 'company',
      departmentName: stamp?.departmentName ?? '',
      active: stamp?.active ?? true,
      effectiveFrom: stamp?.effectiveFrom ?? '',
      effectiveTo: stamp?.effectiveTo ?? '',
      allowedCertificationIds: stamp?.allowedCertificationIds ?? [],
    },
  });
  const { register, handleSubmit, setError, formState, watch } = form;
  const kind = watch('kind');

  return (
    <DialogRoot open={open} onOpenChange={onOpenChange}>
      <SheetContent
        title={saved ? saved.name : 'New stamp'}
        description="Company seals and department stamps printed on certificates."
        footer={
          <>
            <Button onClick={() => onOpenChange(false)}>{saved ? 'Close' : 'Cancel'}</Button>
            <Button type="submit" form="stamp-form" variant="primary" loading={save.isPending}>
              {saved ? 'Save changes' : 'Create stamp'}
            </Button>
          </>
        }
      >
        <form
          id="stamp-form"
          noValidate
          className="grid gap-4"
          onSubmit={handleSubmit(async (v) => {
            setFormError(null);
            try {
              const result = await save.mutateAsync({
                name: v.name,
                kind: v.kind,
                departmentName: v.kind === 'department' ? v.departmentName || null : null,
                active: v.active,
                effectiveFrom: v.effectiveFrom || null,
                effectiveTo: v.effectiveTo || null,
                allowedCertificationIds: v.allowedCertificationIds,
              });
              toast.success(saved ? 'Stamp saved' : `${result.name} added`);
              setSaved(result);
            } catch (err) {
              setFormError(
                applyServerErrors(err, setError, [
                  'name',
                  'kind',
                  'departmentName',
                  'effectiveFrom',
                  'effectiveTo',
                  'allowedCertificationIds',
                ]),
              );
            }
          })}
        >
          <Field label="Name" required error={formState.errors.name?.message}>
            <Input autoFocus={!saved} {...register('name')} />
          </Field>
          <Field label="Kind" error={formState.errors.kind?.message}>
            <Select {...register('kind')}>
              {c.stampKindSchema.options.map((k) => (
                <option key={k} value={k}>
                  {STAMP_KIND_LABEL[k]}
                </option>
              ))}
            </Select>
          </Field>
          {kind === 'department' && (
            <Field label="Department" error={formState.errors.departmentName?.message}>
              <Input {...register('departmentName')} />
            </Field>
          )}
          <UsageFields form={form} noun="stamp" plural="stamps" />
          {formError && (
            <p role="alert" className="rounded bg-danger-soft px-3 py-2 text-sm text-danger">
              {formError}
            </p>
          )}
        </form>

        <div className="mt-8 border-t border-divider pt-5">
          <h3 className="text-sm font-semibold">Stamp image</h3>
          {saved ? (
            <div className="mt-3 grid gap-4">
              <ImageUploader
                purpose="stamp"
                label="stamp"
                currentUrl={saved.currentImage?.previewUrl ?? null}
                currentAlt={`${saved.name} stamp`}
                uploadLabel="Upload stamp"
                onUpload={async (file) => {
                  const updated = await upload.mutateAsync(file);
                  setSaved(updated);
                  toast.success('Stamp image uploaded');
                }}
              />
              {saved.currentImage && (
                <p className="text-xs text-text-secondary">
                  Version {saved.currentImage.version} · {saved.currentImage.width} ×{' '}
                  {saved.currentImage.height} px · uploaded{' '}
                  {formatDate(saved.currentImage.uploadedAt)}
                </p>
              )}
              <Notice tone="information">
                A new image applies to certificates issued from now on. Certificates already issued
                keep the stamp they were issued with.
              </Notice>
            </div>
          ) : (
            <p className="mt-2 text-sm text-text-secondary">
              Create the stamp first, then upload its image.
            </p>
          )}
        </div>
      </SheetContent>
    </DialogRoot>
  );
}
