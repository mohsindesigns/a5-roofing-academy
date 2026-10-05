import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { identity } from '@a5/contracts';
import {
  Button,
  ErrorState,
  Field,
  FieldGroup,
  Input,
  PageHeader,
  Panel,
  Select,
  Skeleton,
  Switch,
  TabsContent,
  TabsList,
  TabsRoot,
  toast,
} from '@/components/ui';
import { RequirePermission } from '@/app/guards';
import { usePermissions } from '@/features/auth/session';
import { errorMessage } from '@/lib/api/errors';
import { applyServerErrors } from '@/lib/forms';
import { formatDateTime } from '@/lib/format';
import {
  useFeatureFlags,
  useOrgSettings,
  useSaveOrgSettings,
  useSaveSecuritySettings,
  useSecuritySettings,
  useSetFeatureFlag,
} from './api';

const orgForm = z.object({
  name: z.string().trim().min(1, 'Required').max(160),
  legalName: z.string().trim().max(200),
  timezone: z.string().min(1),
  supportEmail: z.union([z.literal(''), z.email('Enter a valid email address')]),
  primaryColor: z.union([
    z.literal(''),
    z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Use a hex colour like #1F2A30'),
  ]),
  accentColor: z.union([
    z.literal(''),
    z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Use a hex colour like #A8582A'),
  ]),
});

