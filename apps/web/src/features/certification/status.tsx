import { StatusText } from '@/components/ui';
import {
  APPROVAL_STATUS,
  CANDIDATE_STATUS,
  CERTIFICATE_STATUS,
  CERTIFICATION_STATUS,
  MY_STATE,
  PDF_STATUS,
  TEAM_STATE,
  type StatusInfo,
} from './labels';
import type {
  Approval,
  CandidateStatus,
  CertificateSummary,
  CertificationStatus,
  MyCertificationState,
  TeamState,
} from './types';

function Status({ info }: { info: StatusInfo }) {
  return <StatusText tone={info.tone}>{info.label}</StatusText>;
}

export function CertificateStatus({ status }: { status: CertificateSummary['effectiveStatus'] }) {
  return <Status info={CERTIFICATE_STATUS[status]} />;
}

export function MyStateStatus({ state }: { state: MyCertificationState }) {
  return <Status info={MY_STATE[state]} />;
}

export function TeamStateStatus({ state }: { state: TeamState }) {
  return <Status info={TEAM_STATE[state]} />;
}

export function CandidateStatusText({ status }: { status: CandidateStatus }) {
  return <Status info={CANDIDATE_STATUS[status]} />;
}

export function ApprovalStatusText({ status }: { status: Approval['status'] }) {
  return <Status info={APPROVAL_STATUS[status]} />;
}

export function PdfStatusText({ status }: { status: CertificateSummary['pdfStatus'] }) {
  return <Status info={PDF_STATUS[status]} />;
}

export function DefinitionStatusText({ status }: { status: CertificationStatus }) {
  return <Status info={CERTIFICATION_STATUS[status]} />;
}
