import type { Generated, InboxSchema, OutboxSchema } from '@a5/database';
import type { DirectorySchema } from '@a5/directory';
import type { Rule } from '@a5/rules';
import type { certification } from '@a5/contracts';
import type { CertificateSnapshotData } from '../issuance/snapshot.js';

type ValidityPolicy = certification.ValidityPolicy;
type Badge = certification.Badge;
type CustomVariable = certification.CustomVariable;
type TemplateDesign = certification.TemplateDesign;
type RequirementItem = certification.RequirementItem;

export interface RenewalPolicyColumn {
  windowDays: number;
  reminderOffsets: number[];
  requirements: Rule;
}

export interface CertificationSettingsTable {
  organization_id: string;
  organization_code: string | null;
  verification_base_url: string | null;
  recipient_name_display: 'full_name' | 'first_name_last_initial';
  show_certificate_number: boolean;
  show_expiration_date: boolean;
  timezone: string;
  updated_at: Generated<Date>;
  updated_by: string | null;
}

export type AssetPurpose = 'signature' | 'stamp' | 'background' | 'logo' | 'badge';

export interface CertificationAssetsTable {
  id: string;
  organization_id: string;
  purpose: AssetPurpose;
  storage_key: string;
  content_type: 'image/png' | 'image/jpeg';
  byte_size: number;
  width: number;
  height: number;
  sha256: string;
  original_filename: string | null;
  created_at: Generated<Date>;
  created_by: string | null;
  created_by_name: string | null;
}

export interface CertificateTemplatesTable {
  id: string;
  organization_id: string;
  name: string;
  description: string | null;
  status: 'active' | 'archived';
  is_default: boolean;
  current_version: number;
  cloned_from_id: string | null;
  archived_at: Date | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  created_by: string | null;
  created_by_name: string | null;
  updated_by: string | null;
  updated_by_name: string | null;
}

export interface CertificateTemplateVersionsTable {
  id: string;
  template_id: string;
  version: number;
  design: TemplateDesign;
  change_note: string | null;
  created_at: Generated<Date>;
  created_by: string | null;
  created_by_name: string | null;
}

export interface SignatoriesTable {
  id: string;
  organization_id: string;
  user_id: string | null;
  name: string;
  title: string;
  department: string | null;
  active: boolean;
  effective_from: string | null;
  effective_to: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  created_by: string | null;
  created_by_name: string | null;
  updated_by: string | null;
  updated_by_name: string | null;
}

export interface SignatorySignaturesTable {
  id: string;
  signatory_id: string;
  version: number;
  asset_id: string;
  created_at: Generated<Date>;
  created_by: string | null;
  created_by_name: string | null;
}

export interface SignatoryCertificationsTable {
  signatory_id: string;
  definition_id: string;
}

export interface StampsTable {
  id: string;
  organization_id: string;
  name: string;
  kind: 'company' | 'certification' | 'department';
  department_name: string | null;
  active: boolean;
  effective_from: string | null;
  effective_to: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  created_by: string | null;
  created_by_name: string | null;
  updated_by: string | null;
  updated_by_name: string | null;
}

export interface StampImagesTable {
  id: string;
  stamp_id: string;
  version: number;
  asset_id: string;
  created_at: Generated<Date>;
  created_by: string | null;
  created_by_name: string | null;
}

export interface StampCertificationsTable {
  stamp_id: string;
  definition_id: string;
}

export type DefinitionStatus = 'draft' | 'active' | 'archived';
export type ApprovalPolicy = 'none' | 'manager' | 'trainer' | 'manual_review';

export interface CertificationDefinitionsTable {
  id: string;
  organization_id: string;
  name: string;
  code: string;
  public_description: string | null;
  status: DefinitionStatus;
  validity_policy: ValidityPolicy;
  renewal_policy: RenewalPolicyColumn;
  eligibility_rule: Rule;
  approval_policy: ApprovalPolicy;
  automatic_issuance: boolean;
  issuing_organization_name: string;
  template_id: string | null;
  stamp_id: string | null;
  badge: Badge;
  public_verification_enabled: boolean;
  number_pattern: string;
  custom_variables: CustomVariable[];
  revision: Generated<number>;
  activated_at: Date | null;
  archived_at: Date | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  created_by: string | null;
  created_by_name: string | null;
  updated_by: string | null;
  updated_by_name: string | null;
}

