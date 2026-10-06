// API contracts for the certification domain. Shared by the service and the web app.
import { z } from 'zod';
import { ruleSchema, type Rule } from '@a5/rules';
import {
  isoDate,
  isoDateTime,
  nameString,
  optionalText,
  pageQuerySchema,
  pageSchema,
  personRefSchema,
  queryList,
} from './common.js';

// ------------------------------------------------------------------ primitives

export const hexColorSchema = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, 'Use a 6-digit hex color such as #1F2937');

const percent = z.number().min(0).max(100);

// ------------------------------------------------------------------ placeholders

/** Placeholders every certificate can use. Custom variables of a certification add to these. */
export const BUILT_IN_PLACEHOLDERS = [
  'certificate_name',
  'recipient_name',
  'employee_id',
  'program_name',
  'completion_date',
  'issue_date',
  'expiration_date',
  'certificate_number',
  'verification_url',
  'qr_code',
  'organization_name',
  'signatory_1_name',
  'signatory_1_title',
  'signatory_1_signature',
  'signatory_2_name',
  'signatory_2_title',
  'signatory_2_signature',
  'organization_stamp',
] as const;
export type BuiltInPlaceholder = (typeof BUILT_IN_PLACEHOLDERS)[number];

/** Placeholders that stand for an image (only valid on qr/signature/stamp elements). */
export const IMAGE_PLACEHOLDERS = [
  'qr_code',
  'signatory_1_signature',
  'signatory_2_signature',
  'organization_stamp',
] as const;

export const PLACEHOLDER_LABELS: Record<BuiltInPlaceholder, string> = {
  certificate_name: 'Certification name',
  recipient_name: 'Recipient legal name',
  employee_id: 'Employee ID',
  program_name: 'Program name',
  completion_date: 'Completion date',
  issue_date: 'Issue date',
  expiration_date: 'Expiration date',
  certificate_number: 'Certificate number',
  verification_url: 'Verification URL',
  qr_code: 'Verification QR code',
  organization_name: 'Issuing organization',
  signatory_1_name: 'Signatory 1 name',
  signatory_1_title: 'Signatory 1 title',
  signatory_1_signature: 'Signatory 1 signature',
  signatory_2_name: 'Signatory 2 name',
  signatory_2_title: 'Signatory 2 title',
  signatory_2_signature: 'Signatory 2 signature',
  organization_stamp: 'Organization stamp',
};

const PLACEHOLDER_RE = /\{\{\s*([a-zA-Z0-9_.-]*)\s*\}\}/g;
const PLACEHOLDER_KEY = /^[a-z][a-z0-9_]{0,39}$/;

export function isBuiltInPlaceholder(key: string): key is BuiltInPlaceholder {
  return (BUILT_IN_PLACEHOLDERS as readonly string[]).includes(key);
}

/** Placeholder keys used in a text, in order of first appearance. */
export function extractPlaceholders(text: string): string[] {
  const found: string[] = [];
  for (const m of text.matchAll(PLACEHOLDER_RE)) {
    const key = m[1] ?? '';
    if (!found.includes(key)) found.push(key);
  }
  return found;
}

/** Replace `{{key}}` with values. Unknown keys resolve to an empty string. */
export function resolvePlaceholders(
  text: string,
  values: Readonly<Record<string, string>>,
): string {
  return text.replace(PLACEHOLDER_RE, (_m, key: string) => values[key] ?? '');
}

export const customVariableKeySchema = z
  .string()
  .trim()
  .regex(PLACEHOLDER_KEY, 'Use lowercase letters, digits and underscores, starting with a letter')
  .refine((k) => !isBuiltInPlaceholder(k), 'This name is reserved for a built-in placeholder');

// ------------------------------------------------------------------ certificate numbering

export const NUMBER_PATTERN_TOKENS = ['ORG', 'CODE', 'YYYY', 'YY', 'MM', 'SEQ'] as const;
const TOKEN_RE = /\{([A-Z]+)(?::(\d+))?\}/g;

export interface NumberPatternContext {
  org: string;
  code: string;
  issuedAt: Date;
  seq: number;
}

/** Validate a numbering pattern. Returns a list of problems (empty when valid). */
export function numberPatternProblems(pattern: string): string[] {
  const problems: string[] = [];
  let seqCount = 0;
  let codeCount = 0;
  const literal = pattern.replace(TOKEN_RE, (_m, token: string, width: string | undefined) => {
    if (!(NUMBER_PATTERN_TOKENS as readonly string[]).includes(token)) {
      problems.push(
        `Unknown token {${token}}. Use ${NUMBER_PATTERN_TOKENS.map((t) => (t === 'SEQ' ? '{SEQ:n}' : `{${t}}`)).join(', ')}.`,
      );
    } else if (token === 'SEQ') {
      seqCount++;
      const n = width === undefined ? NaN : Number(width);
      if (!Number.isInteger(n) || n < 3 || n > 10)
        problems.push('{SEQ:n} needs a width between 3 and 10, for example {SEQ:6}.');
    } else if (width !== undefined) {
      problems.push(`{${token}} does not take a width.`);
    }
    if (token === 'CODE') codeCount++;
    return '';
  });
  if (/[{}]/.test(literal)) problems.push('Braces are only allowed around tokens such as {CODE}.');
  if (!/^[A-Za-z0-9\-_/.]*$/.test(literal))
    problems.push('Only letters, digits and - _ / . are allowed between tokens.');
  if (seqCount !== 1) problems.push('The pattern must contain exactly one {SEQ:n} token.');
  if (codeCount !== 1)
    problems.push(
      'The pattern must contain exactly one {CODE} token so numbers stay unique across certifications.',
    );
  return problems;
}

