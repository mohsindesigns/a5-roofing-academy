/** BullMQ queues owned by certification-service. */
export const QUEUES = {
  pdf: 'certification.pdf',
  expiry: 'certification.expiry',
  reminders: 'certification.reminders',
} as const;

export interface PdfJobData {
  certificateId: string;
}