export interface CertificationProgramsTable {
  definition_id: string;
  program_id: string;
}

export interface CertificationSignatorySlotsTable {
  definition_id: string;
  slot: number;
  signatory_id: string;
}

export interface CertificateNumberSequencesTable {
  definition_id: string;
  last_value: Generated<number>;
  updated_at: Generated<Date>;
}

// ---------------------------------------------------------------- fact projections

export interface ProgramCatalogTable {
  program_id: string;
  organization_id: string | null;
  title: string;
  version: number;
  phases: Array<{ phaseId: string; title: string; position: number }>;
  archived: boolean;
  updated_at: Generated<Date>;
}

export interface ProgramAssessmentsTable {
  program_id: string;
  assessment_id: string;
  lesson_id: string | null;
  kind: 'quiz' | 'exam' | 'final' | 'practice';
  required: boolean;
  title: string;
}

export interface LearnerProgramStatusTable {
  user_id: string;
  program_id: string;
  organization_id: string;
  enrollment_id: string | null;
  status: 'enrolled' | 'completed' | 'withdrawn';
  progress_percent: number;
  enrolled_at: Date | null;
  completed_at: Date | null;
  /** occurredAt of the newest applied event; older events are ignored. */
  source_occurred_at: Date;
  updated_at: Generated<Date>;
}

export interface LearnerMilestonesTable {
  user_id: string;
  kind: 'lesson' | 'phase';
  ref_id: string;
  program_id: string | null;
  title: string | null;
  completed_at: Date;
}

export interface LearnerAssessmentResultsTable {
  attempt_id: string;
  user_id: string;
  organization_id: string;
  assessment_id: string;
  kind: 'quiz' | 'exam' | 'final' | 'practice';
  title: string;
  score_percent: number;
  passed: boolean;
  program_id: string | null;
  graded_at: Date;
}

export interface LearnerAiResultsTable {
  session_id: string;
  user_id: string;
  organization_id: string;
  scenario_id: string;
  scenario_title: string;
  overall_score: number;
  passed: boolean;
  program_id: string | null;
  evaluated_at: Date;
}

// ---------------------------------------------------------------- eligibility & approvals

export type CandidateStatus =
  'in_progress' | 'eligible' | 'pending_approval' | 'approved' | 'rejected' | 'issued';