/** Format a certificate number. Dates use UTC so numbers never depend on server time zones. */
export function formatCertificateNumber(pattern: string, ctx: NumberPatternContext): string {
  return pattern.replace(TOKEN_RE, (_m, token: string, width: string | undefined) => {
    switch (token) {
      case 'ORG':
        return ctx.org;
      case 'CODE':
        return ctx.code;
      case 'YYYY':
        return String(ctx.issuedAt.getUTCFullYear());
      case 'YY':
        return String(ctx.issuedAt.getUTCFullYear()).slice(-2);
      case 'MM':
        return String(ctx.issuedAt.getUTCMonth() + 1).padStart(2, '0');
      case 'SEQ':
        return String(ctx.seq).padStart(Number(width ?? 6), '0');
      default:
        return '';
    }
  });
}

export const numberPatternSchema = z
  .string()
  .trim()
  .min(6)
  .max(80)
  .superRefine((value, ctx) => {
    for (const message of numberPatternProblems(value)) ctx.addIssue({ code: 'custom', message });
  });

export const DEFAULT_NUMBER_PATTERN = '{ORG}-{CODE}-{YYYY}-{SEQ:6}';

// ------------------------------------------------------------------ template design

/** Elements must stay inside this area (percent of the page) so printers never clip them. */
export const DESIGN_SAFE_AREA = { min: 2, max: 98 } as const;

export const pageSizeSchema = z.enum(['LETTER', 'A4']);
export const pageOrientationSchema = z.enum(['landscape', 'portrait']);
export const fontFamilySchema = z.enum(['serif', 'sans', 'display']);
export type DesignFontFamily = z.infer<typeof fontFamilySchema>;

/** Page sizes in PDF points (1/72 inch), portrait orientation. */
export const PAGE_SIZES_PT: Record<
  z.infer<typeof pageSizeSchema>,
  { width: number; height: number }
> = {
  LETTER: { width: 612, height: 792 },
  A4: { width: 595.28, height: 841.89 },
};

export function pageDimensions(page: {
  size: z.infer<typeof pageSizeSchema>;
  orientation: z.infer<typeof pageOrientationSchema>;
}) {
  const base = PAGE_SIZES_PT[page.size];
  return page.orientation === 'landscape'
    ? { width: base.height, height: base.width }
    : { width: base.width, height: base.height };
}

export const designPageSchema = z.object({
  size: pageSizeSchema,
  orientation: pageOrientationSchema,
});

export const designBorderSchema = z.object({
  style: z.enum(['none', 'single', 'double', 'ornamental']),
  color: hexColorSchema,
  /** Stroke width in points. */
  width: z.number().min(0.25).max(12),
  /** Distance from the page edge in percent of the shorter page side. */
  inset: z.number().min(0).max(10),
});

export const designThemeSchema = z.object({
  backgroundColor: hexColorSchema,
  backgroundImageAssetId: z.uuid().nullable().default(null),
  border: designBorderSchema,
  accentColor: hexColorSchema,
  fontFamily: fontFamilySchema,
});

export const designElementTypeSchema = z.enum([
  'text',
  'image',
  'qr',
  'signature',
  'stamp',
  'line',
  'logo',
]);
export type DesignElementType = z.infer<typeof designElementTypeSchema>;

export const designElementSchema = z
  .object({
    id: z
      .string()
      .regex(/^[a-z0-9][a-z0-9_-]{0,39}$/, 'Use lowercase letters, digits, - or _ (max 40)'),
    type: designElementTypeSchema,
    /** Text with {{placeholders}}; for qr/signature/stamp elements the image placeholder it shows. */
    content: z.string().max(600).default(''),
    /** Uploaded image for image and logo elements. */
    assetId: z.uuid().nullable().default(null),
    x: percent,
    y: percent,
    width: z.number().min(0.5).max(100),
    height: z.number().min(0.2).max(100),
    align: z.enum(['left', 'center', 'right']).default('center'),
    fontSize: z.number().min(5).max(120).default(14),
    fontWeight: z.enum(['normal', 'bold']).default('normal'),
    fontStyle: z.enum(['normal', 'italic']).default('normal'),
    /** Overrides the theme font family. */
    fontFamily: fontFamilySchema.nullable().default(null),
    color: hexColorSchema.default('#1F2937'),
    letterSpacing: z.number().min(0).max(20).default(0),
    uppercase: z.boolean().default(false),
    lineHeight: z.number().min(0.8).max(3).default(1.2),
    /** Line thickness in points (line elements). */
    strokeWidth: z.number().min(0.25).max(10).default(1),
  })
  .superRefine((el, ctx) => {
    const { min, max } = DESIGN_SAFE_AREA;
    const r = (n: number) => Math.round(n * 1000) / 1000;
    if (el.x < min || el.y < min || r(el.x + el.width) > max || r(el.y + el.height) > max) {
      ctx.addIssue({
        code: 'custom',
        path: ['x'],
        message: `Keep the element inside the printable area (${min}%–${max}% of the page).`,
      });
    }
    const placeholders = extractPlaceholders(el.content);
    for (const key of placeholders) {
      if (!PLACEHOLDER_KEY.test(key))
        ctx.addIssue({
          code: 'custom',
          path: ['content'],
          message: `"{{${key}}}" is not a valid placeholder name.`,
        });
    }
    const imagePlaceholder = (allowed: readonly string[]) => {
      const value = el.content.trim();
      const key = placeholders[0];
      if (placeholders.length !== 1 || !key || !allowed.includes(key) || value !== `{{${key}}}`) {
        ctx.addIssue({
          code: 'custom',
          path: ['content'],
          message: `Set the content to ${allowed.map((a) => `{{${a}}}`).join(' or ')}.`,
        });
      }
    };
    switch (el.type) {
      case 'text':
        if (!el.content.trim())
          ctx.addIssue({
            code: 'custom',
            path: ['content'],
            message: 'Text elements need content.',
          });
        for (const key of placeholders) {
          if ((IMAGE_PLACEHOLDERS as readonly string[]).includes(key)) {
            ctx.addIssue({
              code: 'custom',
              path: ['content'],
              message: `{{${key}}} is an image; use a ${key === 'qr_code' ? 'QR' : key.endsWith('signature') ? 'signature' : 'stamp'} element instead.`,
            });
          }
        }
        break;
      case 'qr':
        imagePlaceholder(['qr_code']);
        break;
      case 'signature':
        imagePlaceholder(['signatory_1_signature', 'signatory_2_signature']);
        break;
      case 'stamp':
        imagePlaceholder(['organization_stamp']);
        break;
      case 'image':
      case 'logo':
        if (!el.assetId)
          ctx.addIssue({
            code: 'custom',
            path: ['assetId'],
            message: 'Upload or choose an image for this element.',
          });
        break;
      case 'line':
        break;
    }
  });
