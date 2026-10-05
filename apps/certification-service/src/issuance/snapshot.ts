import type { certification } from '@a5/contracts';

/** A stored image the certificate owns (copied under the certificate's storage prefix). */
export interface SnapshotImage {
  key: string;
  contentType: 'image/png' | 'image/jpeg';
  sha256: string;
  width: number;
  height: number;
}

/**
 * Everything needed to render a certificate, frozen at issuance. Rendering never reads live
 * definitions, templates, signatories or stamps, so later edits cannot change issued certificates.
 */
export interface CertificateSnapshotData {
  schemaVersion: 1;
  certificateId: string;
  certificateNumber: string;
  verificationUrl: string;
  recipient: {
    userId: string;
    legalName: string;
    firstName: string;
    lastName: string;
    employeeId: string | null;
    source: 'identity' | 'directory';
  };
  certification: {
    definitionId: string;
    name: string;
    code: string;
    publicDescription: string | null;
    issuingOrganizationName: string;
    revision: number;
  };
  programs: Array<{ id: string; title: string | null }>;
  dates: {
    issuedAt: string;
    expiresAt: string | null;
    completionDate: string | null;
    timezone: string;
  };
  template: {
    templateId: string;
    versionId: string;
    version: number;
    design: certification.TemplateDesign;
  };
  signatories: Array<{
    slot: number;
    signatoryId: string;
    name: string;
    title: string;
    department: string | null;
    signatureVersionId: string | null;
    image: SnapshotImage | null;
  }>;
  stamp: {
    stampId: string;
    name: string;
    kind: string;
    imageVersionId: string | null;
    image: SnapshotImage | null;
  } | null;
  /** Template images (background, logos) by asset id. */
  assets: Record<string, SnapshotImage>;
  customVariables: Record<string, string>;
  /** Fully resolved text values for every placeholder. */
  placeholders: Record<string, string>;
}

export const SNAPSHOT_SCHEMA_VERSION = 1;
