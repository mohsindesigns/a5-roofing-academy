import { certification as c } from '@a5/contracts';
import type { Rule } from '@a5/rules';
import { UNSET, cleanRule, countLeaves, asGroup, ruleProblems } from './rule-model';
import type { CertificationDetail } from './types';

type Request = c.CreateCertificationRequest;
type ApprovalPolicy = c.ApprovalPolicy;

export interface DefinitionFormValues {
  name: string;
  code: string;
  publicDescription: string;
  issuingOrganizationName: string;
  programIds: string[];
  approvalPolicy: ApprovalPolicy;
  automaticIssuance: boolean;
  eligibilityRule: Rule;
  validityKind: 'none' | 'months' | 'years' | 'fixed_date';
  validityMonths: number;
  validityYears: number;
  validityDate: string;
  windowDays: number;
  /** Comma-separated days before expiry, for example "90, 60, 30, 7". */
  reminderOffsets: string;
  renewalRequirements: Rule;
  templateId: string;
  stampId: string;
  signatory1: string;
  signatory2: string;
  badgeLabel: string;
  badgeColor: string;
  badgeAssetId: string;
  publicVerificationEnabled: boolean;
  numberPattern: string;
  customVariables: Array<{ key: string; label: string; value: string }>;
}

/**
 * Values for a new certification. Only identity fields start blank; the numbering pattern and
 * reminder schedule come from the API's own defaults (shared contract), not from the screen.
 */
export function emptyValues(issuingOrganizationName: string): DefinitionFormValues {
  return {
    name: '',
    code: '',
    publicDescription: '',
    issuingOrganizationName,
    programIds: [],
    approvalPolicy: 'none',
    automaticIssuance: true,
    eligibilityRule: { type: 'all', rules: [] },
    validityKind: 'none',
    validityMonths: UNSET,
    validityYears: UNSET,
    validityDate: '',
    windowDays: 90,
    reminderOffsets: c.DEFAULT_REMINDER_OFFSETS.join(', '),
    renewalRequirements: { type: 'all', rules: [] },
    templateId: '',
    stampId: '',
    signatory1: '',
    signatory2: '',
    badgeLabel: '',
    badgeColor: '#B87333',
    badgeAssetId: '',
    publicVerificationEnabled: true,
    numberPattern: c.DEFAULT_NUMBER_PATTERN,
    customVariables: [],
  };
}

export function fromDetail(d: CertificationDetail): DefinitionFormValues {
  const slot = (n: number) => d.signatories.find((s) => s.slot === n)?.id ?? '';
  return {
    name: d.name,
    code: d.code,
    publicDescription: d.publicDescription ?? '',
    issuingOrganizationName: d.issuingOrganizationName,
    programIds: d.programIds,
    approvalPolicy: d.approvalPolicy,
    automaticIssuance: d.automaticIssuance,
    eligibilityRule: asGroup(d.eligibilityRule),
    validityKind: d.validity.kind,
    validityMonths: d.validity.kind === 'months' ? d.validity.months : UNSET,
    validityYears: d.validity.kind === 'years' ? d.validity.years : UNSET,
    validityDate: d.validity.kind === 'fixed_date' ? d.validity.date : '',
    windowDays: d.renewal.windowDays,
    reminderOffsets: d.renewal.reminderOffsets.join(', '),
    renewalRequirements: asGroup(d.renewal.requirements),
    templateId: d.templateId ?? '',
    stampId: d.stamp?.id ?? '',
    signatory1: slot(1),
    signatory2: slot(2),
    badgeLabel: d.badge.label ?? '',
    badgeColor: d.badge.color,
    badgeAssetId: d.badge.assetId ?? '',
    publicVerificationEnabled: d.publicVerificationEnabled,
    numberPattern: d.numberPattern,
    customVariables: d.customVariables,
  };
}

/** "90, 60 30" → [90, 60, 30]; anything that is not a whole number becomes NaN so validation reports it. */
export function parseOffsets(text: string): number[] {
  return text
    .split(/[,\s]+/)
    .filter(Boolean)
    .map((t) => (/^\d+$/.test(t) ? Number(t) : Number.NaN));
}

function validityOf(v: DefinitionFormValues): unknown {
  switch (v.validityKind) {
    case 'none':
      return { kind: 'none' };
    case 'months':
      return { kind: 'months', months: v.validityMonths };
    case 'years':
      return { kind: 'years', years: v.validityYears };
    case 'fixed_date':
      return { kind: 'fixed_date', date: v.validityDate };
  }
}