export type DesignElement = z.infer<typeof designElementSchema>;

export const templateDesignSchema = z
  .object({
    schemaVersion: z.literal(1).default(1),
    page: designPageSchema,
    theme: designThemeSchema,
    elements: z.array(designElementSchema).max(80),
  })
  .superRefine((design, ctx) => {
    const seen = new Set<string>();
    design.elements.forEach((el, i) => {
      if (seen.has(el.id))
        ctx.addIssue({
          code: 'custom',
          path: ['elements', i, 'id'],
          message: `Element id "${el.id}" is used twice.`,
        });
      seen.add(el.id);
    });
  });
export type TemplateDesign = z.infer<typeof templateDesignSchema>;
export type TemplateDesignInput = z.input<typeof templateDesignSchema>;

/** Placeholders a design uses that are not built in (they must be custom variables of the certification). */
export function customPlaceholdersOf(design: Pick<TemplateDesign, 'elements'>): string[] {
  const keys = new Set<string>();
  for (const el of design.elements) {
    for (const key of extractPlaceholders(el.content))
      if (!isBuiltInPlaceholder(key)) keys.add(key);
  }
  return [...keys].sort();
}

/** Image asset ids referenced by a design (background, image and logo elements). */
export function designAssetIds(design: TemplateDesign): string[] {
  const ids = new Set<string>();
  if (design.theme.backgroundImageAssetId) ids.add(design.theme.backgroundImageAssetId);
  for (const el of design.elements)
    if (el.assetId && (el.type === 'image' || el.type === 'logo')) ids.add(el.assetId);
  return [...ids];
}

// ------------------------------------------------------------------ certification definitions

export const certificationStatusSchema = z.enum(['draft', 'active', 'archived']);
export const approvalPolicySchema = z.enum(['none', 'manager', 'trainer', 'manual_review']);
export type ApprovalPolicy = z.infer<typeof approvalPolicySchema>;

export const validityPolicySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('none') }),
  z.object({ kind: z.literal('months'), months: z.int().min(1).max(240) }),
  z.object({ kind: z.literal('years'), years: z.int().min(1).max(20) }),
  z.object({ kind: z.literal('fixed_date'), date: isoDate }),
]);
export type ValidityPolicy = z.infer<typeof validityPolicySchema>;

export const DEFAULT_REMINDER_OFFSETS = [90, 60, 30, 7];

export const renewalPolicySchema = z.object({
  /** Days before expiry when the renewal window opens (0 = recertify after expiry). */
  windowDays: z.int().min(0).max(365),
  /** Days before expiry when reminders are sent. */
  reminderOffsets: z
    .array(z.int().min(1).max(365))
    .max(10)
    .transform((v) => [...new Set(v)].sort((a, b) => b - a)),
  /** Recertification requirements, counted from the moment the renewal window opens. */
  requirements: ruleSchema,
});
export type RenewalPolicy = z.infer<typeof renewalPolicySchema>;

export const badgeSchema = z.object({
  label: z.string().trim().max(40).nullable(),
  color: hexColorSchema,
  assetId: z.uuid().nullable(),
});
export type Badge = z.infer<typeof badgeSchema>;

export const customVariableSchema = z.object({
  key: customVariableKeySchema,
  label: nameString(80),
  value: z.string().trim().max(300),
});
export type CustomVariable = z.infer<typeof customVariableSchema>;

export const signatorySlotSchema = z.object({
  slot: z.union([z.literal(1), z.literal(2)]),
  signatoryId: z.uuid(),
});

const signatorySlots = z
  .array(signatorySlotSchema)
  .max(2)
  .refine(
    (slots) => new Set(slots.map((s) => s.slot)).size === slots.length,
    'Each signatory slot can be used once',
  )
  .refine(
    (slots) => new Set(slots.map((s) => s.signatoryId)).size === slots.length,
    'Choose two different signatories',
  );

const customVariables = z
  .array(customVariableSchema)
  .max(20)
  .refine(
    (vars) => new Set(vars.map((v) => v.key)).size === vars.length,
    'Custom variable names must be unique',
  );

export const certificationCodeSchema = z
  .string()
  .trim()
  .transform((v) => v.toUpperCase())
  .pipe(z.string().regex(/^[A-Z0-9][A-Z0-9-]{1,19}$/, 'Use 2–20 letters, digits or dashes'));

const certificationFields = {
  name: nameString(160),
  code: certificationCodeSchema,
  publicDescription: optionalText(2000),
  programIds: z.array(z.uuid()).max(20),
  validity: validityPolicySchema,
  renewal: renewalPolicySchema,
  eligibilityRule: ruleSchema,
  approvalPolicy: approvalPolicySchema,
  automaticIssuance: z.boolean(),
  issuingOrganizationName: nameString(160),
  templateId: z.uuid().nullable(),
  badge: badgeSchema,
  publicVerificationEnabled: z.boolean(),
  numberPattern: numberPatternSchema,
  signatories: signatorySlots,
  stampId: z.uuid().nullable(),
  customVariables,
};

