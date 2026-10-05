import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger, type Logger } from '@a5/observability';
import { JOURNEYS, ORGANIZATION, PEOPLE, SEED_NOW, allLessons, completedLessonKeys, seedId, type SeedLesson } from '@a5/seed-data';
import type { ObjectStorage } from '@a5/storage';
import { OutboxEventWriter } from '../common/event-writer.js';
import type { Db } from '../database/index.js';
import { FfmpegHlsTranscoder } from '../processing/ffmpeg-hls.transcoder.js';
import { MediaProcessor } from '../processing/media-processor.js';
import { NoopScanner } from '../scanning/noop.scanner.js';
import { mediaKeys } from '../storage/keys.js';
import { reachedMilestones } from '../telemetry/intervals.js';
import { ffmpegAvailable, generateClip, generateJourneyChecklistPdf } from './sample-media.js';

export interface SeedMediaOptions {
  log?: (line: string) => void;
  ffmpegPath?: string;
  ffprobePath?: string;
  /** Parent directory for temporary files. */
  workDir?: string;
  logger?: Logger;
  /** Restrict to these lesson keys (tests). Defaults to every video and PDF lesson. */
  lessonKeys?: string[];
}

export interface SeedMediaResult {
  videos: number;
  documents: number;
  videosSkipped: boolean;
  progressRows: number;
}

/** Chapter titles per video lesson; start times are spread over the generated clip. */
const CHAPTERS: Record<string, string[]> = {
  'w1-welcome': ['A message from leadership', 'What makes A5 different', 'Your first four weeks'],
  'w1-journey': ['The first conversation', 'Inspection and the claim', 'Production and the final walkthrough'],
  'w2-anatomy': ['Decking and underlayment', 'Shingles, ridge and flashing', 'Attic ventilation'],
  'w2-damage': ['Hail strikes on shingles', 'Wind creases and lifted tabs', 'Collateral damage to document'],
  'w2-claims': ['Filing the claim', 'The adjuster inspection', 'Deductibles and depreciation'],
  'w3-opening': ['Your introduction', 'Earning the next minute'],
  'w3-framework': ['Listen and acknowledge', 'Ask a clarifying question', 'Respond and confirm'],
};

const CREATED_BY = PEOPLE.shelby.id;
const ORG = ORGANIZATION.id;

function chapterStarts(count: number, duration: number): number[] {
  return Array.from({ length: count }, (_, i) => Math.round(((duration * i) / count) * 10) / 10);
}

function vttTime(seconds: number): string {
  const ms = Math.round(seconds * 1000);
  const mm = String(Math.floor(ms / 60_000)).padStart(2, '0');
  const ss = String(Math.floor((ms % 60_000) / 1000)).padStart(2, '0');
  return `${mm}:${ss}.${String(ms % 1000).padStart(3, '0')}`;
}

function captionCues(lesson: SeedLesson, chapters: Array<{ start: number; title: string }>, duration: number) {
  const cues = [{ startSeconds: 0, endSeconds: Math.min(3.5, duration), text: `A5 Sales Academy: ${lesson.title}` }];
  for (const c of chapters) {
    const start = Math.max(c.start, cues[cues.length - 1]!.endSeconds);
    if (start + 1 > duration) break;
    cues.push({ startSeconds: start, endSeconds: Math.min(start + 4, duration), text: c.title });
  }
  return cues;
}

/**
 * Seed the media library for the A5 New Hire Sales Academy: every video lesson gets a short
 * generated test-pattern clip that runs through the real processing pipeline (HLS ladder, poster),
 * with chapters, English captions and a transcript; the customer-journey PDF lesson gets a real PDF.
 * Learners whose journey includes completed video lessons get matching watch progress.
 * Idempotent: finished assets are left alone; half-finished ones are completed.
 */
export async function seedMedia(db: Db, storage: ObjectStorage, options: SeedMediaOptions = {}): Promise<SeedMediaResult> {
  const log = options.log ?? (() => undefined);
  const logger = options.logger ?? createLogger({ service: 'media-seed', level: 'warn' });
  const ffmpegPath = options.ffmpegPath ?? 'ffmpeg';
  const lessons = allLessons().filter((l) => !options.lessonKeys || options.lessonKeys.includes(l.key));
  const videoLessons = lessons.filter((l) => l.type === 'video');
  const pdfLessons = lessons.filter((l) => l.type === 'pdf');
  const work = await mkdtemp(join(options.workDir ?? tmpdir(), 'a5-media-seed-'));
  const processor = new MediaProcessor({
    db,
    storage,
    transcoder: new FfmpegHlsTranscoder({ ffmpegPath, ffprobePath: options.ffprobePath ?? 'ffprobe', timeoutMs: 600_000 }),
    scanner: new NoopScanner(logger),
    events: new OutboxEventWriter(),
    logger,
    workDir: work,
  });
  const result: SeedMediaResult = { videos: 0, documents: 0, videosSkipped: false, progressRows: 0 };

  try {
    const canEncode = videoLessons.length > 0 && (await ffmpegAvailable(ffmpegPath));
    if (videoLessons.length && !canEncode) {
      result.videosSkipped = true;
      log(`media: ffmpeg not found at "${ffmpegPath}" — skipping ${videoLessons.length} video lessons (install ffmpeg or set FFMPEG_PATH, then re-run the seed)`);
    }
    if (canEncode) {
      for (const [index, lesson] of videoLessons.entries()) {
        await seedVideo(db, storage, processor, lesson, index, work, ffmpegPath, log);
        result.videos++;
      }
      result.progressRows = await seedWatchProgress(db);
    }
    for (const lesson of pdfLessons) {
      await seedDocument(db, storage, processor, lesson, log);
      result.documents++;
    }
  } finally {
    await rm(work, { recursive: true, force: true });
  }
  log(`media: ${result.videos} videos, ${result.documents} documents, ${result.progressRows} watch-progress rows`);
  return result;
}

