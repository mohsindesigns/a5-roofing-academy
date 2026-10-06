import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { certification } from '@a5/contracts';
import {
  Button,
  DialogContent,
  DialogRoot,
  Field,
  Input,
  Notice,
  Select,
  Textarea,
  toast,
} from '@/components/ui';
import { usePermissions } from '@/features/auth/session';
import { PeoplePicker } from '@/features/people/people-picker';
import { ApiError, errorMessage } from '@/lib/api/errors';
import { applyServerErrors } from '@/lib/forms';
import {
  useDefinitionOptions,
  useIssueCertificate,
  useReissueCertificate,
  useRevokeCertificate,
} from '../api';
import { REISSUE_REASONS } from '../labels';
import type { CertificateDetail, ReissueReason } from '../types';
import { CENTER_ROOT } from './nav';

// ------------------------------------------------------------------ revoke

export function revokeFormSchema(phrase: string) {
  return z.object({
    reason: z
      .string()
      .trim()
      .min(10, 'Explain why the certificate is revoked (at least 10 characters)')
      .max(1000, 'Keep the reason under 1,000 characters'),
    publicNote: z.string().trim().max(300, 'Keep the public note under 300 characters'),
    confirmation: z
      .string()
      .trim()
      .refine((v) => v.toUpperCase() === phrase.toUpperCase(), `Type ${phrase} exactly to confirm`),
  });
}

/**
 * Revoking is permanent: the reason is required and kept in the audit trail, the public note is
 * shown on the verification page, and the action needs a typed confirmation phrase.
 */
