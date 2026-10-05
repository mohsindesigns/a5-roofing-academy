import { useMemo, useState } from 'react';
import { useQueries } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { certification as c } from '@a5/contracts';
import {
  Button,
  DialogContent,
  DialogRoot,
  EmptyState,
  ErrorState,
  Field,
  FieldGroup,
  Input,
  Notice,
  PageHeader,
  Panel,
  Section,
  Select,
  Skeleton,
  StatusText,
  Switch,
  Table,
  TBody,
  Td,
  Th,
  THead,
  Tr,
  toast,
} from '@/components/ui';
import { RequirePermission } from '@/app/guards';
import { usePermissions } from '@/features/auth/session';
import { api } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';
import { applyServerErrors } from '@/lib/forms';
import { formatDateTime } from '@/lib/format';
import {
  certKeys,
  useCertificationSettings,
  useDefinitionOptions,
  useSaveCertificationSettings,
  useUpdateDefinition,
} from '../api';
import { organizationToken } from '../definition-form';
import type { CertificationDetail, CertificationSettings } from '../types';

// ------------------------------------------------------------------ organization-wide settings

const NAME_DISPLAY: Array<{
  value: 'full_name' | 'first_name_last_initial';
  label: string;
  example: string;
}> = [
  { value: 'full_name', label: 'Full name', example: 'Jordan Ellis' },
  { value: 'first_name_last_initial', label: 'First name and last initial', example: 'Jordan E.' },
];

const settingsSchema = z.object({
  organizationCode: z
    .string()
    .trim()
    .refine((v) => v === '' || /^[A-Za-z0-9]{1,10}$/.test(v), 'Use 1 to 10 letters or digits'),
  verificationBaseUrl: z
    .string()
    .trim()
    .refine(
      (v) => v === '' || /^https?:\/\/\S+$/.test(v),
      'Use a full web address starting with http:// or https://',
    ),
  recipientNameDisplay: z.enum(['full_name', 'first_name_last_initial']),
  showCertificateNumber: z.boolean(),
  showExpirationDate: z.boolean(),
  timezone: z.string().min(1),
});
type SettingsValues = z.infer<typeof settingsSchema>;

function timeZones(current: string): string[] {
  let zones: string[];
  try {
    zones = Intl.supportedValuesOf('timeZone');
  } catch {
    zones = [
      'America/Chicago',
      'America/New_York',
      'America/Denver',
      'America/Phoenix',
      'America/Los_Angeles',
      'UTC',
    ];
  }
  return zones.includes(current) ? zones : [current, ...zones];
}

function toValues(s: CertificationSettings): SettingsValues {
  return {
    organizationCode: s.organizationCode ?? '',
    verificationBaseUrl: s.verificationBaseUrl ?? '',
    recipientNameDisplay: s.recipientNameDisplay,
    showCertificateNumber: s.showCertificateNumber,
    showExpirationDate: s.showExpirationDate,
    timezone: s.timezone,
  };
}