function OrganizationSettings({ canEdit }: { canEdit: boolean }) {
  const settings = useOrgSettings();
  const save = useSaveOrgSettings();
  const [formError, setFormError] = useState<string | null>(null);
  const { register, handleSubmit, setError, formState } = useForm<z.infer<typeof orgForm>>({
    resolver: zodResolver(orgForm),
    values: settings.data && {
      name: settings.data.name,
      legalName: settings.data.legalName ?? '',
      timezone: settings.data.timezone,
      supportEmail: settings.data.supportEmail ?? '',
      primaryColor: settings.data.branding.primaryColor ?? '',
      accentColor: settings.data.branding.accentColor ?? '',
    },
  });
  if (settings.isPending) return <Skeleton className="h-64 w-full" />;
  if (settings.isError)
    return <ErrorState message={errorMessage(settings.error)} onRetry={() => settings.refetch()} />;
  return (
    <Panel className="max-w-[760px]">
      <form
        className="grid gap-8"
        onSubmit={handleSubmit(async (v) => {
          setFormError(null);
          try {
            await save.mutateAsync({
              name: v.name,
              legalName: v.legalName || null,
              timezone: v.timezone,
              supportEmail: v.supportEmail || null,
              branding: {
                primaryColor: v.primaryColor || null,
                accentColor: v.accentColor || null,
                logoUrl: settings.data.branding.logoUrl,
              },
            });
            toast.success('Organization settings saved');
          } catch (err) {
            setFormError(
              applyServerErrors(err, setError, ['name', 'legalName', 'timezone', 'supportEmail']),
            );
          }
        })}
      >
        <fieldset disabled={!canEdit} className="grid gap-8">
          <FieldGroup title="Profile">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Display name" required error={formState.errors.name?.message}>
                <Input {...register('name')} />
              </Field>
              <Field
                label="Legal name"
                optional
                hint="Printed on certificates as the issuing organization."
              >
                <Input {...register('legalName')} />
              </Field>
              <Field label="Time zone">
                <Select {...register('timezone')}>
                  {[
                    'America/Chicago',
                    'America/New_York',
                    'America/Denver',
                    'America/Phoenix',
                    'America/Los_Angeles',
                  ].map((tz) => (
                    <option key={tz} value={tz}>
                      {tz.replace('America/', '').replace('_', ' ')}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field
                label="Support email"
                optional
                error={formState.errors.supportEmail?.message}
                hint="Shown to learners who need help."
              >
                <Input type="email" {...register('supportEmail')} />
              </Field>
            </div>
          </FieldGroup>
          <FieldGroup
            title="Branding"
            description="Applied when official A5 brand assets are configured."
          >
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Primary colour" optional error={formState.errors.primaryColor?.message}>
                <Input className="font-mono" placeholder="#1F2A30" {...register('primaryColor')} />
              </Field>
              <Field label="Accent colour" optional error={formState.errors.accentColor?.message}>
                <Input className="font-mono" placeholder="#A8582A" {...register('accentColor')} />
              </Field>
            </div>
          </FieldGroup>
        </fieldset>
        {formError && (
          <p role="alert" className="rounded bg-danger-soft px-3 py-2 text-sm text-danger">
            {formError}
          </p>
        )}
        {canEdit && (
          <div className="flex justify-end border-t border-divider pt-5">
            <Button
              type="submit"
              variant="primary"
              loading={formState.isSubmitting}
              disabled={!formState.isDirty}
            >
              Save changes
            </Button>
          </div>
        )}
      </form>
    </Panel>
  );
}

function SecuritySettings({ canEdit }: { canEdit: boolean }) {
  const settings = useSecuritySettings();
  const save = useSaveSecuritySettings();
  const [formError, setFormError] = useState<string | null>(null);
  const { register, handleSubmit, setError, formState } = useForm<identity.SecuritySettings>({
    resolver: zodResolver(identity.securitySettingsSchema),
    values: settings.data,
  });
  if (settings.isPending) return <Skeleton className="h-64 w-full" />;
  if (settings.isError)
    return <ErrorState message={errorMessage(settings.error)} onRetry={() => settings.refetch()} />;
  const num = { valueAsNumber: true } as const;
  return (
    <Panel className="max-w-[760px]">
      <form
        className="grid gap-8"
        onSubmit={handleSubmit(async (v) => {
          setFormError(null);
          try {
            await save.mutateAsync(v);
            toast.success('Security policy saved');
          } catch (err) {
            setFormError(
              applyServerErrors(err, setError, [
                'passwordMinLength',
                'lockoutThreshold',
                'lockoutMinutes',
                'sessionIdleMinutes',
                'sessionMaxHours',
              ]),
            );
          }
        })}
      >
        <fieldset disabled={!canEdit} className="grid gap-8">
          <FieldGroup title="Passwords and lockout">
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="Minimum length" error={formState.errors.passwordMinLength?.message}>
                <Input type="number" min={8} max={64} {...register('passwordMinLength', num)} />
              </Field>
              <Field
                label="Failed attempts before lockout"
                error={formState.errors.lockoutThreshold?.message}
              >
                <Input type="number" min={3} max={20} {...register('lockoutThreshold', num)} />
              </Field>
              <Field
                label="Lockout duration (minutes)"
                error={formState.errors.lockoutMinutes?.message}
              >
                <Input type="number" min={1} {...register('lockoutMinutes', num)} />
              </Field>
            </div>
          </FieldGroup>
          <FieldGroup
            title="Sessions"
            description="Field representatives often stay signed in on their phones; balance convenience and risk."
          >
            <div className="grid gap-4 sm:grid-cols-2">
              <Field
                label="Sign out after inactivity (minutes)"
                error={formState.errors.sessionIdleMinutes?.message}
                hint="10080 = 7 days"
              >
                <Input type="number" min={5} {...register('sessionIdleMinutes', num)} />
              </Field>
              <Field
                label="Maximum session length (hours)"
                error={formState.errors.sessionMaxHours?.message}
                hint="720 = 30 days"
              >
                <Input type="number" min={1} {...register('sessionMaxHours', num)} />
              </Field>
            </div>
          </FieldGroup>
        </fieldset>
        {formError && (
          <p role="alert" className="rounded bg-danger-soft px-3 py-2 text-sm text-danger">
            {formError}
          </p>
        )}
        {canEdit && (
          <div className="flex justify-end border-t border-divider pt-5">
            <Button
              type="submit"
              variant="primary"
              loading={formState.isSubmitting}
              disabled={!formState.isDirty}
            >
              Save policy
            </Button>
          </div>
        )}
      </form>
    </Panel>
  );
}

function FeatureFlags({ canEdit }: { canEdit: boolean }) {
  const flags = useFeatureFlags();
  const setFlag = useSetFeatureFlag();
  if (flags.isPending) return <Skeleton className="h-64 w-full" />;
  if (flags.isError)
    return <ErrorState message={errorMessage(flags.error)} onRetry={() => flags.refetch()} />;
  return (
    <ul className="max-w-[760px] divide-y divide-divider rounded-lg border border-border bg-surface">
      {flags.data.items.map((f) => (
        <li key={f.key} className="flex items-start gap-4 px-5 py-4">
          <div className="min-w-0 flex-1">
            <p className="font-medium">{f.label}</p>
            <p className="text-sm text-text-secondary">{f.description}</p>
            {f.updatedAt && (
              <p className="mt-1 text-xs text-text-tertiary">
                Last changed {formatDateTime(f.updatedAt)}
              </p>
            )}
          </div>
          <Switch
            aria-label={f.label}
            checked={f.enabled}
            disabled={!canEdit}
            onCheckedChange={(enabled) =>
              setFlag.mutate(
                { key: f.key, enabled },
                {
                  onSuccess: () => toast.success(`${f.label} ${enabled ? 'enabled' : 'disabled'}`),
                  onError: (err) => toast.error('Change not saved', errorMessage(err)),
                },
              )
            }
          />
        </li>
      ))}
    </ul>
  );
}

function Settings() {
  const p = usePermissions();
  const [params, setParams] = useSearchParams();
  const tabs = [
    ...(p.hasAny(['settings.view', 'organization.update'])
      ? [{ value: 'organization', label: 'Organization' }]
      : []),
    ...(p.hasAny(['settings.view', 'security_settings.manage'])
      ? [{ value: 'security', label: 'Security' }]
      : []),
    { value: 'features', label: 'Feature flags' },
  ];
  const tab = params.get('tab') ?? tabs[0]!.value;
  return (
    <>
      <PageHeader
        title="Settings"
        description="Organization-wide configuration. Changes are recorded in the audit log."
      />
      <TabsRoot value={tab} onValueChange={(v) => setParams({ tab: v }, { replace: true })}>
        <TabsList className="mb-6" items={tabs} />
        <TabsContent value="organization">
          <OrganizationSettings canEdit={p.has('organization.update')} />
        </TabsContent>
        <TabsContent value="security">
          <SecuritySettings canEdit={p.has('security_settings.manage')} />
        </TabsContent>
        <TabsContent value="features">
          <FeatureFlags canEdit={p.has('feature_flags.manage')} />
        </TabsContent>
      </TabsRoot>
    </>
  );
}

export function SettingsPage() {
  return (
    <RequirePermission any={['settings.view', 'feature_flags.manage', 'security_settings.manage']}>
      <Settings />
    </RequirePermission>
  );
}