async function resetIncomplete(db: Db, storage: ObjectStorage, id: string): Promise<'ready' | 'absent'> {
  const existing = await db.selectFrom('media_assets').select(['status', 'organization_id']).where('id', '=', id).executeTakeFirst();
  if (!existing) return 'absent';
  if (existing.status === 'ready') return 'ready';
  // A previous run stopped half-way: remove the partial asset and start over.
  await db.transaction().execute(async (trx) => {
    const captionAssets = await trx.selectFrom('media_captions').select('caption_asset_id').where('asset_id', '=', id).execute();
    await trx.deleteFrom('media_captions').where('asset_id', '=', id).execute();
    if (captionAssets.length) await trx.deleteFrom('media_assets').where('id', 'in', captionAssets.map((c) => c.caption_asset_id)).execute();
    await trx.deleteFrom('video_progress').where('asset_id', '=', id).execute();
    await trx.deleteFrom('media_assets').where('id', '=', id).execute();
  });
  await storage.deletePrefix(`${mediaKeys.prefix(existing.organization_id, id)}/`);
  return 'absent';
}

async function insertUploaded(
  db: Db,
  storage: ObjectStorage,
  asset: { id: string; kind: 'video' | 'document' | 'caption'; title: string; description: string | null; filename: string; mime: string; body: Buffer; parentAssetId?: string },
): Promise<void> {
  const key = mediaKeys.source(ORG, asset.id);
  await storage.putObject(key, asset.body, { contentType: asset.mime, contentLength: asset.body.length });
  await db
    .insertInto('media_assets')
    .values({
      id: asset.id,
      organization_id: ORG,
      kind: asset.kind,
      title: asset.title,
      description: asset.description,
      original_filename: asset.filename,
      storage_key: key,
      mime_type: asset.mime,
      size_bytes: asset.body.length,
      checksum: null,
      status: 'uploaded',
      duration_seconds: null,
      width: null,
      height: null,
      hls_master_key: null,
      thumbnail_key: null,
      error: null,
      parent_asset_id: asset.parentAssetId ?? null,
      uploaded_at: new Date(),
      ready_at: null,
      archived_at: null,
      created_by: CREATED_BY,
      updated_by: CREATED_BY,
    })
    .execute();
}

async function processOrThrow(processor: MediaProcessor, id: string, what: string): Promise<void> {
  const outcome = await processor.process(id);
  if (outcome !== 'ready') throw new Error(`Seeding ${what} failed: processing ended as "${outcome}"`);
}