export interface CertificationCandidatesTable {
  id: string;
  organization_id: string;
  definition_id: string;
  user_id: string;
  status: CandidateStatus;
  purpose: 'initial' | 'renewal';
  cycle: number;
  renewal_id: string | null;
  requirements: RequirementItem[];
  met_count: number;
  total_count: number;
  auto_requirements_met: boolean;
  evaluated_at: Date | null;
  eligible_at: Date | null;
  /** Cycle in which certificate.eligible was emitted (once per cycle). */
  eligible_cycle: number | null;
  rejected_at: Date | null;
  hold_reason: string | null;
  held_at: Date | null;
  issue_error: string | null;
  certificate_id: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface EligibilityDirtyTable {
  definition_id: string;
  user_id: string;
  organization_id: string;
  marked_at: Generated<Date>;
  learner_activity: boolean;
}

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'cancelled';

export interface CertificateApprovalsTable {
  id: string;
  organization_id: string;
  candidate_id: string;
  definition_id: string;
  user_id: string;
  cycle: number;
  kind: 'manager' | 'trainer' | 'manual_review';
  status: ApprovalStatus;
  requested_at: Generated<Date>;
  decided_at: Date | null;
  decided_by: string | null;
  decided_by_name: string | null;
  comment: string | null;
}

// ---------------------------------------------------------------- issued certificates

export type CertificateStatus = 'issued' | 'expired' | 'revoked' | 'superseded';
export type IssueMode = 'automatic' | 'manual' | 'approval' | 'reissue' | 'renewal';

export interface IssuedCertificatesTable {
  id: string;
  organization_id: string;
  definition_id: string;
  user_id: string;
  candidate_id: string | null;
  certificate_number: string;
  verification_token: string;
  status: CertificateStatus;
  mode: IssueMode;
  issued_at: Date;
  expires_at: Date | null;
  issued_by: string | null;
  issued_by_name: string | null;
  override_reason: string | null;
  template_id: string;
  template_version_id: string;
  pdf_status: 'pending' | 'ready' | 'failed';
  pdf_storage_key: string | null;
  pdf_sha256: string | null;
  pdf_byte_size: number | null;
  pdf_generated_at: Date | null;
  pdf_attempts: Generated<number>;
  pdf_error: string | null;
  expired_at: Date | null;
  revoked_at: Date | null;
  superseded_at: Date | null;
  superseded_by_id: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface CertificateSnapshotsTable {
  certificate_id: string;
  schema_version: number;
  data: CertificateSnapshotData;
  created_at: Generated<Date>;
}

export interface CertificateRevocationsTable {
  id: string;
  certificate_id: string;
  reason: string;
  public_note: string | null;
  revoked_at: Date;
  revoked_by: string | null;
  revoked_by_name: string | null;
}

export interface CertificateReissuesTable {
  id: string;
  original_certificate_id: string;
  new_certificate_id: string;
  reason_code: 'corrected_name' | 'corrected_data' | 'administrative';
  note: string;
  reissued_at: Date;
  reissued_by: string | null;
  reissued_by_name: string | null;
}

export interface CertificateRenewalsTable {
  id: string;
  organization_id: string;
  certificate_id: string;
  definition_id: string;
  user_id: string;
  status: 'open' | 'completed' | 'lapsed' | 'cancelled';
  window_opened_at: Date;
  due_at: Date | null;
  completed_at: Date | null;
  new_certificate_id: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface CertificateRemindersTable {
  certificate_id: string;
  offset_days: number;
  days_remaining: number;
  sent: boolean;
  created_at: Generated<Date>;
}

export interface CertificateEventsTable {
  id: string;
  organization_id: string;
  certificate_id: string;
  type: string;
  actor_id: string | null;
  actor_name: string | null;
  data: Record<string, unknown>;
  occurred_at: Generated<Date>;
}

export interface CertificationDatabase extends OutboxSchema, InboxSchema, DirectorySchema {
  certification_settings: CertificationSettingsTable;
  certification_assets: CertificationAssetsTable;
  certificate_templates: CertificateTemplatesTable;
  certificate_template_versions: CertificateTemplateVersionsTable;
  signatories: SignatoriesTable;
  signatory_signatures: SignatorySignaturesTable;
  signatory_certifications: SignatoryCertificationsTable;
  stamps: StampsTable;
  stamp_images: StampImagesTable;
  stamp_certifications: StampCertificationsTable;
  certification_definitions: CertificationDefinitionsTable;
  certification_programs: CertificationProgramsTable;
  certification_signatory_slots: CertificationSignatorySlotsTable;
  certificate_number_sequences: CertificateNumberSequencesTable;
  program_catalog: ProgramCatalogTable;
  program_assessments: ProgramAssessmentsTable;
  learner_program_status: LearnerProgramStatusTable;
  learner_milestones: LearnerMilestonesTable;
  learner_assessment_results: LearnerAssessmentResultsTable;
  learner_ai_results: LearnerAiResultsTable;
  certification_candidates: CertificationCandidatesTable;
  eligibility_dirty: EligibilityDirtyTable;
  certificate_approvals: CertificateApprovalsTable;
  issued_certificates: IssuedCertificatesTable;
  certificate_snapshots: CertificateSnapshotsTable;
  certificate_revocations: CertificateRevocationsTable;
  certificate_reissues: CertificateReissuesTable;
  certificate_renewals: CertificateRenewalsTable;
  certificate_reminders: CertificateRemindersTable;
  certificate_events: CertificateEventsTable;
}