const EMPTY_RULE: Rule = { type: 'all', rules: [] };

export const createCertificationRequestSchema = z.object({
  ...certificationFields,
  publicDescription: certificationFields.publicDescription,
  programIds: certificationFields.programIds.default([]),
  validity: certificationFields.validity.default({ kind: 'none' }),
  renewal: renewalPolicySchema.default({
    windowDays: 90,
    reminderOffsets: DEFAULT_REMINDER_OFFSETS,
    requirements: EMPTY_RULE,
  }),
  eligibilityRule: ruleSchema.default(EMPTY_RULE),
  approvalPolicy: approvalPolicySchema.default('none'),
  automaticIssuance: z.boolean().default(true),
  templateId: z.uuid().nullable().default(null),
  badge: badgeSchema.default({ label: null, color: '#B87333', assetId: null }),
  publicVerificationEnabled: z.boolean().default(true),
  numberPattern: numberPatternSchema.default(DEFAULT_NUMBER_PATTERN),
  signatories: signatorySlots.default([]),
  stampId: z.uuid().nullable().default(null),
  customVariables: customVariables.default([]),
});
export type CreateCertificationRequest = z.infer<typeof createCertificationRequestSchema>;

/** Partial update. Fields that are omitted keep their current value. */
export const updateCertificationRequestSchema = z.object(certificationFields).partial();
export type UpdateCertificationRequest = z.infer<typeof updateCertificationRequestSchema>;

export const requirementDescriptionSchema = z.object({
  type: z.string(),
  description: z.string(),
});

export const certificationRefSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  code: z.string(),
});

export const certificationSummarySchema = z.object({
  id: z.uuid(),
  name: z.string(),
  code: z.string(),
  status: certificationStatusSchema,
  publicDescription: z.string().nullable(),
  approvalPolicy: approvalPolicySchema,
  automaticIssuance: z.boolean(),
  validity: validityPolicySchema,
  templateId: z.uuid().nullable(),
  programIds: z.array(z.uuid()),
  badge: badgeSchema,
  requirementCount: z.int(),
  counts: z.object({
    active: z.int(),
    inProgress: z.int(),
    pendingApproval: z.int(),
    eligible: z.int(),
  }),
  updatedAt: isoDateTime,
});
export type CertificationSummary = z.infer<typeof certificationSummarySchema>;

export const certificationDetailSchema = certificationSummarySchema.extend({
  renewal: renewalPolicySchema,
  eligibilityRule: ruleSchema,
  requirements: z.array(requirementDescriptionSchema),
  renewalRequirements: z.array(requirementDescriptionSchema),
  issuingOrganizationName: z.string(),
  publicVerificationEnabled: z.boolean(),
  numberPattern: z.string(),
  numberPreview: z.string(),
  template: z.object({ id: z.uuid(), name: z.string(), currentVersion: z.int() }).nullable(),
  signatories: z.array(
    z.object({
      slot: z.int(),
      id: z.uuid(),
      name: z.string(),
      title: z.string(),
      active: z.boolean(),
    }),
  ),
  stamp: z.object({ id: z.uuid(), name: z.string(), active: z.boolean() }).nullable(),
  customVariables: z.array(customVariableSchema),
  programs: z.array(z.object({ id: z.uuid(), title: z.string().nullable() })),
  revision: z.int(),
  activatedAt: isoDateTime.nullable(),
  archivedAt: isoDateTime.nullable(),
  createdAt: isoDateTime,
  createdBy: personRefSchema.nullable(),
  updatedBy: personRefSchema.nullable(),
});
export type CertificationDetail = z.infer<typeof certificationDetailSchema>;

export const listCertificationsQuerySchema = pageQuerySchema.extend({
  status: queryList(certificationStatusSchema),
});

// ------------------------------------------------------------------ eligibility & progress

export const candidateStatusSchema = z.enum([
  'in_progress',
  'eligible',
  'pending_approval',
  'approved',
  'rejected',
  'issued',
]);
export type CandidateStatus = z.infer<typeof candidateStatusSchema>;

export const requirementProgressSchema = z.object({
  current: z.number(),
  target: z.number(),
  unit: z.enum(['percent', 'count', 'days', 'boolean']),
});

export const requirementItemSchema = z.object({
  key: z.string(),
  type: z.string(),
  description: z.string(),
  satisfied: z.boolean(),
  unknown: z.boolean(),
  progress: requirementProgressSchema.nullable(),
});
export type RequirementItem = z.infer<typeof requirementItemSchema>;

export const progressSchema = z.object({
  definitionId: z.uuid(),
  userId: z.uuid(),
  status: candidateStatusSchema,
  purpose: z.enum(['initial', 'renewal']),
  metCount: z.int(),
  totalCount: z.int(),
  requirements: z.array(requirementItemSchema),
  evaluatedAt: isoDateTime.nullable(),
  eligibleAt: isoDateTime.nullable(),
  onHold: z.boolean(),
  holdReason: z.string().nullable(),
});
export type Progress = z.infer<typeof progressSchema>;

export const progressQuerySchema = z.object({ userId: z.uuid().optional() });

export const candidateSchema = z.object({
  id: z.uuid(),
  user: personRefSchema.extend({ employeeId: z.string().nullable() }),
  definition: certificationRefSchema,
  status: candidateStatusSchema,
  purpose: z.enum(['initial', 'renewal']),
  metCount: z.int(),
  totalCount: z.int(),
  eligibleAt: isoDateTime.nullable(),
  evaluatedAt: isoDateTime.nullable(),
  onHold: z.boolean(),
  holdReason: z.string().nullable(),
  issueError: z.string().nullable(),
});
export type Candidate = z.infer<typeof candidateSchema>;

