import { createHash } from 'node:crypto';
import type { ObjectStorage } from '@a5/storage';
import type { CertificateSnapshotData, SnapshotImage } from '../issuance/snapshot.js';
import { renderCertificatePdf } from './renderer.js';

async function loadImage(storage: ObjectStorage, image: SnapshotImage | null | undefined): Promise<Buffer | null> {
  if (!image) return null;
  const bytes = await storage.getBytes(image.key);
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== image.sha256) throw new Error(`Snapshot image ${image.key} does not match its recorded checksum`);
  return bytes;
}

/**
 * Render an issued certificate purely from its immutable snapshot and the image copies stored under
 * the certificate's own prefix. Live templates, signatures and stamps are never read here.
 */
export async function renderSnapshotPdf(storage: ObjectStorage, snapshot: CertificateSnapshotData): Promise<Buffer> {
  const slot = (n: number) => snapshot.signatories.find((s) => s.slot === n)?.image ?? null;
  const [signature1, signature2, stamp, assetEntries] = await Promise.all([
    loadImage(storage, slot(1)),
    loadImage(storage, slot(2)),
    loadImage(storage, snapshot.stamp?.image),
    Promise.all(Object.entries(snapshot.assets).map(async ([id, img]) => [id, (await loadImage(storage, img))!] as const)),
  ]);
  return renderCertificatePdf({
    design: snapshot.template.design,
    values: snapshot.placeholders,
    qrValue: snapshot.verificationUrl,
    images: { signature1, signature2, stamp, assets: new Map(assetEntries) },
    info: {
      title: `${snapshot.certification.name} - ${snapshot.recipient.legalName}`,
      author: snapshot.certification.issuingOrganizationName,
      subject: `Certificate ${snapshot.certificateNumber}`,
      keywords: `${snapshot.certificateNumber}, ${snapshot.certification.code}, certificate`,
      creationDate: new Date(snapshot.dates.issuedAt),
    },
    footer: `Certificate ID ${snapshot.certificateId}`,
    watermark: null,
  });
}
