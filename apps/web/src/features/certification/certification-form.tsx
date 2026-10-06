import { useMemo } from 'react';
import { Link } from 'react-router';
import { Plus, Trash2 } from 'lucide-react';
import { certification as c } from '@a5/contracts';
import {
  Button,
  Field,
  IconButton,
  Input,
  MultiSelect,
  Notice,
  Panel,
  Section,
  Select,
  Switch,
  Textarea,
} from '@/components/ui';
import { ApiError } from '@/lib/api/errors';
import {
  useAsset,
  useProgramLookup,
  useSignatories,
  useStamps,
  useTemplateOptions,
  useUploadAsset,
} from './api';
import { organizationToken, type DefinitionFormValues } from './definition-form';
import { ImageUploader } from './image-upload';
import { APPROVAL_POLICY_LABEL } from './labels';
import { ReadOnlyChips } from './read-only-chips';
import { RuleEditor } from './rule-editor';
import { stripApprovals } from './rule-model';
import type { CertificationDetail } from './types';

type Errors = Record<string, string>;

interface FormProps {
  values: DefinitionFormValues;
  patch: (patch: Partial<DefinitionFormValues>) => void;
  errors: Errors;
  showProblems: boolean;
  readOnly: boolean;
  /** Saved certification, when editing. */
  detail?: CertificationDetail;
  /** Whether people already hold certificates (the code is then fixed). */
  active: boolean;
  canEditTemplates: boolean;
}

function deniedHint(error: unknown, noun: string): string | undefined {
  if (!error) return undefined;
  return error instanceof ApiError && error.isForbidden
    ? `You can't list ${noun} with your current permissions. The current choice is kept.`
    : `The list of ${noun} could not be loaded. The current choice is kept.`;
}

// ------------------------------------------------------------------ sections

function DetailsSection({ values, patch, errors, readOnly, detail }: FormProps) {
  const codeLocked = Boolean(detail && (detail.counts.active > 0 || detail.activatedAt));
  return (
    <Section title="Details" description="How the certification is named and who issues it.">
      <Panel>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name" required error={errors['name']} className="sm:col-span-2">
            <Input
              value={values.name}
              disabled={readOnly}
              maxLength={160}
              onChange={(e) => patch({ name: e.target.value })}
            />
          </Field>
          <Field
            label="Code"
            required
            error={errors['code']}
            hint={
              codeLocked
                ? 'Part of issued certificate numbers, so it can no longer change.'
                : 'Short and unique, for example SALES. Used in certificate numbers.'
            }
          >
            <Input
              className="font-mono uppercase"
              value={values.code}
              disabled={readOnly || codeLocked}
              maxLength={20}
              onChange={(e) => patch({ code: e.target.value })}
            />
          </Field>
          <Field
            label="Issuing organization"
            required
            error={errors['issuingOrganizationName']}
            hint="Printed on the certificate and shown when someone verifies it."
          >
            <Input
              value={values.issuingOrganizationName}
              disabled={readOnly}
              maxLength={160}
              onChange={(e) => patch({ issuingOrganizationName: e.target.value })}
            />
          </Field>
          <Field
            label="Description"
            optional
            error={errors['publicDescription']}
            hint="Shown to people working toward this certification."
            className="sm:col-span-2"
          >
            <Textarea
              rows={3}
              value={values.publicDescription}
              disabled={readOnly}
              maxLength={2000}
              onChange={(e) => patch({ publicDescription: e.target.value })}
            />
          </Field>
        </div>
      </Panel>
    </Section>
  );
}

