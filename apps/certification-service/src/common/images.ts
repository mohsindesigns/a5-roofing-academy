import { createHash } from 'node:crypto';
import { crc32, inflateSync } from 'node:zlib';
import PDFDocument from 'pdfkit';
import { certification } from '@a5/contracts';
import { AppError } from '@a5/nest-kit';
import { validateFileContent } from '@a5/storage';

export type ImagePurpose = keyof typeof certification.IMAGE_UPLOAD_RULES;

export interface ImageInfo {
  contentType: 'image/png' | 'image/jpeg';
  width: number;
  height: number;
}

export interface ValidatedImage extends ImageInfo {
  byteSize: number;
  sha256: string;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_PIXELS = 16_000_000;

/** Channels per PNG color type and the bit depths the PNG spec allows for each. */
const PNG_COLOR_TYPES: Record<number, { channels: number; depths: number[] }> = {
  0: { channels: 1, depths: [1, 2, 4, 8, 16] },
  2: { channels: 3, depths: [8, 16] },
  3: { channels: 1, depths: [1, 2, 4, 8] },
  4: { channels: 2, depths: [8, 16] },
  6: { channels: 4, depths: [8, 16] },
};

const ADAM7 = [
  [0, 0, 8, 8],
  [4, 0, 8, 8],
  [0, 4, 4, 8],
  [2, 0, 4, 4],
  [0, 2, 2, 4],
  [1, 0, 2, 2],
  [0, 1, 1, 2],
] as const;

class ImageRejected extends Error {}

/**
 * Structural PNG check: chunk CRCs, IHDR values, and that the image data inflates to exactly the
 * expected size. Rejecting corrupt data here keeps the PDF renderer from failing later.
 */
function inspectPng(buf: Buffer): ImageInfo {
  if (buf.length < 33 || !buf.subarray(0, 8).equals(PNG_SIGNATURE))
    throw new ImageRejected('The file is not a valid PNG image.');
  let offset = 8;
  let header: {
    width: number;
    height: number;
    depth: number;
    colorType: number;
    interlace: number;
  } | null = null;
  const idat: Buffer[] = [];
  let ended = false;
  let hasPalette = false;
  while (offset + 12 <= buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.toString('latin1', offset + 4, offset + 8);
    const end = offset + 12 + length;
    if (end > buf.length) throw new ImageRejected('The PNG file is truncated.');
    const crc = buf.readUInt32BE(offset + 8 + length);
    if (crc32(buf.subarray(offset + 4, offset + 8 + length)) !== crc)
      throw new ImageRejected('The PNG file is corrupt (checksum mismatch).');
    const data = buf.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      if (length !== 13) throw new ImageRejected('The PNG header is invalid.');
      header = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        depth: data[8]!,
        colorType: data[9]!,
        interlace: data[12]!,
      };
    } else if (type === 'PLTE') {
      hasPalette = true;
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      ended = true;
      break;
    }
    offset = end;
  }
  if (!header || !ended || idat.length === 0)
    throw new ImageRejected('The PNG file is incomplete.');
  const color = PNG_COLOR_TYPES[header.colorType];
  if (!color || !color.depths.includes(header.depth))
    throw new ImageRejected('The PNG uses an unsupported color format.');
  if (header.colorType === 3 && !hasPalette) throw new ImageRejected('The PNG palette is missing.');
  if (header.interlace > 1)
    throw new ImageRejected('The PNG uses an unsupported interlace method.');
  if (header.width === 0 || header.height === 0 || header.width * header.height > MAX_PIXELS) {
    throw new ImageRejected('The image has too many pixels. Resize it and upload again.');
  }
  const bitsPerPixel = color.channels * header.depth;
  const rowBytes = (w: number) => (w === 0 ? 0 : 1 + Math.ceil((w * bitsPerPixel) / 8));
  let expected = 0;
  if (header.interlace === 0) {
    expected = header.height * rowBytes(header.width);
  } else {
    for (const [x0, y0, dx, dy] of ADAM7) {
      const w = Math.ceil((header.width - x0) / dx);
      const h = Math.ceil((header.height - y0) / dy);
      if (w > 0 && h > 0) expected += h * rowBytes(w);
    }
  }
  let inflated: Buffer;
  try {
    inflated = inflateSync(Buffer.concat(idat), { maxOutputLength: expected + 1 });
  } catch {
    throw new ImageRejected('The PNG image data is corrupt.');
  }
  if (inflated.length !== expected) throw new ImageRejected('The PNG image data is incomplete.');
  return { contentType: 'image/png', width: header.width, height: header.height };
}

const SOF_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

