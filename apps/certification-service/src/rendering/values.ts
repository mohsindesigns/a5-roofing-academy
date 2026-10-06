import { formatLongDate } from '../common/dates.js';

export interface PlaceholderInput {
  certificateName: string;
  recipientName: string;
  employeeId: string | null;
  programNames: string[];
  completionDate: Date | null;
  issuedAt: Date;
  expiresAt: Date | null;
  certificateNumber: string;
  verificationUrl: string;
  organizationName: string;
  signatories: Array<{ slot: number; name: string; title: string }>;
  customVariables: Readonly<Record<string, string>>;
  timezone: string;
}

function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** Text value of every placeholder. Image placeholders resolve to empty text. */
export function placeholderValues(input: PlaceholderInput): Record<string, string> {
  const slot = (n: number) => input.signatories.find((s) => s.slot === n);
  return {
    ...input.customVariables,
    certificate_name: input.certificateName,
    recipient_name: input.recipientName,
    employee_id: input.employeeId ?? '',
    program_name: joinNames(input.programNames),
    completion_date: formatLongDate(input.completionDate ?? input.issuedAt, input.timezone),
    issue_date: formatLongDate(input.issuedAt, input.timezone),
    expiration_date: input.expiresAt
      ? formatLongDate(input.expiresAt, input.timezone)
      : 'No expiration',
    certificate_number: input.certificateNumber,
    verification_url: input.verificationUrl,
    organization_name: input.organizationName,
    signatory_1_name: slot(1)?.name ?? '',
    signatory_1_title: slot(1)?.title ?? '',
    signatory_2_name: slot(2)?.name ?? '',
    signatory_2_title: slot(2)?.title ?? '',
    qr_code: '',
    signatory_1_signature: '',
    signatory_2_signature: '',
    organization_stamp: '',
  };
}