export const listCandidatesQuerySchema = pageQuerySchema.extend({
  status: queryList(candidateStatusSchema),
  definitionId: z.uuid().optional(),
});

export const reopenCandidateRequestSchema = z.object({ userId: z.uuid(), note: optionalText(500) });

// ------------------------------------------------------------------ approvals

export const approvalStatusSchema = z.enum(['pending', 'approved', 'rejected', 'cancelled']);
export const approvalSchema = z.object({
  id: z.uuid(),
  status: approvalStatusSchema,
  kind: z.enum(['manager', 'trainer', 'manual_review']),
  requestedAt: isoDateTime,
  decidedAt: isoDateTime.nullable(),
  decidedBy: personRefSchema.nullable(),
  comment: z.string().nullable(),
  definition: certificationRefSchema,
  user: personRefSchema.extend({
    employeeId: z.string().nullable(),
    jobTitle: z.string().nullable(),
  }),
  progress: z.object({
    metCount: z.int(),
    totalCount: z.int(),
    requirements: z.array(requirementItemSchema),
  }),
  certificateId: z.uuid().nullable(),
});
export type Approval = z.infer<typeof approvalSchema>;

export const listApprovalsQuerySchema = pageQuerySchema.extend({
  status: queryList(approvalStatusSchema),
  definitionId: z.uuid().optional(),
});

export const decideApprovalRequestSchema = z
  .object({
    decision: z.enum(['approved', 'rejected']),
    comment: optionalText(1000),
  })
  .refine((v) => v.decision === 'approved' || Boolean(v.comment), {
    path: ['comment'],
    message: 'Explain what is still missing so the representative knows what to work on',
  });

// ------------------------------------------------------------------ certificates

export const certificateStatusSchema = z.enum(['issued', 'expired', 'revoked', 'superseded']);
export type CertificateStatus = z.infer<typeof certificateStatusSchema>;
export const issueModeSchema = z.enum(['automatic', 'manual', 'approval', 'reissue', 'renewal']);
export const pdfStatusSchema = z.enum(['pending', 'ready', 'failed']);
export const reissueReasonSchema = z.enum(['corrected_name', 'corrected_data', 'administrative']);

export const certificateSummarySchema = z.object({
  id: z.uuid(),
  certificateNumber: z.string(),
  status: certificateStatusSchema,
  /** `expired` once the expiration date passed, even before the nightly job marks it. */
  effectiveStatus: certificateStatusSchema,
  definition: certificationRefSchema,
  recipient: personRefSchema,
  issuedAt: isoDateTime,
  expiresAt: isoDateTime.nullable(),
  mode: issueModeSchema,
  pdfStatus: pdfStatusSchema,
  revokedAt: isoDateTime.nullable(),
  supersededAt: isoDateTime.nullable(),
});
export type CertificateSummary = z.infer<typeof certificateSummarySchema>;

export const certificateRenewalSchema = z.object({
  id: z.uuid(),
  certificateId: z.uuid(),
  status: z.enum(['open', 'completed', 'lapsed', 'cancelled']),
  windowOpenedAt: isoDateTime,
  dueAt: isoDateTime.nullable(),
  completedAt: isoDateTime.nullable(),
  newCertificateId: z.uuid().nullable(),
});

export const certificateDetailSchema = certificateSummarySchema.extend({
  recipientName: z.string(),
  employeeId: z.string().nullable(),
  issuer: z.string(),
  programNames: z.array(z.string()),
  completionDate: isoDate.nullable(),
  signatories: z.array(z.object({ slot: z.int(), name: z.string(), title: z.string() })),
  template: z.object({ id: z.uuid(), versionId: z.uuid(), version: z.int() }),
  issuedBy: personRefSchema.nullable(),
  overrideReason: z.string().nullable(),
  verificationUrl: z.string(),
  publicVerificationEnabled: z.boolean(),
  pdfGeneratedAt: isoDateTime.nullable(),
  pdfSha256: z.string().nullable(),
  revocation: z
    .object({
      revokedAt: isoDateTime,
      reason: z.string(),
      publicNote: z.string().nullable(),
      revokedBy: personRefSchema.nullable(),
    })
    .nullable(),
  replaces: z
    .object({
      id: z.uuid(),
      certificateNumber: z.string(),
      reasonCode: reissueReasonSchema,
      note: z.string(),
    })
    .nullable(),
  replacedBy: z
    .object({
      id: z.uuid(),
      certificateNumber: z.string(),
      kind: z.enum(['reissue', 'renewal']),
      at: isoDateTime,
    })
    .nullable(),
  renewal: certificateRenewalSchema.nullable(),
});
export type CertificateDetail = z.infer<typeof certificateDetailSchema>;

/** Owner view: no internal override reasons or revocation notes beyond the public note. */
export const ownCertificateDetailSchema = certificateDetailSchema
  .omit({ overrideReason: true, issuedBy: true })
  .extend({
    revocation: z.object({ revokedAt: isoDateTime, publicNote: z.string().nullable() }).nullable(),
  });

export const listCertificatesQuerySchema = pageQuerySchema.extend({
  status: queryList(certificateStatusSchema),
  definitionId: z.uuid().optional(),
  userId: z.uuid().optional(),
  teamId: z.uuid().optional(),
  issuedFrom: isoDate.optional(),
  issuedTo: isoDate.optional(),
  expiringWithinDays: z.coerce.number().int().min(1).max(730).optional(),
});

export const issueCertificateRequestSchema = z.object({
  definitionId: z.uuid(),
  userId: z.uuid(),
  /** Issue although requirements are not met. Requires certifications.update. */
  override: z
    .object({
      reason: z
        .string()
        .trim()
        .min(10, 'Explain why the requirements are being overridden')
        .max(1000),
    })
    .optional(),
});

export const reissueCertificateRequestSchema = z.object({
  reasonCode: reissueReasonSchema,
  note: z.string().trim().min(5, 'Describe what changed').max(1000),
});

