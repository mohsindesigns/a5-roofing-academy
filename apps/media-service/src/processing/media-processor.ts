import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, open, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { MediaStatus, ScanStatus } from '@a5/contracts/media';
import type { Selectable } from '@a5/database';
import { mediaEvents } from '@a5/events';
import { uuidv7, type Logger } from '@a5/observability';
import { validateFileContent, type ObjectStorage } from '@a5/storage';
import type { EventWriter } from '../common/event-writer.js';
import type { Db, MediaAssetsTable, Trx } from '../database/index.js';
import type { MalwareScanner } from '../scanning/malware-scanner.js';
import { mediaKeys } from '../storage/keys.js';
import { InvalidMediaError } from './ffmpeg-hls.transcoder.js';
import { ProcessError, lastLine } from './process-runner.js';
import type { Transcoder } from './transcoder.js';

type AssetRow = Selectable<MediaAssetsTable>;

/** The input is unusable; retrying cannot help. */
export class PermanentProcessingError extends Error {
  constructor(
    message: string,
    readonly outcome: 'failed' | 'rejected' = 'failed',
    readonly scanStatus?: ScanStatus,
  ) {
    super(message);
    this.name = 'PermanentProcessingError';
  }
}

export type ProcessOutcome = 'ready' | 'failed' | 'rejected' | 'skipped';

export interface MediaProcessorDeps {
  db: Db;
  storage: ObjectStorage;
  transcoder: Transcoder;
  scanner: MalwareScanner;
  events: EventWriter;
  logger: Logger;
  /** Directory for per-job temporary working directories. */
  workDir: string;
}

const PROCESSABLE: MediaStatus[] = ['uploaded', 'scanning', 'processing'];
const SNIFF_BYTES = 4096;
const UPLOAD_CONCURRENCY = 6;

const CONTENT_TYPES: Record<string, string> = {
  m3u8: 'application/vnd.apple.mpegurl',
  ts: 'video/mp2t',
  m4s: 'video/iso.segment',
  mp4: 'video/mp4',
  aac: 'audio/aac',
  vtt: 'text/vtt',
  jpg: 'image/jpeg',
};

function contentTypeOf(file: string): string {
  return CONTENT_TYPES[file.slice(file.lastIndexOf('.') + 1)] ?? 'application/octet-stream';
}

function isMissingObject(err: unknown): boolean {
  const e = err as { code?: string; name?: string; $metadata?: { httpStatusCode?: number } };
  return (
    e?.code === 'NoSuchKey' ||
    e?.name === 'NoSuchKey' ||
    e?.$metadata?.httpStatusCode === 404 ||
    e?.code === 'ENOENT'
  );
}

async function mapLimit<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]!);
  });
  await Promise.all(workers);
}

/**
 * Scans, verifies and processes an uploaded asset: videos become an HLS ladder plus a poster frame;
 * documents, images and captions are verified and published as they are. Runs in the
 * `media.process` worker (and the seed). Every run works in its own temporary directory that is
 * always removed.
 */
export class MediaProcessor {
  constructor(private readonly deps: MediaProcessorDeps) {}