function ProgramsSection({ values, patch, errors, readOnly, detail }: FormProps) {
  const programs = useProgramLookup();
  const options = (programs.data ?? []).map((p) => ({ value: p.id, label: p.label }));
  const known = Object.fromEntries(
    (detail?.programs ?? []).map((p) => [p.id, p.title ?? 'Unnamed program']),
  );
  return (
    <Section
      title="Programs"
      description="Programs that lead to this certification. People enrolled in them are tracked here as working toward it."
    >
      <Panel>
        <Field
          label="Programs"
          optional
          error={errors['programIds']}
          hint={deniedHint(programs.error, 'programs')}
        >
          {readOnly ? (
            <ReadOnlyChips
              ids={values.programIds}
              labels={{ ...Object.fromEntries(options.map((o) => [o.value, o.label])), ...known }}
              empty="No programs linked."
            />
          ) : (
            <MultiSelect
              options={options}
              value={values.programIds}
              selectedLabels={known}
              onChange={(programIds) => patch({ programIds })}
              loading={programs.isPending}
              placeholder="Search programs"
              max={20}
            />
          )}
        </Field>
      </Panel>
    </Section>
  );
}

function RequirementsSection({
  values,
  patch,
  errors,
  showProblems,
  readOnly,
  detail,
  active,
}: FormProps) {
  return (
    <Section
      title="Requirements"
      description="What a person must complete to earn the certification. Every number is yours to set."
    >
      <Panel className="grid gap-6">
        {active && (
          <Notice tone="warning" title="This certification is active">
            Saving changed requirements re-evaluates everyone working toward it straight away.
          </Notice>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Approval"
            hint="When someone meets every requirement, this person must sign off before the certificate is issued."
            error={errors['approvalPolicy']}
          >
            <Select
              value={values.approvalPolicy}
              disabled={readOnly}
              onChange={(e) =>
                patch({
                  approvalPolicy: e.target.value as c.ApprovalPolicy,
                  // Approval requirements follow the policy; the API adds the one that applies.
                  eligibilityRule: stripApprovals(values.eligibilityRule),
                  renewalRequirements: stripApprovals(values.renewalRequirements),
                })
              }
            >
              {c.approvalPolicySchema.options.map((p) => (
                <option key={p} value={p}>
                  {APPROVAL_POLICY_LABEL[p]}
                </option>
              ))}
            </Select>
          </Field>
          <div className="flex items-start gap-3 sm:pt-6">
            <Switch
              id="automatic-issuance"
              checked={values.automaticIssuance}
              disabled={readOnly}
              aria-labelledby="automatic-issuance-label"
              onCheckedChange={(automaticIssuance) => patch({ automaticIssuance })}
            />
            <div>
              <label
                id="automatic-issuance-label"
                htmlFor="automatic-issuance"
                className="text-sm font-medium"
              >
                Issue automatically
              </label>
              <p className="text-xs text-text-secondary">
                {values.automaticIssuance
                  ? 'The certificate is issued as soon as requirements (and approval) are complete.'
                  : 'An administrator issues each certificate by hand from the issued list.'}
              </p>
            </div>
          </div>
        </div>
        <div>
          <RuleEditor
            ariaLabel="Eligibility requirements"
            value={values.eligibilityRule}
            onChange={(eligibilityRule) => patch({ eligibilityRule })}
            programIds={values.programIds}
            excludeCertificationId={detail?.id}
            disabled={readOnly}
            showProblems={showProblems}
          />
          {errors['eligibilityRule'] && (
            <p role="alert" className="mt-2 text-sm font-medium text-danger">
              {errors['eligibilityRule']}
            </p>
          )}
        </div>
        {detail && detail.requirements.length > 0 && (
          <div>
            <h3 className="text-sm font-semibold">How people see these requirements</h3>
            <ul className="mt-1.5 list-disc space-y-0.5 pl-5 text-sm text-text-secondary">
              {detail.requirements.map((r, i) => (
                <li key={i}>{r.description}</li>
              ))}
            </ul>
          </div>
        )}
      </Panel>
    </Section>
  );
}

function ValiditySection({ values, patch, errors, showProblems, readOnly, detail }: FormProps) {
  return (
    <Section
      title="Validity and renewal"
      description="How long a certificate lasts and what people do to renew it."
    >
      <Panel className="grid gap-6">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Validity" error={errors['validityKind']}>
            <Select
              value={values.validityKind}
              disabled={readOnly}
              onChange={(e) =>
                patch({ validityKind: e.target.value as DefinitionFormValues['validityKind'] })
              }
            >
              <option value="none">Never expires</option>
              <option value="months">A number of months</option>
              <option value="years">A number of years</option>
              <option value="fixed_date">Until a fixed date</option>
            </Select>
          </Field>
          {values.validityKind === 'months' && (
            <Field label="Months" required error={errors['validityMonths']}>
              <Input
                type="number"
                min={1}
                max={240}
                disabled={readOnly}
                value={Number.isFinite(values.validityMonths) ? values.validityMonths : ''}
                onChange={(e) =>
                  patch({
                    validityMonths: e.target.value === '' ? Number.NaN : Number(e.target.value),
                  })
                }
              />
            </Field>
          )}
          {values.validityKind === 'years' && (
            <Field label="Years" required error={errors['validityYears']}>
              <Input
                type="number"
                min={1}
                max={20}
                disabled={readOnly}
                value={Number.isFinite(values.validityYears) ? values.validityYears : ''}
                onChange={(e) =>
                  patch({
                    validityYears: e.target.value === '' ? Number.NaN : Number(e.target.value),
                  })
                }
              />
            </Field>
          )}
          {values.validityKind === 'fixed_date' && (
            <Field
              label="Expires on"
              required
              error={errors['validityDate']}
              hint="Every certificate expires on this date."
            >
              <Input
                type="date"
                disabled={readOnly}
                value={values.validityDate}
                onChange={(e) => patch({ validityDate: e.target.value })}
              />
            </Field>
          )}
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Renewal window"
            error={errors['windowDays']}
            hint="Days before expiry when renewal opens. 0 means people recertify after it expires."
          >
            <Input
              type="number"
              min={0}
              max={365}
              disabled={readOnly}
              value={Number.isFinite(values.windowDays) ? values.windowDays : ''}
              trailing={
                <span className="pointer-events-none text-sm text-text-secondary">days</span>
              }
              onChange={(e) =>
                patch({ windowDays: e.target.value === '' ? Number.NaN : Number(e.target.value) })
              }
            />
          </Field>
          <Field
            label="Reminders"
            error={errors['reminderOffsets']}
            hint="Days before expiry when people are reminded, separated by commas."
          >
            <Input
              disabled={readOnly}
              inputMode="numeric"
              value={values.reminderOffsets}
              onChange={(e) => patch({ reminderOffsets: e.target.value })}
            />
          </Field>
        </div>
        <div>
          <h3 className="text-sm font-semibold">Recertification requirements</h3>
          <p className="mb-2 text-sm text-text-secondary">
            What people complete again once the renewal window opens. Leave empty if renewal only
            needs approval.
          </p>
          <RuleEditor
            ariaLabel="Renewal requirements"
            value={values.renewalRequirements}
            onChange={(renewalRequirements) => patch({ renewalRequirements })}
            programIds={values.programIds}
            excludeCertificationId={detail?.id}
            disabled={readOnly}
            showProblems={showProblems}
          />
          {errors['renewalRequirements'] && (
            <p role="alert" className="mt-2 text-sm font-medium text-danger">
              {errors['renewalRequirements']}
            </p>
          )}
        </div>
      </Panel>
    </Section>
  );
}

function BadgeUpload({
  values,
  patch,
  readOnly,
}: Pick<FormProps, 'values' | 'patch' | 'readOnly'>) {
  const upload = useUploadAsset('badge');
  const asset = useAsset(values.badgeAssetId || null);
  return (
    <ImageUploader
      purpose="badge"
      label="badge image"
      currentUrl={
        values.badgeAssetId
          ? upload.data?.id === values.badgeAssetId
            ? upload.data.previewUrl
            : asset.data?.previewUrl
          : null
      }
      currentAlt="Badge"
      disabled={readOnly}
      onUpload={async (file) => {
        const created = await upload.mutateAsync(file);
        patch({ badgeAssetId: created.id });
      }}
      onRemove={() => patch({ badgeAssetId: '' })}
    />
  );
}

function CertificateSection(props: FormProps) {
  const { values, patch, errors, readOnly, detail, canEditTemplates } = props;
  const templates = useTemplateOptions();
  const signatories = useSignatories({ page: 1, pageSize: 100, active: 'true' });
  const stamps = useStamps({ page: 1, pageSize: 100, active: 'true' });

  const signatoryOptions = useMemo(() => {
    const map = new Map<string, string>();
    for (const s of detail?.signatories ?? [])
      map.set(s.id, `${s.name}, ${s.title}${s.active ? '' : ' (inactive)'}`);
    for (const s of signatories.data?.items ?? []) map.set(s.id, `${s.name}, ${s.title}`);
    return [...map.entries()].map(([id, label]) => ({ id, label }));
  }, [detail, signatories.data]);
  const stampOptions = useMemo(() => {
    const map = new Map<string, string>();
    if (detail?.stamp)
      map.set(detail.stamp.id, `${detail.stamp.name}${detail.stamp.active ? '' : ' (inactive)'}`);
    for (const s of stamps.data?.items ?? []) map.set(s.id, s.name);
    return [...map.entries()].map(([id, label]) => ({ id, label }));
  }, [detail, stamps.data]);
  const templateOptions = useMemo(() => {
    const map = new Map<string, string>();
    if (detail?.template) map.set(detail.template.id, detail.template.name);
    for (const t of templates.data?.items ?? []) map.set(t.id, t.name);
    return [...map.entries()].map(([id, label]) => ({ id, label }));
  }, [detail, templates.data]);

  const signatoryHint = deniedHint(signatories.error, 'signatories');
  return (
    <Section
      title="Certificate"
      description="The template, signatures and seal printed on each certificate, and what the public verification page shows."
    >
      <Panel className="grid gap-6">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Template"
            error={errors['templateId']}
            hint={
              deniedHint(templates.error, 'templates') ??
              (canEditTemplates && values.templateId ? (
                <Link
                  className="text-information underline underline-offset-2"
                  to={`/certification-center/templates/${values.templateId}`}
                >
                  Open this template in the designer
                </Link>
              ) : undefined)
            }
            className="sm:col-span-2"
          >
            <Select
              value={values.templateId}
              disabled={readOnly}
              onChange={(e) => patch({ templateId: e.target.value })}
            >
              <option value="">No template yet</option>
              {templateOptions.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </Select>
          </Field>
          {([1, 2] as const).map((slot) => {
            const key = slot === 1 ? 'signatory1' : 'signatory2';
            return (
              <Field
                key={slot}
                label={`Signatory ${slot}`}
                optional
                hint={signatoryHint}
                error={slot === 1 ? errors['signatories'] : undefined}
              >
                <Select
                  value={values[key]}
                  disabled={readOnly}
                  onChange={(e) => patch({ [key]: e.target.value })}
                >
                  <option value="">None</option>
                  {signatoryOptions.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.label}
                    </option>
                  ))}
                </Select>
              </Field>
            );
          })}
          <Field
            label="Stamp"
            optional
            error={errors['stampId']}
            hint={deniedHint(stamps.error, 'stamps')}
          >
            <Select
              value={values.stampId}
              disabled={readOnly}
              onChange={(e) => patch({ stampId: e.target.value })}
            >
              <option value="">None</option>
              {stampOptions.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Badge label"
            optional
            error={errors['badgeLabel']}
            hint="A short tag shown beside the certification, such as Level 1."
          >
            <Input
              value={values.badgeLabel}
              disabled={readOnly}
              maxLength={40}
              onChange={(e) => patch({ badgeLabel: e.target.value })}
            />
          </Field>
          <div>
            <label htmlFor="badge-colour" className="text-sm font-medium">
              Badge colour
            </label>
            <div className="mt-1.5 flex items-center gap-2">
              <input
                type="color"
                aria-label="Pick badge colour"
                disabled={readOnly}
                value={/^#[0-9a-fA-F]{6}$/.test(values.badgeColor) ? values.badgeColor : '#000000'}
                onChange={(e) => patch({ badgeColor: e.target.value.toUpperCase() })}
                className="h-[var(--a5-control-height)] w-12 shrink-0 cursor-pointer rounded border border-border-strong bg-surface p-1"
              />
              <Input
                id="badge-colour"
                className="font-mono"
                value={values.badgeColor}
                disabled={readOnly}
                maxLength={7}
                aria-invalid={errors['badgeColor'] ? true : undefined}
                aria-describedby="badge-colour-hint"
                onChange={(e) => patch({ badgeColor: e.target.value })}
              />
            </div>
            <p
              id="badge-colour-hint"
              role={errors['badgeColor'] ? 'alert' : undefined}
              className={
                errors['badgeColor']
                  ? 'mt-1.5 text-xs font-medium text-danger'
                  : 'mt-1.5 text-xs text-text-secondary'
              }
            >
              {errors['badgeColor'] ?? 'Six-digit hex, for example #B87333.'}
            </p>
          </div>
          <div className="sm:col-span-2">
            <p className="mb-1.5 text-sm font-medium">Badge image</p>
            <BadgeUpload values={values} patch={patch} readOnly={readOnly} />
          </div>
        </div>

        <CustomVariables {...props} />

        <div className="flex items-start gap-3">
          <Switch
            id="public-verification"
            checked={values.publicVerificationEnabled}
            disabled={readOnly}
            aria-labelledby="public-verification-label"
            onCheckedChange={(publicVerificationEnabled) => patch({ publicVerificationEnabled })}
          />
          <div>
            <label
              id="public-verification-label"
              htmlFor="public-verification"
              className="text-sm font-medium"
            >
              Allow public verification
            </label>
            <p className="text-xs text-text-secondary">
              Anyone with a certificate&rsquo;s link or QR code can check it. The page shows the
              holder&rsquo;s name, the certification, dates and status. Turn this off and the link
              stops working.
            </p>
          </div>
        </div>
      </Panel>
    </Section>
  );
}

function CustomVariables({ values, patch, errors, readOnly }: FormProps) {
  const vars = values.customVariables;
  const set = (i: number, part: Partial<(typeof vars)[number]>) =>
    patch({ customVariables: vars.map((v, idx) => (idx === i ? { ...v, ...part } : v)) });
  return (
    <div>
      <h3 className="text-sm font-semibold">Custom text for the template</h3>
      <p className="mb-2 text-sm text-text-secondary">
        Extra wording a template can use as <code className="font-mono text-xs">{'{{name}}'}</code>,
        for example a licence line. Names use lowercase letters, digits and underscores.
      </p>
      {errors['customVariables'] && (
        <p role="alert" className="mb-2 text-sm font-medium text-danger">
          {errors['customVariables']}
        </p>
      )}
      {vars.length > 0 && (
        <ul className="grid gap-3">
          {vars.map((v, i) => (
            <li key={i} className="grid gap-2 sm:grid-cols-[1fr_1fr_2fr_auto] sm:items-start">
              <Field label="Name" error={errors[`customVariables.${i}.key`]} hideLabel={i > 0}>
                <Input
                  className="font-mono"
                  value={v.key}
                  disabled={readOnly}
                  maxLength={40}
                  onChange={(e) => set(i, { key: e.target.value })}
                />
              </Field>
              <Field label="Label" error={errors[`customVariables.${i}.label`]} hideLabel={i > 0}>
                <Input
                  value={v.label}
                  disabled={readOnly}
                  maxLength={80}
                  onChange={(e) => set(i, { label: e.target.value })}
                />
              </Field>
              <Field label="Text" error={errors[`customVariables.${i}.value`]} hideLabel={i > 0}>
                <Input
                  value={v.value}
                  disabled={readOnly}
                  maxLength={300}
                  onChange={(e) => set(i, { value: e.target.value })}
                />
              </Field>
              {!readOnly && (
                <IconButton
                  label={`Remove custom text ${v.key || i + 1}`}
                  className={i === 0 ? 'sm:mt-[26px]' : undefined}
                  onClick={() => patch({ customVariables: vars.filter((_, idx) => idx !== i) })}
                >
                  <Trash2 className="size-4" />
                </IconButton>
              )}
            </li>
          ))}
        </ul>
      )}
      {!readOnly && vars.length < 20 && (
        <Button
          className="mt-3"
          size="sm"
          leading={<Plus className="size-4" />}
          onClick={() => patch({ customVariables: [...vars, { key: '', label: '', value: '' }] })}
        >
          Add custom text
        </Button>
      )}
    </div>
  );
}

const TOKEN_HELP: Array<[string, string]> = [
  ['{ORG}', 'Organization code'],
  ['{CODE}', 'This certification’s code'],
  ['{YYYY}', 'Four-digit year'],
  ['{YY}', 'Two-digit year'],
  ['{MM}', 'Month, 01 to 12'],
  ['{SEQ:6}', 'Running number with 6 digits (3 to 10)'],
];

function NumberingSection({
  values,
  patch,
  errors,
  readOnly,
  detail,
  organizationCode,
}: FormProps & { organizationCode: string | null }) {
  const problems = c.numberPatternProblems(values.numberPattern.trim());
  const example =
    problems.length === 0
      ? c.formatCertificateNumber(values.numberPattern.trim(), {
          org: organizationToken(organizationCode, values.issuingOrganizationName),
          code: (values.code.trim() || 'CODE').toUpperCase(),
          issuedAt: new Date(),
          seq: 1,
        })
      : null;
  return (
    <Section
      title="Numbering"
      description="Every certificate gets a unique number. Numbers only count up and are never reused."
    >
      <Panel className="grid gap-4">
        <Field
          label="Number pattern"
          required
          error={
            errors['numberPattern'] ??
            (problems[0] && values.numberPattern ? problems[0] : undefined)
          }
        >
          <Input
            className="font-mono"
            value={values.numberPattern}
            disabled={readOnly}
            maxLength={80}
            onChange={(e) => patch({ numberPattern: e.target.value })}
          />
        </Field>
        <dl className="grid gap-x-8 gap-y-2 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-xs font-medium text-text-secondary">Example</dt>
            <dd className="font-mono">{example ?? '—'}</dd>
          </div>
          {detail && (
            <div>
              <dt className="text-xs font-medium text-text-secondary">
                Next number with the saved pattern
              </dt>
              <dd className="font-mono">{detail.numberPreview}</dd>
            </div>
          )}
        </dl>
        <details className="text-sm">
          <summary className="cursor-pointer font-medium text-information">Pattern pieces</summary>
          <ul className="mt-2 grid gap-1 sm:grid-cols-2">
            {TOKEN_HELP.map(([token, text]) => (
              <li key={token}>
                <code className="font-mono text-xs">{token}</code>
                <span className="text-text-secondary"> {text}</span>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-text-secondary">
            A pattern needs one <code className="font-mono text-xs">{'{CODE}'}</code> and one{' '}
            <code className="font-mono text-xs">{'{SEQ:n}'}</code>. Letters, digits and - _ / . may
            sit between pieces.
          </p>
        </details>
      </Panel>
    </Section>
  );
}

export function CertificationFormSections(props: FormProps & { organizationCode: string | null }) {
  return (
    <>
      <DetailsSection {...props} />
      <ProgramsSection {...props} />
      <RequirementsSection {...props} />
      <ValiditySection {...props} />
      <CertificateSection {...props} />
      <NumberingSection {...props} />
    </>
  );
}

export type { FormProps };