export const revokeCertificateRequestSchema = z.object({
  reason: z.string().trim().min(10, 'Explain why the certificate is revoked').max(1000),
  /** Shown on the public verification page. Never include private details. */
  publicNote: optionalText(300),
  /** Must equal `REVOKE <certificate number>`. */
  confirmation: z.string().trim().min(1, 'Type the confirmation phrase').max(120),
});

export function revocationPhrase(certificateNumber: string): string {
  return `REVOKE ${certificateNumber}`;
}

export const downloadLinkSchema = z.object({
  url: z.string(),
  expiresAt: isoDateTime,
  fileName: z.string(),
});

export const certificateEventSchema = z.object({
  id: z.uuid(),
  type: z.string(),
  occurredAt: isoDateTime,
  actor: z.object({ id: z.uuid().nullable(), displayName: z.string().nullable() }),
  data: z.record(z.string(), z.unknown()),
});

export const revocationListItemSchema = z.object({
  certificate: certificateSummarySchema,
  revokedAt: isoDateTime,
  reason: z.string(),
  publicNote: z.string().nullable(),
  revokedBy: personRefSchema.nullable(),
});

export const renewalListItemSchema = certificateRenewalSchema.extend({
  certificate: certificateSummarySchema,
  progress: z
    .object({ status: candidateStatusSchema, metCount: z.int(), totalCount: z.int() })
    .nullable(),
});

export const listRevocationsQuerySchema = pageQuerySchema.extend({
  definitionId: z.uuid().optional(),
});

export const listRenewalsQuerySchema = pageQuerySchema.extend({
  status: queryList(z.enum(['open', 'completed', 'lapsed', 'cancelled'])),
  definitionId: z.uuid().optional(),
});

// ------------------------------------------------------------------ team & dashboard

export const teamFilterSchema = z.enum([
  'certified',
  'not_certified',
  'eligible',
  'pending_approval',
  'expiring',
  'expired',
  'revoked',
]);
export type TeamFilter = z.infer<typeof teamFilterSchema>;
export const teamStateSchema = z.enum([
  'certified',
  'expiring',
  'renewal_required',
  'expired',
  'revoked',
  'pending_approval',
  'eligible',
  'in_progress',
]);

export type TeamState = z.infer<typeof teamStateSchema>;

export const teamStatusQuerySchema = pageQuerySchema.extend({
  definitionId: z.uuid().optional(),
  teamId: z.uuid().optional(),
  filter: teamFilterSchema.optional(),
  expiringWithinDays: z.coerce.number().int().min(1).max(365).default(60),
});

export const teamStatusRowSchema = z.object({
  user: personRefSchema.extend({
    employeeId: z.string().nullable(),
    jobTitle: z.string().nullable(),
  }),
  definition: certificationRefSchema,
  state: teamStateSchema,
  candidateStatus: candidateStatusSchema.nullable(),
  metCount: z.int(),
  totalCount: z.int(),
  certificate: z
    .object({
      id: z.uuid(),
      certificateNumber: z.string(),
      status: certificateStatusSchema,
      issuedAt: isoDateTime,
      expiresAt: isoDateTime.nullable(),
    })
    .nullable(),
});

export type TeamStatusRow = z.infer<typeof teamStatusRowSchema>;

export const dashboardSchema = z.object({
  issued: z.int(),
  active: z.int(),
  expiring: z.object({ within30: z.int(), within60: z.int(), within90: z.int() }),
  pendingApprovals: z.int(),
  eligible: z.int(),
  revokedThisMonth: z.int(),
  renewalsOpen: z.int(),
  pdfFailed: z.int(),
});
export type Dashboard = z.infer<typeof dashboardSchema>;

// ------------------------------------------------------------------ learner

export const myCertificationStateSchema = z.enum([
  'active',
  'expiring',
  'renewal_required',
  'pending_approval',
  'eligible',
  'in_progress',
  'expired',
  'revoked',
]);

export const myCertificationsSchema = z.object({
  items: z.array(
    z.object({
      definition: certificationRefSchema.extend({
        publicDescription: z.string().nullable(),
        badge: badgeSchema,
      }),
      state: myCertificationStateSchema,
      certificate: certificateSummarySchema.nullable(),
      progress: progressSchema.nullable(),
      renewal: certificateRenewalSchema.nullable(),
      verificationUrl: z.string().nullable(),
    }),
  ),
  certificates: z.array(certificateSummarySchema),
});
export type MyCertifications = z.infer<typeof myCertificationsSchema>;

// ------------------------------------------------------------------ public verification

export const verificationTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{32,64}$/);

/** Allow-listed public DTO: never contact details, scores, transcripts or internal notes. */
export const publicVerificationSchema = z.object({
  status: z.enum(['valid', 'expired', 'revoked', 'superseded']),
  recipientName: z.string(),
  certificationName: z.string(),
  issuer: z.string(),
  issuedAt: isoDate,
  expiresAt: isoDate.nullable(),
  certificateNumber: z.string().nullable(),
  revokedAt: isoDate.nullable(),
  revocationNote: z.string().nullable(),
  checkedAt: isoDateTime,
});
export type PublicVerification = z.infer<typeof publicVerificationSchema>;

// ------------------------------------------------------------------ templates

export const templateStatusSchema = z.enum(['active', 'archived']);
export const templateStarterKeySchema = z.enum(['classic', 'modern']);

export const templateSummarySchema = z.object({
  id: z.uuid(),
  name: z.string(),
  description: z.string().nullable(),
  status: templateStatusSchema,
  isDefault: z.boolean(),
  currentVersion: z.int(),
  page: designPageSchema,
  usedBy: z.array(certificationRefSchema),
  clonedFromId: z.uuid().nullable(),
  updatedAt: isoDateTime,
});