async function seedVideo(
  db: Db,
  storage: ObjectStorage,
  processor: MediaProcessor,
  lesson: SeedLesson,
  index: number,
  work: string,
  ffmpegPath: string,
  log: (line: string) => void,
): Promise<void> {
  const id = seedId(`media:${lesson.key}`);
  if ((await resetIncomplete(db, storage, id)) === 'absent') {
    const dir = await mkdtemp(join(work, `${lesson.key}-`));
    const clip = join(dir, 'clip.mp4');
    const duration = 15 + ((index * 4) % 11);
    await generateClip({
      ffmpegPath,
      outPath: clip,
      workDir: dir,
      durationSeconds: duration,
      title: lesson.title,
      subtitle: 'A5 Sales Academy',
      toneHz: 330 + index * 55,
    });
    await insertUploaded(db, storage, {
      id,
      kind: 'video',
      title: lesson.title,
      description: `Lesson video for "${lesson.title}" in the A5 New Hire Sales Academy.`,
      filename: `${lesson.key}.mp4`,
      mime: 'video/mp4',
      body: await readFile(clip),
    });
    await processOrThrow(processor, id, `video for ${lesson.key}`);
    log(`media: video ready — ${lesson.title} (${duration} s)`);
  }

  const asset = await db.selectFrom('media_assets').select(['duration_seconds', 'title']).where('id', '=', id).executeTakeFirstOrThrow();
  const duration = asset.duration_seconds ?? 15;
  const titles = CHAPTERS[lesson.key] ?? ['Introduction', 'Key points', 'Summary'];
  const starts = chapterStarts(titles.length, duration);
  const chapters = titles.map((title, i) => ({ start: starts[i]!, title }));

  const hasChapters = await db.selectFrom('media_chapters').select('id').where('asset_id', '=', id).executeTakeFirst();
  if (!hasChapters) {
    await db
      .insertInto('media_chapters')
      .values(chapters.map((c, i) => ({ id: seedId(`media:${lesson.key}:chapter:${i + 1}`), asset_id: id, start_seconds: c.start, title: c.title, position: i + 1, created_by: CREATED_BY, updated_by: CREATED_BY })))
      .execute();
  }

  const cues = captionCues(lesson, chapters, duration);
  const captionAssetId = seedId(`media:${lesson.key}:captions:en`);
  const caption = await db.selectFrom('media_assets').select('status').where('id', '=', captionAssetId).executeTakeFirst();
  if (caption && caption.status !== 'ready') {
    await db.deleteFrom('media_captions').where('caption_asset_id', '=', captionAssetId).execute();
    await db.deleteFrom('media_assets').where('id', '=', captionAssetId).execute();
  }
  if (!caption || caption.status !== 'ready') {
    const vtt = `WEBVTT\n\n${cues.map((c, i) => `${i + 1}\n${vttTime(c.startSeconds)} --> ${vttTime(c.endSeconds)}\n${c.text}\n`).join('\n')}`;
    await insertUploaded(db, storage, {
      id: captionAssetId,
      kind: 'caption',
      title: `${asset.title} — English`,
      description: null,
      filename: `${lesson.key}.en.vtt`,
      mime: 'text/vtt',
      body: Buffer.from(vtt, 'utf8'),
      parentAssetId: id,
    });
    await db
      .insertInto('media_captions')
      .values({
        id: seedId(`media:${lesson.key}:caption-link:en`),
        asset_id: id,
        caption_asset_id: captionAssetId,
        language: 'en',
        label: 'English',
        storage_key: mediaKeys.source(ORG, captionAssetId),
        is_default: true,
        created_by: CREATED_BY,
      })
      .execute();
    await processOrThrow(processor, captionAssetId, `captions for ${lesson.key}`);
  }

  await db
    .insertInto('media_transcripts')
    .values({ id: seedId(`media:${lesson.key}:transcript:en`), asset_id: id, language: 'en', segments: JSON.stringify(cues) as never, updated_by: CREATED_BY })
    .onConflict((oc) => oc.columns(['asset_id', 'language']).doNothing())
    .execute();
}

async function seedDocument(db: Db, storage: ObjectStorage, processor: MediaProcessor, lesson: SeedLesson, log: (line: string) => void): Promise<void> {
  const id = seedId(`media:${lesson.key}`);
  if ((await resetIncomplete(db, storage, id)) === 'ready') return;
  await insertUploaded(db, storage, {
    id,
    kind: 'document',
    title: lesson.title,
    description: 'Printable checklist covering every stage of the A5 customer journey.',
    filename: 'A5-Customer-Journey-Checklist.pdf',
    mime: 'application/pdf',
    body: await generateJourneyChecklistPdf(),
  });
  await processOrThrow(processor, id, `document for ${lesson.key}`);
  log(`media: document ready — ${lesson.title}`);
}

/** Learners whose seeded journey completed a video lesson have watched it fully. */
async function seedWatchProgress(db: Db): Promise<number> {
  const videos = new Map(allLessons().filter((l) => l.type === 'video').map((l, i) => [l.key, { lesson: l, order: i }]));
  const assets = await db
    .selectFrom('media_assets')
    .select(['id', 'duration_seconds'])
    .where('id', 'in', [...videos.keys()].map((k) => seedId(`media:${k}`)))
    .where('status', '=', 'ready')
    .execute();
  const durations = new Map(assets.map((a) => [a.id, a.duration_seconds ?? 0]));
  let inserted = 0;
  for (const journey of JOURNEYS) {
    const person = PEOPLE[journey.person];
    const enrolled = new Date(journey.enrolledAt).getTime();
    for (const key of completedLessonKeys(journey.stage)) {
      const video = videos.get(key);
      if (!video) continue;
      const assetId = seedId(`media:${key}`);
      const duration = durations.get(assetId);
      if (!duration) continue;
      const watchedAt = new Date(Math.min(enrolled + (video.order + 1) * 86_400_000, SEED_NOW.getTime() - 3_600_000));
      const res = await db
        .insertInto('video_progress')
        .values({
          id: seedId(`video-progress:${journey.person}:${key}`),
          organization_id: ORG,
          user_id: person.id,
          asset_id: assetId,
          context_type: 'lesson',
          context_id: video.lesson.id,
          watched_seconds: duration,
          duration_seconds: duration,
          percent: 100,
          last_position_seconds: duration,
          intervals: JSON.stringify([[0, duration]]) as never,
          started_at: watchedAt,
          completed_at: new Date(watchedAt.getTime() + Math.ceil(duration) * 1000),
          milestones_emitted: reachedMilestones(100),
        })
        .onConflict((oc) => oc.columns(['user_id', 'asset_id', 'context_type', 'context_id']).doNothing())
        .executeTakeFirst();
      inserted += Number(res.numInsertedOrUpdatedRows ?? 0n);
    }
  }
  return inserted;
}