export function RevokeDialog({
  certificate,
  open,
  onOpenChange,
}: {
  certificate: Pick<CertificateDetail, 'id' | 'certificateNumber' | 'recipient'>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const phrase = certification.revocationPhrase(certificate.certificateNumber);
  const revoke = useRevokeCertificate(certificate.id);
  const [formError, setFormError] = useState<string | null>(null);
  const form = useForm({
    resolver: zodResolver(revokeFormSchema(phrase)),
    defaultValues: { reason: '', publicNote: '', confirmation: '' },
  });
  const { register, handleSubmit, setError, formState, reset } = form;

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
        title="Revoke certificate"
        description={`${certificate.certificateNumber} · ${certificate.recipient.displayName}`}
        dismissible={!revoke.isPending}
        footer={
          <>
            <Button onClick={() => onOpenChange(false)} disabled={revoke.isPending}>
              Cancel
            </Button>
            <Button type="submit" form="revoke-form" variant="danger" loading={revoke.isPending}>
              Revoke certificate
            </Button>
          </>
        }
      >
        <form
          id="revoke-form"
          className="grid gap-4"
          noValidate
          onSubmit={handleSubmit(async (v) => {
            setFormError(null);
            try {
              await revoke.mutateAsync({
                reason: v.reason,
                publicNote: v.publicNote || null,
                confirmation: v.confirmation,
              });
              toast.success(`${certificate.certificateNumber} was revoked`);
              reset();
              onOpenChange(false);
            } catch (err) {
              setFormError(
                applyServerErrors(err, setError, ['reason', 'publicNote', 'confirmation']),
              );
            }
          })}
        >
          <Notice tone="warning" title="This cannot be undone">
            The certificate stops being valid immediately, its verification page will say it was
            revoked, and the person is put on hold for this certification until an administrator
            reopens them.
          </Notice>
          <Field
            label="Reason"
            required
            hint="Recorded in the audit trail. Only administrators see it."
            error={formState.errors.reason?.message}
          >
            <Textarea rows={3} {...register('reason')} />
          </Field>
          <Field
            label="Public note"
            optional
            hint="Shown to anyone who checks this certificate. Do not include private details."
            error={formState.errors.publicNote?.message}
          >
            <Textarea rows={2} {...register('publicNote')} />
          </Field>
          <Field
            label={
              <>
                Type <span className="font-mono">{phrase}</span> to confirm
              </>
            }
            required
            error={formState.errors.confirmation?.message}
          >
            <Input
              autoComplete="off"
              spellCheck={false}
              className="font-mono"
              {...register('confirmation')}
            />
          </Field>
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

// ------------------------------------------------------------------ reissue

const reissueSchema = z.object({
  reasonCode: certification.reissueReasonSchema,
  note: z.string().trim().min(5, 'Describe what changed (at least 5 characters)').max(1000),
});

export function ReissueDialog({
  certificate,
  open,
  onOpenChange,
}: {
  certificate: Pick<CertificateDetail, 'id' | 'certificateNumber' | 'recipient'>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const navigate = useNavigate();
  const reissue = useReissueCertificate(certificate.id);
  const [formError, setFormError] = useState<string | null>(null);
  const { register, handleSubmit, setError, formState, reset } = useForm<
    z.infer<typeof reissueSchema>
  >({
    resolver: zodResolver(reissueSchema),
    defaultValues: { reasonCode: 'corrected_name', note: '' },
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
        title="Reissue certificate"
        description={`${certificate.certificateNumber} · ${certificate.recipient.displayName}`}
        dismissible={!reissue.isPending}
        footer={
          <>
            <Button onClick={() => onOpenChange(false)} disabled={reissue.isPending}>
              Cancel
            </Button>
            <Button type="submit" form="reissue-form" variant="primary" loading={reissue.isPending}>
              Reissue certificate
            </Button>
          </>
        }
      >
        <form
          id="reissue-form"
          className="grid gap-4"
          noValidate
          onSubmit={handleSubmit(async (v) => {
            setFormError(null);
            try {
              const next = await reissue.mutateAsync({
                reasonCode: v.reasonCode as ReissueReason,
                note: v.note,
              });
              toast.success(`Reissued as ${next.certificateNumber}`);
              onOpenChange(false);
              navigate(`${CENTER_ROOT}/issued/${next.id}`);
            } catch (err) {
              setFormError(applyServerErrors(err, setError, ['reasonCode', 'note']));
            }
          })}
        >
          <Notice tone="information">
            A new certificate is issued from the person&rsquo;s current records. The existing one is
            kept, marked as replaced, and no longer shown as valid.
          </Notice>
          <Field label="What changed" required error={formState.errors.reasonCode?.message}>
            <Select {...register('reasonCode')}>
              {REISSUE_REASONS.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field
            label="Note"
            required
            hint="Recorded with the new certificate and shown to the person."
            error={formState.errors.note?.message}
          >
            <Textarea rows={3} {...register('note')} />
          </Field>
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

// ------------------------------------------------------------------ issue

export interface IssuePreset {
  definitionId?: string;
  userId?: string;
  userName?: string;
}

/**
 * Manual issuance. If the requirements are not met the API refuses with the list of what is
 * missing; people who may update certifications can then issue with a recorded override reason.
 */
export function IssueDialog({
  open,
  onOpenChange,
  preset,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  preset?: IssuePreset;
}) {
  const navigate = useNavigate();
  const permissions = usePermissions();
  const definitions = useDefinitionOptions();
  const issue = useIssueCertificate();
  const [definitionId, setDefinitionId] = useState(preset?.definitionId ?? '');
  const [userIds, setUserIds] = useState<string[]>(preset?.userId ? [preset.userId] : []);
  const [overrideReason, setOverrideReason] = useState('');
  const [overriding, setOverriding] = useState(false);
  const [error, setError] = useState<ApiError | Error | null>(null);

  const active = (definitions.data?.items ?? []).filter((d) => d.status === 'active');
  const userId = userIds[0] ?? '';
  const unmet =
    error instanceof ApiError && Array.isArray(error.details.unmet)
      ? (error.details.unmet as string[])
      : [];
  const notEligible = error instanceof ApiError && error.code === 'NOT_ELIGIBLE';
  const canOverride = permissions.has('certifications.update');
  const overrideInvalid = overriding && overrideReason.trim().length < 10;

  const reset = () => {
    setDefinitionId(preset?.definitionId ?? '');
    setUserIds(preset?.userId ? [preset.userId] : []);
    setOverrideReason('');
    setOverriding(false);
    setError(null);
  };

  const submit = () => {
    setError(null);
    issue.mutate(
      {
        definitionId,
        userId,
        ...(overriding && { override: { reason: overrideReason.trim() } }),
      },
      {
        onSuccess: (cert) => {
          toast.success(`Issued ${cert.certificateNumber}`);
          reset();
          onOpenChange(false);
          navigate(`${CENTER_ROOT}/issued/${cert.id}`);
        },
        onError: (err) => setError(err),
      },
    );
  };

  return (
    <DialogRoot
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent
        title="Issue a certificate"
        description="Issues the certification to one person now, using the template and numbering configured for it."
        dismissible={!issue.isPending}
        footer={
          <>
            <Button onClick={() => onOpenChange(false)} disabled={issue.isPending}>
              Cancel
            </Button>
            <Button
              variant="primary"
              loading={issue.isPending}
              disabled={!definitionId || !userId || overrideInvalid}
              onClick={submit}
            >
              {overriding ? 'Issue with override' : 'Issue certificate'}
            </Button>
          </>
        }
      >
        <div className="grid gap-4">
          <Field label="Certification" required>
            <Select
              value={definitionId}
              disabled={Boolean(preset?.definitionId)}
              onChange={(e) => {
                setDefinitionId(e.target.value);
                setError(null);
                setOverriding(false);
              }}
            >
              <option value="">Choose a certification</option>
              {active.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Person" required hint="Search by name, email or employee ID.">
            {preset?.userId ? (
              <p className="flex h-[var(--a5-control-height)] items-center rounded border border-border bg-surface-sunken px-3">
                {preset.userName ?? 'Selected person'}
              </p>
            ) : (
              <PeoplePicker
                value={userIds}
                onChange={(ids) => {
                  setUserIds(ids);
                  setError(null);
                  setOverriding(false);
                }}
                max={1}
                placeholder="Search people"
              />
            )}
          </Field>

          {error && !notEligible && (
            <p role="alert" className="rounded bg-danger-soft px-3 py-2 text-sm text-danger">
              {errorMessage(error)}
            </p>
          )}
          {notEligible && (
            <div className="grid gap-3">
              <Notice tone="warning" title="Requirements are not met yet">
                {unmet.length > 0 ? (
                  <ul className="mt-1 list-disc pl-5">
                    {unmet.map((u) => (
                      <li key={u}>{u}</li>
                    ))}
                  </ul>
                ) : (
                  errorMessage(error)
                )}
              </Notice>
              {canOverride ? (
                !overriding ? (
                  <Button onClick={() => setOverriding(true)}>Issue anyway with an override</Button>
                ) : (
                  <Field
                    label="Override reason"
                    required
                    hint="Recorded with the certificate and in the audit trail."
                    error={
                      overrideInvalid
                        ? 'Explain why the requirements are being overridden (at least 10 characters)'
                        : undefined
                    }
                  >
                    <Textarea
                      rows={3}
                      value={overrideReason}
                      onChange={(e) => setOverrideReason(e.target.value)}
                    />
                  </Field>
                )
              ) : (
                <p className="text-sm text-text-secondary">
                  Only administrators who can update certifications may issue before the
                  requirements are met.
                </p>
              )}
            </div>
          )}
        </div>
      </DialogContent>
    </DialogRoot>
  );
}