/** The API request for the form, before schema validation. */
export function toRequest(v: DefinitionFormValues): Record<string, unknown> {
  const signatories = [
    ...(v.signatory1 ? [{ slot: 1, signatoryId: v.signatory1 }] : []),
    ...(v.signatory2 ? [{ slot: 2, signatoryId: v.signatory2 }] : []),
  ];
  return {
    name: v.name,
    code: v.code,
    publicDescription: v.publicDescription,
    issuingOrganizationName: v.issuingOrganizationName,
    programIds: v.programIds,
    validity: validityOf(v),
    renewal: {
      windowDays: v.windowDays,
      reminderOffsets: parseOffsets(v.reminderOffsets),
      requirements: cleanRule(v.renewalRequirements),
    },
    eligibilityRule: cleanRule(v.eligibilityRule),
    approvalPolicy: v.approvalPolicy,
    automaticIssuance: v.automaticIssuance,
    templateId: v.templateId || null,
    badge: { label: v.badgeLabel || null, color: v.badgeColor, assetId: v.badgeAssetId || null },
    publicVerificationEnabled: v.publicVerificationEnabled,
    numberPattern: v.numberPattern,
    signatories,
    stampId: v.stampId || null,
    customVariables: v.customVariables,
  };
}

/** Form field that shows the message for an API/schema path such as `validity.months`. */
export function fieldForPath(path: ReadonlyArray<string | number | symbol>): string {
  const [head, second, third] = path.map(String);
  switch (head) {
    case 'validity':
      return second === 'months'
        ? 'validityMonths'
        : second === 'years'
          ? 'validityYears'
          : second === 'date'
            ? 'validityDate'
            : 'validityKind';
    case 'renewal':
      if (second === 'requirements') return 'renewalRequirements';
      if (second === 'reminderOffsets') return 'reminderOffsets';
      return 'windowDays';
    case 'badge':
      return second === 'label' ? 'badgeLabel' : second === 'color' ? 'badgeColor' : 'badgeAssetId';
    case 'signatories':
      return 'signatories';
    case 'customVariables':
      return second !== undefined && third !== undefined
        ? `customVariables.${second}.${third}`
        : 'customVariables';
    default:
      return head ?? 'form';
  }
}

export interface FormValidation {
  errors: Record<string, string>;
  request: Request | null;
}

/**
 * Validate the whole form with the shared contract schema (the same one the API applies) plus
 * friendlier messages for incomplete requirements. Returns the parsed request when valid.
 */
export function validateForm(v: DefinitionFormValues): FormValidation {
  const errors: Record<string, string> = {};
  const add = (field: string, message: string) => {
    errors[field] ??= message;
  };

  const ruleCount = (rule: Rule) => ruleProblems(rule).length;
  const eligibility = ruleCount(v.eligibilityRule);
  if (eligibility > 0)
    add(
      'eligibilityRule',
      `${eligibility} ${eligibility === 1 ? 'requirement needs' : 'requirements need'} attention.`,
    );
  const renewal = ruleCount(v.renewalRequirements);
  if (renewal > 0)
    add(
      'renewalRequirements',
      `${renewal} ${renewal === 1 ? 'requirement needs' : 'requirements need'} attention.`,
    );
  if (v.validityKind === 'months' && !Number.isFinite(v.validityMonths))
    add('validityMonths', 'Enter a number of months.');
  if (v.validityKind === 'years' && !Number.isFinite(v.validityYears))
    add('validityYears', 'Enter a number of years.');
  if (v.validityKind === 'fixed_date' && !v.validityDate)
    add('validityDate', 'Choose the expiration date.');
  if (!Number.isFinite(v.windowDays)) add('windowDays', 'Enter a number of days (0 or more).');
  if (parseOffsets(v.reminderOffsets).some(Number.isNaN)) {
    add(
      'reminderOffsets',
      'Use whole numbers of days separated by commas, for example 90, 60, 30, 7.',
    );
  }

  const parsed = c.createCertificationRequestSchema.safeParse(toRequest(v));
  if (!parsed.success) {
    for (const issue of parsed.error.issues) add(fieldForPath(issue.path), issue.message);
  }
  if (Object.keys(errors).length > 0) return { errors, request: null };
  return { errors, request: parsed.success ? parsed.data : null };
}

/** Top-level request fields whose value differs. Unchanged fields are not sent, so a person who may not list signatories can still edit requirements. */
export function changedFields(before: Request, after: Request): Partial<Request> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(after) as Array<keyof Request>) {
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) out[key] = after[key];
  }
  return out as Partial<Request>;
}

/** Normalised request of a saved certification, for comparing with the edited form. */
export function requestOf(d: CertificationDetail): Request | null {
  return validateForm(fromDetail(d)).request;
}

export function hasRequirements(rule: Rule): boolean {
  return countLeaves(rule) > 0;
}

/** Mirrors the API: configured code, else the first word of the issuer, upper-cased. */
export function organizationToken(
  configured: string | null,
  issuingOrganizationName: string,
): string {
  if (configured) return configured;
  const first = issuingOrganizationName.trim().split(/\s+/)[0] ?? '';
  const code = first
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 10);
  return code || 'ORG';
}
