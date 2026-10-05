import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { Button, DialogContent, DialogRoot, Field, Input, Select, toast } from '@/components/ui';
import { applyServerErrors } from '@/lib/forms';
import { useSaveUnit } from './api';

const TIMEZONES = [
  'America/Chicago',
  'America/New_York',
  'America/Denver',
  'America/Phoenix',
  'America/Los_Angeles',
];

interface UnitValues {
  name: string;
  code: string;
  city: string;
  state: string;
  timezone: string;
}

export function UnitDialog({
  kind,
  unit,
  open,
  onOpenChange,
}: {
  kind: 'locations' | 'departments';
  unit?: {
    id: string;
    name: string;
    code: string | null;
    city?: string | null;
    state?: string | null;
    timezone?: string;
  };
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const save = useSaveUnit(kind);
  const [formError, setFormError] = useState<string | null>(null);
  const noun = kind === 'locations' ? 'location' : 'department';
  const { register, handleSubmit, setError, formState } = useForm<UnitValues>({
    values: {
      name: unit?.name ?? '',
      code: unit?.code ?? '',
      city: unit?.city ?? '',
      state: unit?.state ?? '',
      timezone: unit?.timezone ?? 'America/Chicago',
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
      <DialogContent title={unit ? `Edit ${unit.name}` : `New ${noun}`} size="sm">
        <form
          className="grid gap-4"
          onSubmit={handleSubmit(async (v) => {
            if (!v.name.trim()) {
              setError('name', { message: 'Required' });
              return;
            }
            setFormError(null);
            const body =
              kind === 'locations'
                ? {
                    name: v.name,
                    code: v.code || null,
                    city: v.city || null,
                    state: v.state || null,
                    timezone: v.timezone,
                  }
                : { name: v.name, code: v.code || null };
            try {
              await save.mutateAsync({ id: unit?.id, body });
              toast.success(unit ? `${v.name} updated` : `${v.name} added`);
              onOpenChange(false);
            } catch (err) {
              setFormError(
                applyServerErrors(err, setError, ['name', 'code', 'city', 'state', 'timezone']),
              );
            }
          })}
        >
          <Field label="Name" required error={formState.errors.name?.message}>
            <Input autoFocus {...register('name')} />
          </Field>
          <Field label="Code" optional hint="Short code used in reports, e.g. DAL.">
            <Input className="font-mono uppercase" maxLength={20} {...register('code')} />
          </Field>
          {kind === 'locations' && (
            <>
              <div className="grid grid-cols-[1fr_96px] gap-3">
                <Field label="City" optional>
                  <Input {...register('city')} />
                </Field>
                <Field label="State" optional>
                  <Input maxLength={60} {...register('state')} />
                </Field>
              </div>
              <Field label="Time zone">
                <Select {...register('timezone')}>
                  {TIMEZONES.map((tz) => (
                    <option key={tz} value={tz}>
                      {tz.replace('America/', '').replace('_', ' ')}
                    </option>
                  ))}
                </Select>
              </Field>
            </>
          )}
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