export const templateDetailSchema = templateSummarySchema.extend({
  versionId: z.uuid(),
  design: templateDesignSchema,
  customPlaceholders: z.array(z.string()),
  createdAt: isoDateTime,
  createdBy: personRefSchema.nullable(),
  updatedBy: personRefSchema.nullable(),
});

export const templateVersionSchema = z.object({
  id: z.uuid(),
  version: z.int(),
  changeNote: z.string().nullable(),
  createdAt: isoDateTime,
  createdBy: personRefSchema.nullable(),
});
export const templateVersionDetailSchema = templateVersionSchema.extend({
  design: templateDesignSchema,
});

export const templateStarterSchema = z.object({
  key: templateStarterKeySchema,
  name: z.string(),
  description: z.string(),
  design: templateDesignSchema,
});

export const listTemplatesQuerySchema = pageQuerySchema.extend({
  status: queryList(templateStatusSchema),
});

export const createTemplateRequestSchema = z
  .object({
    name: nameString(120),
    description: optionalText(500),
    starter: templateStarterKeySchema.optional(),
    design: templateDesignSchema.optional(),
  })
  .refine((v) => !(v.starter && v.design), {
    path: ['design'],
    message: 'Choose a starter design or provide a design, not both',
  });

export const updateTemplateRequestSchema = z.object({
  name: nameString(120).optional(),
  description: optionalText(500),
});
export const updateTemplateDesignRequestSchema = z.object({
  design: templateDesignSchema,
  changeNote: optionalText(300),
});
export const cloneTemplateRequestSchema = z.object({ name: nameString(120) });
export const assignTemplateRequestSchema = z.object({
  certificationIds: z.array(z.uuid()).min(1).max(50),
});

export const previewTemplateRequestSchema = z.object({
  /** Unsaved design from the designer; defaults to the current version. */
  design: templateDesignSchema.optional(),
  /** Use this certification's name, signatories, stamp and custom variables as sample data. */
  certificationId: z.uuid().optional(),
});

export const resolvedElementSchema = z.object({
  id: z.string(),
  type: designElementTypeSchema,
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
  text: z.string().nullable(),
  imageUrl: z.string().nullable(),
  qrValue: z.string().nullable(),
  align: z.enum(['left', 'center', 'right']),
  fontSize: z.number(),
  fontWeight: z.enum(['normal', 'bold']),
  fontStyle: z.enum(['normal', 'italic']),
  fontFamily: fontFamilySchema,
  cssFontFamily: z.string(),
  color: z.string(),
  letterSpacing: z.number(),
  uppercase: z.boolean(),
  lineHeight: z.number(),
  strokeWidth: z.number(),
});

export const templatePreviewSchema = z.object({
  pdfUrl: z.string(),
  expiresAt: isoDateTime,
  page: z.object({
    size: pageSizeSchema,
    orientation: pageOrientationSchema,
    widthPt: z.number(),
    heightPt: z.number(),
  }),
  theme: designThemeSchema.extend({ backgroundImageUrl: z.string().nullable() }),
  elements: z.array(resolvedElementSchema),
  sampleValues: z.record(z.string(), z.string()),
  warnings: z.array(z.string()),
});

// ------------------------------------------------------------------ signatories, stamps & assets

export const imageVersionSchema = z.object({
  id: z.uuid(),
  version: z.int(),
  assetId: z.uuid(),
  contentType: z.enum(['image/png', 'image/jpeg']),
  width: z.int(),
  height: z.int(),
  byteSize: z.int(),
  sha256: z.string(),
  uploadedAt: isoDateTime,
  uploadedBy: personRefSchema.nullable(),
  previewUrl: z.string().nullable(),
});

const dateRange = <T extends z.ZodRawShape>(shape: T) =>
  z.object(shape).refine(
    (v) => {
      const from = (v as { effectiveFrom?: string | null }).effectiveFrom;
      const to = (v as { effectiveTo?: string | null }).effectiveTo;
      return !from || !to || from <= to;
    },
    { path: ['effectiveTo'], message: 'The end date must be on or after the start date' },
  );

export const signatorySchema = z.object({
  id: z.uuid(),
  name: z.string(),
  title: z.string(),
  department: z.string().nullable(),
  userId: z.uuid().nullable(),
  active: z.boolean(),
  effectiveFrom: isoDate.nullable(),
  effectiveTo: isoDate.nullable(),
  /** Empty means every certification may use this signatory. */
  allowedCertificationIds: z.array(z.uuid()),
  currentSignature: imageVersionSchema.nullable(),
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
  createdBy: personRefSchema.nullable(),
  updatedBy: personRefSchema.nullable(),
});
export type Signatory = z.infer<typeof signatorySchema>;

export const createSignatoryRequestSchema = dateRange({
  name: nameString(120),
  title: nameString(120),
  department: optionalText(120),
  userId: z.uuid().nullable().optional(),
  active: z.boolean().default(true),
  effectiveFrom: isoDate.nullable().optional(),
  effectiveTo: isoDate.nullable().optional(),
  allowedCertificationIds: z.array(z.uuid()).max(100).default([]),
});

export const updateSignatoryRequestSchema = dateRange({
  name: nameString(120).optional(),
  title: nameString(120).optional(),
  department: optionalText(120),
  userId: z.uuid().nullable().optional(),
  active: z.boolean().optional(),
  effectiveFrom: isoDate.nullable().optional(),
  effectiveTo: isoDate.nullable().optional(),
  allowedCertificationIds: z.array(z.uuid()).max(100).optional(),
});

export const stampKindSchema = z.enum(['company', 'certification', 'department']);

export const stampSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  kind: stampKindSchema,
  departmentName: z.string().nullable(),
  active: z.boolean(),
  effectiveFrom: isoDate.nullable(),
  effectiveTo: isoDate.nullable(),
  allowedCertificationIds: z.array(z.uuid()),
  currentImage: imageVersionSchema.nullable(),
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
  createdBy: personRefSchema.nullable(),
  updatedBy: personRefSchema.nullable(),
});
export type Stamp = z.infer<typeof stampSchema>;