function OrganizationSettings({
  settings,
  canEdit,
}: {
  settings: CertificationSettings;
  canEdit: boolean;
}) {
  const save = useSaveCertificationSettings();
  const [formError, setFormError] = useState<string | null>(null);
  const { register, handleSubmit, setError, setValue, watch, formState } = useForm<SettingsValues>({
    resolver: zodResolver(settingsSchema),
    values: toValues(settings),
  });
  const zones = useMemo(() => timeZones(settings.timezone), [settings.timezone]);
  const display = watch('recipientNameDisplay');
  const showNumber = watch('showCertificateNumber');
  const showExpiry = watch('showExpirationDate');
  const baseUrl =
    watch('verificationBaseUrl').trim().replace(/\/+$/, '') ||
    settings.effectiveVerificationBaseUrl;

  return (
    <Panel className="max-w-[760px]">
      <form
        noValidate
        className="grid gap-8"
        onSubmit={handleSubmit(async (v) => {
          setFormError(null);
          try {
            await save.mutateAsync({
              organizationCode: v.organizationCode.trim()
                ? v.organizationCode.trim().toUpperCase()
                : null,
              verificationBaseUrl: v.verificationBaseUrl.trim() || null,
              recipientNameDisplay: v.recipientNameDisplay,
              showCertificateNumber: v.showCertificateNumber,
              showExpirationDate: v.showExpirationDate,
              timezone: v.timezone,
            });
            toast.success('Certification settings saved');
          } catch (err) {
            setFormError(
              applyServerErrors(err, setError, [
                'organizationCode',
                'verificationBaseUrl',
                'recipientNameDisplay',
                'timezone',
              ]),
            );
          }
        })}
      >
        <fieldset disabled={!canEdit} className="grid gap-8">
          <FieldGroup title="Numbering and links">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field
                label="Organization code"
                optional
                error={formState.errors.organizationCode?.message}
                hint="The {ORG} part of certificate numbers. Blank uses the first word of each certification's issuing organization."
              >
                <Input
                  className="font-mono uppercase"
                  maxLength={10}
                  {...register('organizationCode')}
                />
              </Field>
              <Field
                label="Verification address"
                optional
                error={formState.errors.verificationBaseUrl?.message}
                hint={`Printed on certificates and encoded in QR codes: ${baseUrl}/verify/…`}
              >
                <Input
                  type="url"
                  placeholder={settings.effectiveVerificationBaseUrl}
                  {...register('verificationBaseUrl')}
                />
              </Field>
            </div>
          </FieldGroup>

          <FieldGroup
            title="Public verification page"
            description="What anyone with a certificate's link or QR code can see. Contact details, scores and training records are never shown."
          >
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Holder's name" error={formState.errors.recipientNameDisplay?.message}>
                <Select {...register('recipientNameDisplay')}>
                  {NAME_DISPLAY.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label} ({o.example})
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Time zone" hint="Dates printed on certificates use this zone.">
                <Select {...register('timezone')}>
                  {zones.map((z) => (
                    <option key={z} value={z}>
                      {z.replace(/_/g, ' ')}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            <div className="grid gap-3">
              <div className="flex items-center gap-3">
                <Switch
                  id="show-number"
                  aria-labelledby="show-number-label"
                  checked={showNumber}
                  onCheckedChange={(v) =>
                    setValue('showCertificateNumber', v, { shouldDirty: true })
                  }
                />
                <label id="show-number-label" htmlFor="show-number" className="text-sm font-medium">
                  Show the certificate number
                </label>
              </div>
              <div className="flex items-center gap-3">
                <Switch
                  id="show-expiry"
                  aria-labelledby="show-expiry-label"
                  checked={showExpiry}
                  onCheckedChange={(v) => setValue('showExpirationDate', v, { shouldDirty: true })}
                />
                <label id="show-expiry-label" htmlFor="show-expiry" className="text-sm font-medium">
                  Show the expiration date
                </label>
              </div>
            </div>
            <p className="text-sm text-text-secondary">
              The holder appears as{' '}
              <strong className="font-semibold text-text-primary">
                {NAME_DISPLAY.find((o) => o.value === display)?.example}
              </strong>
              .
            </p>
          </FieldGroup>
        </fieldset>
        {formError && (
          <p role="alert" className="rounded bg-danger-soft px-3 py-2 text-sm text-danger">
            {formError}
          </p>
        )}
        {canEdit ? (
          <div className="flex items-center gap-3">
            <Button
              type="submit"
              variant="primary"
              loading={save.isPending}
              disabled={!formState.isDirty}
            >
              Save settings
            </Button>
            {settings.updatedAt && (
              <span className="text-sm text-text-tertiary">
                Last saved {formatDateTime(settings.updatedAt)}
              </span>
            )}
          </div>
        ) : (
          <Notice tone="information">
            Changing these settings needs permission to update organization settings.
          </Notice>
        )}
      </form>
    </Panel>
  );
}

// ------------------------------------------------------------------ numbering per certification

function PatternDialog({
  definition,
  organizationCode,
  open,
  onOpenChange,
}: {
  definition: CertificationDetail;
  organizationCode: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const update = useUpdateDefinition(definition.id);
  const [pattern, setPattern] = useState(definition.numberPattern);
  const [error, setError] = useState<string | null>(null);
  const trimmed = pattern.trim();
  const problems = c.numberPatternProblems(trimmed);
  const example =
    problems.length === 0
      ? c.formatCertificateNumber(trimmed, {
          org: organizationToken(organizationCode, definition.issuingOrganizationName),
          code: definition.code,
          issuedAt: new Date(),
          seq: 1,
        })
      : null;
  return (
    <DialogRoot open={open} onOpenChange={onOpenChange}>
      <DialogContent
        size="sm"
        title={`Numbering for ${definition.name}`}
        description="Applies to certificates issued from now on. Existing numbers never change and sequence numbers are never reused."
        dismissible={!update.isPending}
        footer={
          <>
            <Button onClick={() => onOpenChange(false)} disabled={update.isPending}>
              Cancel
            </Button>
            <Button
              variant="primary"
              loading={update.isPending}
              disabled={problems.length > 0 || trimmed === definition.numberPattern}
              onClick={() => {
                setError(null);
                update.mutate(
                  { numberPattern: trimmed },
                  {
                    onSuccess: () => {
                      toast.success('Numbering saved');
                      onOpenChange(false);
                    },
                    onError: (err) => setError(errorMessage(err)),
                  },
                );
              }}
            >
              Save pattern
            </Button>
          </>
        }
      >
        <div className="grid gap-4">
          <Field
            label="Number pattern"
            required
            error={pattern && problems[0] ? problems[0] : undefined}
          >
            <Input
              className="font-mono"
              autoFocus
              maxLength={80}
              value={pattern}
              onChange={(e) => setPattern(e.target.value)}
            />
          </Field>
          <dl className="grid gap-2 text-sm">
            <div>
              <dt className="text-xs font-medium text-text-tertiary">Example</dt>
              <dd className="font-mono">{example ?? '—'}</dd>
            </div>
            <div>
              <dt className="text-xs font-medium text-text-tertiary">Pieces</dt>
              <dd className="text-text-secondary">
                {'{ORG}'} {'{CODE}'} {'{YYYY}'} {'{YY}'} {'{MM}'} {'{SEQ:6}'}. One {'{CODE}'} and
                one {'{SEQ:n}'} are required.
              </dd>
            </div>
          </dl>
          {error && (
            <p role="alert" className="rounded bg-danger-soft px-3 py-2 text-sm text-danger">
              {error}
            </p>
          )}
        </div>
      </DialogContent>
    </DialogRoot>
  );
}

function NumberingTable({
  organizationCode,
  canEdit,
}: {
  organizationCode: string | null;
  canEdit: boolean;
}) {
  const list = useDefinitionOptions();
  const items = list.data?.items ?? [];
  const details = useQueries({
    queries: items.map((d) => ({
      queryKey: certKeys.definition(d.id),
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        api.get<CertificationDetail>(`/certifications/${d.id}`, undefined, signal),
    })),
  });
  const [editing, setEditing] = useState<CertificationDetail | null>(null);

  if (list.isPending) return <Skeleton className="h-32 w-full" />;
  if (list.isError)
    return <ErrorState message={errorMessage(list.error)} onRetry={() => list.refetch()} />;
  if (items.length === 0) {
    return (
      <EmptyState
        title="No certifications yet"
        description="Each certification has its own numbering pattern."
      />
    );
  }
  return (
    <>
      <Table caption="Certificate numbering by certification">
        <THead>
          <tr>
            <Th>Certification</Th>
            <Th>Pattern</Th>
            <Th>Next number</Th>
            {canEdit && (
              <Th>
                <span className="sr-only">Actions</span>
              </Th>
            )}
          </tr>
        </THead>
        <TBody>
          {items.map((d, i) => {
            const detail = details[i]?.data;
            return (
              <Tr key={d.id}>
                <Td>
                  <span className="font-medium">{d.name}</span>
                  <span className="block font-mono text-xs text-text-tertiary">{d.code}</span>
                </Td>
                <Td className="font-mono text-sm">
                  {detail ? detail.numberPattern : <Skeleton className="h-4 w-40" />}
                </Td>
                <Td className="font-mono text-sm">
                  {detail ? detail.numberPreview : <Skeleton className="h-4 w-44" />}
                </Td>
                {canEdit && (
                  <Td className="text-right">
                    {detail && d.status !== 'archived' ? (
                      <Button size="sm" onClick={() => setEditing(detail)}>
                        Edit<span className="sr-only"> numbering for {d.name}</span>
                      </Button>
                    ) : (
                      d.status === 'archived' && <StatusText>Archived</StatusText>
                    )}
                  </Td>
                )}
              </Tr>
            );
          })}
        </TBody>
      </Table>
      {editing && (
        <PatternDialog
          key={editing.id}
          definition={editing}
          organizationCode={organizationCode}
          open
          onOpenChange={(open) => !open && setEditing(null)}
        />
      )}
    </>
  );
}

function Settings() {
  const permissions = usePermissions();
  const settings = useCertificationSettings();
  return (
    <>
      <PageHeader
        title="Numbering and settings"
        description="How certificate numbers are built and what the public verification page shows."
      />
      {settings.isPending ? (
        <Skeleton className="h-64 w-full" />
      ) : settings.isError ? (
        <ErrorState message={errorMessage(settings.error)} onRetry={() => settings.refetch()} />
      ) : (
        <>
          <Section title="Organization settings" id="org-settings">
            <OrganizationSettings
              settings={settings.data}
              canEdit={permissions.has('settings.update')}
            />
          </Section>
          {permissions.has('certifications.view') && (
            <Section
              title="Numbering by certification"
              id="numbering"
              description="Each certification counts up on its own. The code and sequence keep numbers unique."
            >
              <NumberingTable
                organizationCode={settings.data.organizationCode}
                canEdit={permissions.has('certifications.update')}
              />
            </Section>
          )}
        </>
      )}
    </>
  );
}

export function SettingsPage() {
  return (
    <RequirePermission any={['certifications.view', 'settings.view']}>
      <Settings />
    </RequirePermission>
  );
}