/** Walks JPEG segments to find the frame header; requires a scan and an end-of-image marker. */
function inspectJpeg(buf: Buffer): ImageInfo {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8)
    throw new ImageRejected('The file is not a valid JPEG image.');
  let offset = 2;
  let size: { width: number; height: number; components: number } | null = null;
  let scan = false;
  while (offset + 4 <= buf.length) {
    if (buf[offset] !== 0xff) throw new ImageRejected('The JPEG file is corrupt.');
    let marker = buf[offset + 1]!;
    while (marker === 0xff && offset + 2 < buf.length) {
      offset++;
      marker = buf[offset + 1]!;
    }
    if (marker === 0xd9) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    const length = buf.readUInt16BE(offset + 2);
    if (length < 2 || offset + 2 + length > buf.length)
      throw new ImageRejected('The JPEG file is truncated.');
    if (SOF_MARKERS.has(marker)) {
      if (marker !== 0xc0 && marker !== 0xc1 && marker !== 0xc2)
        throw new ImageRejected('Save the JPEG as a standard (baseline or progressive) image.');
      size = {
        height: buf.readUInt16BE(offset + 5),
        width: buf.readUInt16BE(offset + 7),
        components: buf[offset + 9]!,
      };
    }
    if (marker === 0xda) {
      scan = true;
      break;
    }
    offset += 2 + length;
  }
  if (!size || !scan) throw new ImageRejected('The JPEG file is incomplete.');
  if (![1, 3, 4].includes(size.components))
    throw new ImageRejected('The JPEG uses an unsupported color format.');
  const tail = buf.subarray(Math.max(0, buf.length - 1024));
  if (tail.indexOf(Buffer.from([0xff, 0xd9])) === -1)
    throw new ImageRejected('The JPEG file is truncated.');
  if (size.width === 0 || size.height === 0 || size.width * size.height > MAX_PIXELS) {
    throw new ImageRejected('The image has too many pixels. Resize it and upload again.');
  }
  return { contentType: 'image/jpeg', width: size.width, height: size.height };
}

export function inspectImage(buf: Buffer, contentType: 'image/png' | 'image/jpeg'): ImageInfo {
  return contentType === 'image/png' ? inspectPng(buf) : inspectJpeg(buf);
}

/** Embed the image into a throwaway PDF to prove the renderer can use it. */
async function assertEmbeddable(buf: Buffer): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    try {
      const doc = new PDFDocument({ autoFirstPage: false });
      doc.on('data', () => undefined);
      doc.on('end', () => resolvePromise());
      doc.on('error', reject);
      doc.addPage({ size: [100, 100], margin: 0 });
      doc.image(buf, 0, 0, { fit: [100, 100] });
      doc.end();
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

/**
 * Validate an uploaded certificate image: PNG or JPEG only (no SVG), magic bytes must match the
 * declared type, size and dimension limits per purpose, and the image must embed into a PDF.
 */
export async function validateCertificateImage(
  buf: Buffer,
  declaredType: string,
  purpose: ImagePurpose,
): Promise<ValidatedImage> {
  const rules = certification.IMAGE_UPLOAD_RULES[purpose];
  const label =
    purpose === 'signature' ? 'Signature images' : purpose === 'stamp' ? 'Stamp images' : 'Images';
  if (buf.length === 0) throw new AppError(400, 'FILE_EMPTY', 'The uploaded file is empty.');
  if (buf.length > rules.maxBytes) {
    throw new AppError(
      413,
      'FILE_TOO_LARGE',
      `${label} must be ${Math.round(rules.maxBytes / 1024 / 1024)} MB or smaller.`,
    );
  }
  const content = await validateFileContent(
    'certificateImage',
    declaredType,
    buf.subarray(0, 4100),
  );
  if (!content.ok) {
    throw new AppError(
      415,
      'UNSUPPORTED_FILE_TYPE',
      `${content.reason} Upload a PNG or JPEG image.`,
    );
  }
  let info: ImageInfo;
  try {
    info = inspectImage(buf, content.mime as ImageInfo['contentType']);
  } catch (err) {
    if (err instanceof ImageRejected) throw new AppError(415, 'INVALID_IMAGE', err.message);
    throw err;
  }
  const aspect = info.width / info.height;
  if (
    info.width < rules.minWidth ||
    info.height < rules.minHeight ||
    info.width > rules.maxWidth ||
    info.height > rules.maxHeight ||
    aspect < rules.minAspect ||
    aspect > rules.maxAspect
  ) {
    throw new AppError(
      422,
      'IMAGE_DIMENSIONS',
      `${label} must be between ${rules.minWidth}×${rules.minHeight} and ${rules.maxWidth}×${rules.maxHeight} pixels` +
        ` with a width-to-height ratio between ${rules.minAspect} and ${rules.maxAspect}. This image is ${info.width}×${info.height}.`,
    );
  }
  try {
    await assertEmbeddable(buf);
  } catch {
    throw new AppError(
      415,
      'INVALID_IMAGE',
      'The image cannot be placed on a certificate. Export it again as a standard PNG or JPEG.',
    );
  }
  return { ...info, byteSize: buf.length, sha256: createHash('sha256').update(buf).digest('hex') };
}