  async process(
    assetId: string,
    { finalAttempt = true }: { finalAttempt?: boolean } = {},
  ): Promise<ProcessOutcome> {
    const { db, logger } = this.deps;
    const asset = await db
      .selectFrom('media_assets')
      .selectAll()
      .where('id', '=', assetId)
      .executeTakeFirst();
    if (!asset) {
      logger.warn({ assetId }, 'media.process: asset no longer exists');
      return 'skipped';
    }
    if (!PROCESSABLE.includes(asset.status)) {
      logger.info(
        { assetId, status: asset.status },
        'media.process: asset is not awaiting processing',
      );
      return 'skipped';
    }

    const dir = await mkdtemp(join(this.deps.workDir, 'a5-media-'));
    try {
      return await this.run(asset, dir);
    } catch (err) {
      if (err instanceof PermanentProcessingError) {
        await this.markUnusable(asset, err.message, err.outcome, err.scanStatus);
        return err.outcome;
      }
      if (finalAttempt) {
        const reason =
          err instanceof ProcessError
            ? `${err.message}${lastLine(err.stderrTail) ? `: ${lastLine(err.stderrTail)}` : ''}`
            : (err as Error).message;
        await this.markUnusable(
          asset,
          `Processing failed after several attempts (${reason.slice(0, 300)}). Upload the file again or contact support.`,
          'failed',
        );
      }
      throw err;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  private async run(asset: AssetRow, dir: string): Promise<ProcessOutcome> {
    const { storage, scanner, logger } = this.deps;
    await this.setStatus(asset.id, 'scanning');

    const sourcePath = join(dir, 'source');
    const { size, sha256 } = await this.download(asset.storage_key, sourcePath);
    if (size !== asset.size_bytes) {
      throw new PermanentProcessingError(
        'The stored file changed after the upload was verified. Upload it again.',
        'rejected',
      );
    }
    const verdict = await validateFileContent(
      asset.kind,
      asset.mime_type,
      await this.head(sourcePath),
    );
    if (!verdict.ok) throw new PermanentProcessingError(verdict.reason, 'rejected');

    const scan = await scanner.scanFile(sourcePath);
    if (scan.status === 'infected') {
      await storage
        .deleteObject(asset.storage_key)
        .catch((err: unknown) =>
          logger.error({ err, assetId: asset.id }, 'could not delete infected upload'),
        );
      throw new PermanentProcessingError(
        `The file failed the malware scan (${scan.signature}) and was removed.`,
        'rejected',
        'infected',
      );
    }
    const scanStatus: ScanStatus = scan.status === 'skipped' ? 'skipped' : 'clean';
    await this.deps.db
      .updateTable('media_assets')
      .set({ status: 'processing', scan_status: scanStatus, checksum: sha256 })
      .where('id', '=', asset.id)
      .execute();

    switch (asset.kind) {
      case 'video':
        await this.processVideo(asset, sourcePath, dir);
        break;
      case 'image':
        await this.processImage(asset, sourcePath);
        break;
      case 'caption':
        await this.processCaption(asset, sourcePath);
        break;
      case 'document':
        await this.publish(asset, {});
        break;
    }
    logger.info({ assetId: asset.id, kind: asset.kind }, 'media asset ready');
    return 'ready';
  }

  private async processVideo(asset: AssetRow, sourcePath: string, dir: string): Promise<void> {
    const { transcoder, storage } = this.deps;
    const probe = await this.invalidMediaIsPermanent(() => transcoder.probe(sourcePath));
    if (!probe.video)
      throw new PermanentProcessingError('The file does not contain a playable video track.');
    if (!probe.durationSeconds)
      throw new PermanentProcessingError('The video has no measurable duration.');

    const outDir = join(dir, 'hls');
    await mkdir(outDir);
    const hls = await this.invalidMediaIsPermanent(() =>
      transcoder.transcodeToHls(sourcePath, outDir, probe),
    );
    const thumbPath = join(dir, 'thumb.jpg');
    await this.invalidMediaIsPermanent(() =>
      transcoder.thumbnail(sourcePath, thumbPath, probe.durationSeconds! * 0.1),
    );

    const org = asset.organization_id;
    // Remove leftovers of an earlier, interrupted attempt before publishing the new package.
    await storage.deletePrefix(`${mediaKeys.hlsPrefix(org, asset.id)}/`);
    await mapLimit(hls.files, UPLOAD_CONCURRENCY, async (file) => {
      const path = join(outDir, file);
      const { size } = await stat(path);
      await storage.putObject(mediaKeys.hls(org, asset.id, file), createReadStream(path), {
        contentType: contentTypeOf(file),
        contentLength: size,
      });
    });
    const thumbKey = mediaKeys.thumbnail(org, asset.id);
    await storage.putObject(thumbKey, await readFile(thumbPath), { contentType: 'image/jpeg' });

    await this.publish(
      asset,
      {
        duration_seconds: probe.durationSeconds,
        width: probe.video.width,
        height: probe.video.height,
        hls_master_key: mediaKeys.hls(org, asset.id, hls.masterFile),
        thumbnail_key: thumbKey,
      },
      async (trx) => {
        await trx.deleteFrom('media_renditions').where('asset_id', '=', asset.id).execute();
        await trx
          .insertInto('media_renditions')
          .values(
            hls.renditions.map((r) => ({
              id: uuidv7(),
              asset_id: asset.id,
              name: r.name,
              width: r.width,
              height: r.height,
              bandwidth: r.bandwidth,
              codecs: r.codecs,
              playlist_key: mediaKeys.hls(org, asset.id, r.playlistFile),
            })),
          )
          .execute();
      },
    );
  }

  private async processImage(asset: AssetRow, sourcePath: string): Promise<void> {
    const probe = await this.invalidMediaIsPermanent(() => this.deps.transcoder.probe(sourcePath));
    if (!probe.video)
      throw new PermanentProcessingError('The image could not be read.', 'rejected');
    // The image is its own cover/thumbnail.
    await this.publish(asset, {
      width: probe.video.width,
      height: probe.video.height,
      thumbnail_key: asset.storage_key,
    });
  }

  private async processCaption(asset: AssetRow, sourcePath: string): Promise<void> {
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(await readFile(sourcePath));
    } catch {
      throw new PermanentProcessingError('Caption files must be UTF-8 encoded WebVTT.', 'rejected');
    }
    if (!/^\uFEFF?WEBVTT(?:[ \t].*)?(?:\r?\n|$)/.test(text)) {
      throw new PermanentProcessingError(
        'Caption files must start with the WEBVTT header.',
        'rejected',
      );
    }
    if (!/\d{2}:\d{2}(?::\d{2})?\.\d{3}\s+-->\s+\d{2}:\d{2}(?::\d{2})?\.\d{3}/.test(text)) {
      throw new PermanentProcessingError('The caption file does not contain any cues.', 'rejected');
    }
    await this.publish(asset, {});
  }

  private async invalidMediaIsPermanent<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof InvalidMediaError) throw new PermanentProcessingError(err.message);
      throw err;
    }
  }

  /** Mark ready and announce it, atomically. */
  private async publish(
    asset: AssetRow,
    patch: Partial<
      Pick<
        MediaAssetsTable,
        'duration_seconds' | 'width' | 'height' | 'hls_master_key' | 'thumbnail_key'
      >
    >,
    extra?: (trx: Trx) => Promise<void>,
  ): Promise<void> {
    await this.deps.db.transaction().execute(async (trx) => {
      await extra?.(trx);
      const updated = await trx
        .updateTable('media_assets')
        .set({ ...patch, status: 'ready', ready_at: new Date(), error: null })
        .where('id', '=', asset.id)
        .where('status', '=', 'processing')
        .returning(['duration_seconds'])
        .executeTakeFirst();
      if (!updated) throw new Error('The asset changed state while it was being processed');
      await this.deps.events.emit(
        trx,
        mediaEvents.assetReady,
        {
          assetId: asset.id,
          kind: asset.kind,
          title: asset.title,
          durationSeconds: updated.duration_seconds,
        },
        {
          organizationId: asset.organization_id,
          subject: { type: 'media_asset', id: asset.id },
          actor: { type: 'system', id: null },
        },
      );
    });
  }

  private async markUnusable(
    asset: AssetRow,
    error: string,
    outcome: 'failed' | 'rejected',
    scanStatus?: ScanStatus,
  ): Promise<void> {
    await this.deps.db.transaction().execute(async (trx) => {
      const updated = await trx
        .updateTable('media_assets')
        .set({ status: outcome, error, ...(scanStatus && { scan_status: scanStatus }) })
        .where('id', '=', asset.id)
        .where('status', 'in', PROCESSABLE)
        .returning('id')
        .executeTakeFirst();
      if (!updated) return;
      await this.deps.events.emit(
        trx,
        mediaEvents.assetFailed,
        { assetId: asset.id, title: asset.title, error },
        {
          organizationId: asset.organization_id,
          subject: { type: 'media_asset', id: asset.id },
          actor: { type: 'system', id: null },
        },
      );
    });
    this.deps.logger.warn(
      { assetId: asset.id, outcome, error },
      'media asset could not be processed',
    );
  }

  private async setStatus(id: string, status: MediaStatus): Promise<void> {
    await this.deps.db
      .updateTable('media_assets')
      .set({ status })
      .where('id', '=', id)
      .where('status', 'in', PROCESSABLE)
      .execute();
  }

  private async download(key: string, path: string): Promise<{ size: number; sha256: string }> {
    let body;
    try {
      ({ body } = await this.deps.storage.getObject(key));
    } catch (err) {
      if (isMissingObject(err))
        throw new PermanentProcessingError(
          'The uploaded file is missing from storage. Upload it again.',
        );
      throw err;
    }
    const hash = createHash('sha256');
    let size = 0;
    const tap = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        hash.update(chunk);
        size += chunk.length;
        callback(null, chunk);
      },
    });
    await pipeline(body, tap, createWriteStream(path));
    return { size, sha256: hash.digest('hex') };
  }

  private async head(path: string): Promise<Buffer> {
    const handle = await open(path, 'r');
    try {
      const buffer = Buffer.alloc(SNIFF_BYTES);
      const { bytesRead } = await handle.read(buffer, 0, SNIFF_BYTES, 0);
      return buffer.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  }
}
