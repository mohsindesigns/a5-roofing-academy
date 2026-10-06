import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import PDFDocument from 'pdfkit';
import { runProcess } from '../processing/process-runner.js';

/** True when the ffmpeg binary can be executed. */
export async function ffmpegAvailable(ffmpegPath = 'ffmpeg'): Promise<boolean> {
  try {
    await runProcess(ffmpegPath, ['-hide_banner', '-version'], { timeoutMs: 10_000 });
    return true;
  } catch {
    return false;
  }
}

export interface ClipOptions {
  ffmpegPath?: string;
  /** Output .mp4 path. */
  outPath: string;
  /** Scratch directory for overlay text files. */
  workDir: string;
  durationSeconds: number;
  width?: number;
  height?: number;
  /** Large title burned into the picture. */
  title?: string;
  subtitle?: string;
  toneHz?: number;
}

/**
 * Generate a real H.264/AAC test-pattern clip (moving test pattern, sine tone, burned-in titles).
 * Text is passed through files so titles never need filter-graph escaping.
 */
export async function generateClip(options: ClipOptions): Promise<void> {
  const ffmpeg = options.ffmpegPath ?? 'ffmpeg';
  const width = options.width ?? 1280;
  const height = options.height ?? 720;
  const d = options.durationSeconds;
  const filters: string[] = [];
  if (options.title || options.subtitle) {
    const scale = height / 720;
    const overlay = async (name: string, text: string, size: number, y: string) => {
      const file = join(options.workDir, `${name}.txt`);
      await writeFile(file, text, 'utf8');
      filters.push(
        `drawtext=font='DejaVu Sans':textfile=${file}:fontsize=${Math.round(size * scale)}:fontcolor=white:` +
          `x=(w-text_w)/2:y=${y}:box=1:boxcolor=black@0.65:boxborderw=${Math.round(20 * scale)}`,
      );
    };
    if (options.title) await overlay('title', options.title, 46, 'h*0.38');
    if (options.subtitle) await overlay('subtitle', options.subtitle, 30, 'h*0.38+90*h/720');
  }
  const base = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-nostdin',
    '-y',
    '-f',
    'lavfi',
    '-i',
    `testsrc2=size=${width}x${height}:rate=30:duration=${d}`,
    '-f',
    'lavfi',
    '-i',
    `sine=frequency=${options.toneHz ?? 440}:sample_rate=48000:duration=${d}`,
  ];
  const encode = [
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-b:a',
    '128k',
    '-shortest',
    '-movflags',
    '+faststart',
    options.outPath,
  ];
  try {
    await runProcess(
      ffmpeg,
      [...base, ...(filters.length ? ['-vf', filters.join(',')] : []), ...encode],
      { timeoutMs: 300_000 },
    );
  } catch (err) {
    if (!filters.length) throw err;
    // drawtext needs libfreetype/fontconfig; fall back to the bare test pattern.
    await runProcess(ffmpeg, [...base, ...encode], { timeoutMs: 300_000 });
  }
}

const JOURNEY_STAGES: Array<{ stage: string; items: string[] }> = [
  {
    stage: '1. Door knock and introduction',
    items: [
      'Introduce yourself and A5 Roofing by name; show your badge.',
      'Explain why you are in the neighborhood (recent storm, nearby project).',
      'Ask permission before stepping onto the property.',
    ],
  },
  {
    stage: '2. Free roof inspection',
    items: [
      'Photograph every slope, ridge, vent and gutter run.',
      'Mark hail hits with chalk and document collateral damage.',
      'Walk the homeowner through the photos before leaving the roof.',
    ],
  },
  {
    stage: '3. Insurance claim filing',
    items: [
      'Confirm the homeowner files the claim themselves; never file on their behalf.',
      'Record the claim number and adjuster appointment window.',
      'Explain the deductible clearly. We never promise to cover or waive it.',
    ],
  },
  {
    stage: '4. Adjuster meeting',
    items: [
      'Arrive 15 minutes early with the inspection photos.',
      'Point out damage factually; let the adjuster make the coverage decision.',
      'Send the homeowner a same-day summary of what was discussed.',
    ],
  },
  {
    stage: '5. Agreement and material selection',
    items: [
      'Review the scope of work and the insurance estimate line by line.',
      'Help the homeowner choose shingle color and ventilation options.',
      'Sign the agreement only after every question is answered.',
    ],
  },
  {
    stage: '6. Production day',
    items: [
      'Confirm the delivery date, dumpster placement and crew arrival time.',
      'Protect landscaping, pools and vehicles before tear-off begins.',
      'Check in with the homeowner at the start and end of the day.',
    ],
  },
  {
    stage: '7. Final walkthrough',
    items: [
      'Walk the property with the homeowner and run a magnet sweep for nails.',
      'Hand over warranty paperwork and the final invoice.',
      'Ask for a review and referrals once the homeowner is satisfied.',
    ],
  },
];

/** A one-page customer-journey checklist PDF (PDFKit, standard fonts only). */
export function generateJourneyChecklistPdf(): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'LETTER',
      margin: 54,
      info: { Title: 'A5 Customer Journey Checklist', Author: 'A5 Roofing Sales Enablement' },
    });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc
      .fillColor('#2b2b2b')
      .font('Helvetica-Bold')
      .fontSize(20)
      .text('A5 Customer Journey Checklist');
    doc.moveDown(0.3);
    doc
      .font('Helvetica')
      .fontSize(10.5)
      .fillColor('#555555')
      .text(
        'Use this checklist on every residential project, from the first knock to the final walkthrough. Each stage builds the trust that earns referrals.',
      );
    doc.moveDown(0.8);

    for (const { stage, items } of JOURNEY_STAGES) {
      doc.font('Helvetica-Bold').fontSize(12).fillColor('#b06a2c').text(stage);
      doc.moveDown(0.2);
      for (const item of items) {
        const y = doc.y + 1;
        doc.lineWidth(0.8).strokeColor('#2b2b2b').rect(doc.page.margins.left, y, 9, 9).stroke();
        doc
          .font('Helvetica')
          .fontSize(10.5)
          .fillColor('#2b2b2b')
          .text(item, doc.page.margins.left + 16, y - 1, { width: 470 });
        doc.moveDown(0.25);
      }
      doc.x = doc.page.margins.left;
      doc.moveDown(0.5);
    }
    doc
      .font('Helvetica-Oblique')
      .fontSize(9)
      .fillColor('#777777')
      .text('A5 Sales Academy · Week 1 · A5 Fundamentals', doc.page.margins.left);
    doc.end();
  });
}
