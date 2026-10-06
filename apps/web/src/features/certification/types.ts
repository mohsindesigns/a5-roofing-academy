import type { z } from 'zod';
import type { certification as c } from '@a5/contracts';

/**
 * Response shapes of the certification API. Schemas live in `@a5/contracts`; these aliases keep
 * component signatures short.
 */
export type MyCertifications = c.MyCertifications;
export type MyCertificationItem = MyCertifications['items'][number];
export type MyCertificationState = MyCertificationItem['state'];
export type OwnCertificate = z.infer<typeof c.ownCertificateDetailSchema>;
export type CertificateSummary = c.CertificateSummary;
export type CertificateDetail = c.CertificateDetail;
export type CertificateEvent = z.infer<typeof c.certificateEventSchema>;
export type DownloadLink = z.infer<typeof c.downloadLinkSchema>;
export type Approval = c.Approval;
export type Candidate = c.Candidate;
export type TeamStatusRow = c.TeamStatusRow;
export type TeamState = c.TeamState;
export type Dashboard = c.Dashboard;
export type Progress = c.Progress;
export type RequirementItem = c.RequirementItem;
export type CertificationSummary = c.CertificationSummary;
export type CertificationDetail = c.CertificationDetail;
export type RevocationItem = z.infer<typeof c.revocationListItemSchema>;
export type RenewalItem = z.infer<typeof c.renewalListItemSchema>;
export type TemplateSummary = z.infer<typeof c.templateSummarySchema>;
export type TemplateDetail = z.infer<typeof c.templateDetailSchema>;
export type TemplateVersion = z.infer<typeof c.templateVersionSchema>;
export type TemplateVersionDetail = z.infer<typeof c.templateVersionDetailSchema>;
export type TemplateStarter = z.infer<typeof c.templateStarterSchema>;
export type TemplatePreview = z.infer<typeof c.templatePreviewSchema>;
export type ResolvedElement = z.infer<typeof c.resolvedElementSchema>;
export type Signatory = c.Signatory;
export type Stamp = c.Stamp;
export type ImageVersion = z.infer<typeof c.imageVersionSchema>;
export type CertificationAsset = z.infer<typeof c.assetSchema>;
export type CertificationSettings = c.CertificationSettings;
export type PublicVerification = c.PublicVerification;
export type TemplateDesign = c.TemplateDesign;
export type TemplateDesignInput = c.TemplateDesignInput;
export type DesignElement = c.DesignElement;
export type ReissueReason = z.infer<typeof c.reissueReasonSchema>;
export type StarterKey = z.infer<typeof c.templateStarterKeySchema>;
export type CandidateStatus = c.CandidateStatus;
export type CertificationStatus = z.infer<typeof c.certificationStatusSchema>;