export const createStampRequestSchema = dateRange({
  name: nameString(120),
  kind: stampKindSchema,
  departmentName: optionalText(120),
  active: z.boolean().default(true),
  effectiveFrom: isoDate.nullable().optional(),
  effectiveTo: isoDate.nullable().optional(),
  allowedCertificationIds: z.array(z.uuid()).max(100).default([]),
});

export const updateStampRequestSchema = dateRange({
  name: nameString(120).optional(),
  kind: stampKindSchema.optional(),
  departmentName: optionalText(120),
  active: z.boolean().optional(),
  effectiveFrom: isoDate.nullable().optional(),
  effectiveTo: isoDate.nullable().optional(),
  allowedCertificationIds: z.array(z.uuid()).max(100).optional(),
});

export const listSignatoriesQuerySchema = pageQuerySchema.extend({
  active: z.enum(['true', 'false']).optional(),
});

export const assetPurposeSchema = z.enum(['background', 'logo', 'badge', 'signature', 'stamp']);
export const uploadImageQuerySchema = z.object({
  purpose: z.enum(['background', 'logo', 'badge']),
});

export const assetSchema = z.object({
  id: z.uuid(),
  purpose: assetPurposeSchema,
  contentType: z.enum(['image/png', 'image/jpeg']),
  width: z.int(),
  height: z.int(),
  byteSize: z.int(),
  sha256: z.string(),
  createdAt: isoDateTime,
  previewUrl: z.string(),
});

/** Upload limits per purpose. Uploads are PNG or JPEG only (no SVG). */
export const IMAGE_UPLOAD_RULES = {
  signature: {
    maxBytes: 2 * 1024 * 1024,
    minWidth: 200,
    minHeight: 60,
    maxWidth: 4000,
    maxHeight: 2000,
    minAspect: 1.2,
    maxAspect: 10,
  },
  stamp: {
    maxBytes: 2 * 1024 * 1024,
    minWidth: 150,
    minHeight: 150,
    maxWidth: 3000,
    maxHeight: 3000,
    minAspect: 0.5,
    maxAspect: 2,
  },
  background: {
    maxBytes: 10 * 1024 * 1024,
    minWidth: 600,
    minHeight: 600,
    maxWidth: 4000,
    maxHeight: 4000,
    minAspect: 0.4,
    maxAspect: 2.5,
  },
  logo: {
    maxBytes: 2 * 1024 * 1024,
    minWidth: 64,
    minHeight: 64,
    maxWidth: 4000,
    maxHeight: 4000,
    minAspect: 0.2,
    maxAspect: 8,
  },
  badge: {
    maxBytes: 2 * 1024 * 1024,
    minWidth: 64,
    minHeight: 64,
    maxWidth: 2000,
    maxHeight: 2000,
    minAspect: 0.5,
    maxAspect: 2,
  },
} as const satisfies Record<
  z.infer<typeof assetPurposeSchema>,
  {
    maxBytes: number;
    minWidth: number;
    minHeight: number;
    maxWidth: number;
    maxHeight: number;
    minAspect: number;
    maxAspect: number;
  }
>;

// ------------------------------------------------------------------ settings

export const certificationSettingsSchema = z.object({
  /** Value of the {ORG} numbering token. Null derives it from the issuing organization name. */
  organizationCode: z
    .string()
    .regex(/^[A-Z0-9]{1,10}$/)
    .nullable(),
  /** Base URL printed on certificates and encoded in QR codes; null uses the web app URL. */
  verificationBaseUrl: z.url().nullable(),
  effectiveVerificationBaseUrl: z.string(),
  recipientNameDisplay: z.enum(['full_name', 'first_name_last_initial']),
  showCertificateNumber: z.boolean(),
  showExpirationDate: z.boolean(),
  /** IANA time zone used for dates printed on certificates. */
  timezone: z.string(),
  updatedAt: isoDateTime.nullable(),
});
export type CertificationSettings = z.infer<typeof certificationSettingsSchema>;

export const updateCertificationSettingsRequestSchema = z.object({
  organizationCode: z
    .string()
    .trim()
    .transform((v) => v.toUpperCase())
    .pipe(z.string().regex(/^[A-Z0-9]{1,10}$/, 'Use 1–10 letters or digits'))
    .nullable()
    .optional(),
  verificationBaseUrl: z
    .url()
    .refine((v) => /^https?:\/\//.test(v), 'Use an http(s) URL')
    .transform((v) => v.replace(/\/+$/, ''))
    .nullable()
    .optional(),
  recipientNameDisplay: z.enum(['full_name', 'first_name_last_initial']).optional(),
  showCertificateNumber: z.boolean().optional(),
  showExpirationDate: z.boolean().optional(),
  timezone: z
    .string()
    .refine((tz) => {
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: tz });
        return true;
      } catch {
        return false;
      }
    }, 'Choose a valid IANA time zone such as America/Chicago')
    .optional(),
});

export const certificateSummaryPageSchema = pageSchema(certificateSummarySchema);
export const candidatePageSchema = pageSchema(candidateSchema);
export const approvalPageSchema = pageSchema(approvalSchema);
export const teamStatusPageSchema = pageSchema(teamStatusRowSchema);
export const certificationSummaryPageSchema = pageSchema(certificationSummarySchema);
export const templateSummaryPageSchema = pageSchema(templateSummarySchema);
export const signatoryPageSchema = pageSchema(signatorySchema);
export const stampPageSchema = pageSchema(stampSchema);
export const revocationPageSchema = pageSchema(revocationListItemSchema);
export const renewalPageSchema = pageSchema(renewalListItemSchema);
