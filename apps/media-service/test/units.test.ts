import { createServer, type Server, type Socket } from 'node:net';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConfigError } from '@a5/config';
import { TEST_INTERNAL_SECRET, testLogger } from '@a5/nest-kit/testing';
import { loadMediaConfig, resolveStorageRoot } from '../src/config.js';
import { parseMasterPlaylist } from '../src/processing/ffmpeg-hls.transcoder.js';
import { planLadder } from '../src/processing/transcoder.js';
import { parsePlaybackPolicy } from '../src/playback/playback-policy.js';
import { rewritePlaylist } from '../src/playback/hls.service.js';
import { ClamAvScanner, parseClamdReply } from '../src/scanning/clamav.scanner.js';
import { NoopScanner } from '../src/scanning/noop.scanner.js';
import { parseRange } from '../src/storage/dev-storage.controller.js';
import { HmacCdnUrlSigner } from '../src/storage/url-signer.js';
import {
  mergeIntervals,
  percentOf,
  plausibleIntervals,
  reachedMilestones,
  totalLength,
} from '../src/telemetry/intervals.js';
import { sanitizeFilename } from '../src/uploads/upload-policy.js';

describe('interval crediting', () => {
  it('merges overlapping and touching intervals but never bridges gaps', () => {
    expect(
      mergeIntervals([
        [10, 20],
        [0, 5],
        [5, 8],
        [18, 30],
        [40, 41],
      ]),
    ).toEqual([
      [0, 8],
      [10, 30],
      [40, 41],
    ]);
    expect(
      mergeIntervals([
        [3, 3],
        [5, 4],
        [Number.NaN, 9],
      ]),
    ).toEqual([]);
    expect(
      totalLength([
        [0, 8],
        [10, 30],
      ]),
    ).toBe(28);
  });

  const base = { durationSeconds: 100, maxRate: 2, toleranceSeconds: 2 };

  it('accepts what the elapsed wall clock allows', () => {
    const r = plausibleIntervals({
      ...base,
      elapsedSeconds: 15,
      intervals: [{ start: 0, end: 15, rate: 1 }],
    });
    expect(r).toEqual({ accepted: [[0, 15]], droppedForRate: 0, truncated: 0 });
    const fast = plausibleIntervals({
      ...base,
      elapsedSeconds: 10,
      intervals: [{ start: 0, end: 20, rate: 2 }],
    });
    expect(fast.accepted).toEqual([[0, 20]]);
  });

  it('truncates content that could not have been played in the elapsed time', () => {
    const r = plausibleIntervals({
      ...base,
      elapsedSeconds: 5,
      intervals: [{ start: 0, end: 60, rate: 1 }],
    });
    expect(r.accepted).toEqual([[0, 7]]);
    expect(r.truncated).toBe(53);
  });

  it('shares one wall-clock budget across intervals and ignores the gaps between them', () => {
    const r = plausibleIntervals({
      ...base,
      elapsedSeconds: 8,
      toleranceSeconds: 0,
      intervals: [
        { start: 0, end: 5, rate: 1 },
        { start: 50, end: 60, rate: 1 },
        { start: 90, end: 100, rate: 1 },
      ],
    });
    expect(r.accepted).toEqual([
      [0, 5],
      [50, 53],
    ]);
  });

  it('drops intervals above the allowed rate and clamps to the video', () => {
    const r = plausibleIntervals({
      ...base,
      elapsedSeconds: 30,
      intervals: [
        { start: 0, end: 20, rate: 2.5 },
        { start: 90, end: 140, rate: 1 },
      ],
    });
    expect(r.droppedForRate).toBe(20);
    expect(r.accepted).toEqual([[90, 100]]);
    expect(
      plausibleIntervals({
        ...base,
        elapsedSeconds: 30,
        intervals: [
          { start: 5, end: 5, rate: 1 },
          { start: 9, end: 3, rate: 1 },
        ],
      }).accepted,
    ).toEqual([]);
  });

  it('computes percentages and 5 % milestones', () => {
    expect(percentOf(33.33, 100)).toBe(33.33);
    expect(percentOf(200, 100)).toBe(100);
    expect(percentOf(5, 0)).toBe(0);
    expect(reachedMilestones(4.99)).toEqual([]);
    expect(reachedMilestones(12)).toEqual([5, 10]);
    expect(reachedMilestones(100)).toHaveLength(20);
  });
});

describe('HLS ladder planning', () => {
  it('never upscales and keeps even dimensions', () => {
    expect(planLadder(1920, 1080).map((r) => [r.name, r.width, r.height])).toEqual([
      ['360p', 640, 360],
      ['720p', 1280, 720],
      ['1080p', 1920, 1080],
    ]);
    expect(planLadder(1280, 720).map((r) => r.name)).toEqual(['360p', '720p']);
    expect(planLadder(3840, 2160).map((r) => r.name)).toEqual(['360p', '720p', '1080p']);
    expect(planLadder(1440, 1080).map((r) => [r.width, r.height])).toEqual([
      [480, 360],
      [960, 720],
      [1440, 1080],
    ]);
  });

  it('handles portrait and tiny sources', () => {
    expect(planLadder(1080, 1920).map((r) => [r.name, r.width, r.height])).toEqual([
      ['360p', 360, 640],
      ['720p', 720, 1280],
      ['1080p', 1080, 1920],
    ]);
    const tiny = planLadder(320, 240);
    expect(tiny).toHaveLength(1);
    expect(tiny[0]).toMatchObject({ width: 320, height: 240, name: '240p' });
    expect(tiny[0]!.videoKbps).toBeGreaterThanOrEqual(200);
  });

  it('parses variants out of a master playlist', () => {
    const master =
      '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=985600,RESOLUTION=640x360,CODECS="avc1.4d401e,mp4a.40.2"\n360p.m3u8\n\n#EXT-X-STREAM-INF:BANDWIDTH=3220800,RESOLUTION=1280x720\n720p.m3u8\n';
    expect(parseMasterPlaylist(master)).toEqual([
      {
        uri: '360p.m3u8',
        bandwidth: 985600,
        width: 640,
        height: 360,
        codecs: 'avc1.4d401e,mp4a.40.2',
      },
      { uri: '720p.m3u8', bandwidth: 3220800, width: 1280, height: 720, codecs: null },
    ]);
  });
});

describe('playlist rewriting', () => {
  const map = { playlist: (n: string) => `P(${n})`, object: (n: string) => `O(${n})` };

  it('rewrites variant playlists in masters and segments in media playlists', async () => {
    const master =
      '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=2x2\n360p.m3u8\n#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=1,URI="iframes.m3u8"\n';
    expect(await rewritePlaylist(master, map)).toBe(
      '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=2x2\nP(360p.m3u8)\n#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=1,URI="P(iframes.m3u8)"\n',
    );
    const media =
      '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:6.0,\n720p_00001.ts\n#EXT-X-ENDLIST\n';
    expect(await rewritePlaylist(media, map)).toBe(
      '#EXTM3U\n#EXT-X-MAP:URI="O(init.mp4)"\n#EXTINF:6.0,\nO(720p_00001.ts)\n#EXT-X-ENDLIST\n',
    );
  });

  it('refuses URIs that are not flat generated file names', async () => {
    for (const uri of [
      '../source',
      'http://evil.example/x.ts',
      '/etc/passwd',
      'a/b.ts',
      'seg.exe',
    ]) {
      await expect(rewritePlaylist(`#EXTM3U\n#EXTINF:6,\n${uri}\n`, map)).rejects.toThrow(
        'Unexpected URI',
      );
    }
  });
});

describe('HTTP Range parsing', () => {
  it('handles explicit, open-ended and suffix ranges', () => {
    expect(parseRange(undefined, 100)).toBeNull();
    expect(parseRange('bytes=0-9', 100)).toEqual({ start: 0, end: 9 });
    expect(parseRange('bytes=90-', 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange('bytes=50-500', 100)).toEqual({ start: 50, end: 99 });
    expect(parseRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange('bytes=-500', 100)).toEqual({ start: 0, end: 99 });
  });

  it('rejects unsatisfiable or malformed ranges', () => {
    for (const bad of [
      'bytes=100-',
      'bytes=9-2',
      'bytes=-0',
      'bytes=-',
      'items=0-1',
      'bytes=0-1,5-6',
      'bytes=a-b',
    ]) {
      expect(parseRange(bad, 100), bad).toBe('invalid');
    }
  });
});

describe('signing and policy helpers', () => {
  it('signs CDN URLs with an HMAC over path, expiry and download name', async () => {
    const signer = new HmacCdnUrlSigner('https://cdn.a5roofing.example', 'c'.repeat(32), {
      now: () => 1_800_000_000_000,
    });
    const url = new URL(
      await signer.sign('media/org/asset 1/hls/720p_00001.ts', {
        expiresInSeconds: 600,
        downloadName: 'a b.mp4',
      }),
    );
    expect(url.origin).toBe('https://cdn.a5roofing.example');
    expect(url.pathname).toBe('/media/org/asset%201/hls/720p_00001.ts');
    expect(url.searchParams.get('expires')).toBe('1800000600');
    expect(url.searchParams.get('download')).toBe('a b.mp4');
    expect(url.searchParams.get('signature')).toBe(
      HmacCdnUrlSigner.signature('c'.repeat(32), url.pathname, 1_800_000_600, 'a b.mp4'),
    );
    expect(url.searchParams.get('signature')).not.toBe(
      HmacCdnUrlSigner.signature('d'.repeat(32), url.pathname, 1_800_000_600, 'a b.mp4'),
    );
  });

  it('reads the watch policy from a grant, field by field, falling back to defaults', () => {
    expect(parsePlaybackPolicy(undefined)).toEqual({
      maxCreditedPlaybackRate: 2,
      completionPercent: 98,
      minWatchPercent: null,
      allowSeekAhead: true,
    });
    expect(
      parsePlaybackPolicy({
        minWatchPercent: 85,
        maxCreditedPlaybackRate: 1.25,
        allowSeekAhead: false,
      }),
    ).toEqual({
      maxCreditedPlaybackRate: 1.25,
      completionPercent: 98,
      minWatchPercent: 85,
      allowSeekAhead: false,
    });
    // Out-of-range values never loosen the limits.
    expect(
      parsePlaybackPolicy({
        maxCreditedPlaybackRate: 50,
        completionPercent: -1,
        minWatchPercent: 'all',
      }),
    ).toMatchObject({
      maxCreditedPlaybackRate: 2,
      completionPercent: 98,
      minWatchPercent: null,
    });
  });

  it('keeps only a display file name', () => {
    expect(sanitizeFilename('../../etc/passwd')).toBe('passwd');
    expect(sanitizeFilename('C:\\Users\\rep\\Week 1 .mp4')).toBe('Week 1 .mp4');
    expect(sanitizeFilename('bad\u0000name\n.pdf')).toBe('badname.pdf');
    expect(sanitizeFilename('   ')).toBe('upload');
    expect(sanitizeFilename('x'.repeat(400))).toHaveLength(255);
  });
});

describe('configuration', () => {
  const base = {
    NODE_ENV: 'development',
    DATABASE_URL: 'postgres://a5:pw@127.0.0.1:5432/a5_media',
    REDIS_URL: 'redis://127.0.0.1:6379',
    INTERNAL_AUTH_SECRET: TEST_INTERNAL_SECRET,
  };
  const issues = (env: Record<string, string>) => {
    try {
      loadMediaConfig({ ...base, ...env });
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      return (err as ConfigError).issues.map((i) => i.message);
    }
    return [];
  };

  it('builds local-driver defaults with the dev-storage base URL', () => {
    const c = loadMediaConfig({
      ...base,
      STORAGE_SIGNING_SECRET: 's'.repeat(32),
      PUBLIC_API_URL: 'https://api.a5roofing.example/',
    });
    expect(c.media.storage).toMatchObject({
      driver: 'local',
      publicBaseUrl: 'https://api.a5roofing.example/api/v1/media/dev-storage',
    });
    expect(c.media.limits).toEqual({
      video: 2048 * 1024 ** 2,
      document: 50 * 1024 ** 2,
      image: 10 * 1024 ** 2,
      caption: 2 * 1024 ** 2,
    });
    expect(c.media.scanner).toEqual({ kind: 'none' });
    const app = loadMediaConfig({ ...base, STORAGE_SIGNING_SECRET: 's'.repeat(32) });
    expect(app.media.storage).toMatchObject({
      publicBaseUrl: 'http://localhost:5173/api/v1/media/dev-storage',
    });
  });

  it('keeps development storage out of the package: relative roots resolve against the workspace root', () => {
    const pkg = dirname(dirname(fileURLToPath(import.meta.url)));
    const workspaceRoot = join(pkg, '..', '..');
    expect(resolveStorageRoot('./storage', pkg)).toBe(join(workspaceRoot, 'storage'));
    expect(resolveStorageRoot('./storage', join(pkg, 'src'))).toBe(join(workspaceRoot, 'storage'));
    expect(resolveStorageRoot('/var/a5/objects', pkg)).toBe('/var/a5/objects');
    // Outside any workspace the working directory is used.
    expect(resolveStorageRoot('data/objects', '/')).toBe('/data/objects');
    expect(
      loadMediaConfig({
        ...base,
        STORAGE_SIGNING_SECRET: 's'.repeat(32),
        STORAGE_LOCAL_ROOT: './storage',
      }).media.storage,
    ).toMatchObject({ root: join(workspaceRoot, 'storage') });
  });

  it('honours the per-kind size limits', () => {
    const c = loadMediaConfig({
      ...base,
      STORAGE_SIGNING_SECRET: 's'.repeat(32),
      MEDIA_MAX_VIDEO_MB: '100',
      MEDIA_MAX_DOCUMENT_MB: '5',
      MEDIA_MAX_IMAGE_MB: '2',
      MEDIA_MAX_CAPTION_MB: '1',
    });
    expect(c.media.limits).toEqual({
      video: 100 * 1024 ** 2,
      document: 5 * 1024 ** 2,
      image: 2 * 1024 ** 2,
      caption: 1024 ** 2,
    });
  });

  it('fails fast on missing or inconsistent storage settings', () => {
    expect(issues({})).toEqual([
      'STORAGE_SIGNING_SECRET is required when STORAGE_DRIVER=local (run `pnpm keys:generate`)',
    ]);
    expect(issues({ STORAGE_DRIVER: 's3' })).toEqual([
      'S3_BUCKET is required when STORAGE_DRIVER=s3',
      'S3_REGION is required when STORAGE_DRIVER=s3',
    ]);
    expect(
      issues({
        STORAGE_DRIVER: 's3',
        S3_BUCKET: 'a5-academy',
        S3_REGION: 'us-east-1',
        S3_ACCESS_KEY_ID: 'k',
      })[0],
    ).toMatch(/must be set together/);
    expect(
      issues({ STORAGE_SIGNING_SECRET: 's'.repeat(32), CDN_BASE_URL: 'https://cdn.example.com' }),
    ).toEqual(['CDN_SIGNING_SECRET is required when CDN_BASE_URL is set']);
    expect(issues({ STORAGE_SIGNING_SECRET: 's'.repeat(32), MALWARE_SCANNER: 'clamav' })).toEqual([
      'CLAMAV_HOST is required when MALWARE_SCANNER=clamav',
    ]);
    expect(issues({ STORAGE_SIGNING_SECRET: 'short' })[0]).toMatch(
      /STORAGE_SIGNING_SECRET|at least 32/,
    );
  });

  it('refuses development storage and scanning in staging and production', () => {
    const prod = { NODE_ENV: 'production', STORAGE_SIGNING_SECRET: 's'.repeat(32) };
    const messages = issues(prod);
    expect(messages.some((m) => m.includes('STORAGE_DRIVER must be s3'))).toBe(false);
    expect(issues({ ...prod, CLAMAV_HOST: 'clamav' }).join('\n')).toContain(
      'STORAGE_DRIVER must be s3',
    );
    const ok = loadMediaConfig({
      ...base,
      NODE_ENV: 'production',
      STORAGE_DRIVER: 's3',
      S3_BUCKET: 'a5-academy',
      S3_REGION: 'us-east-1',
      CLAMAV_HOST: 'clamav.internal',
      CDN_BASE_URL: 'https://cdn.a5roofing.example',
      CDN_SIGNING_SECRET: 'c'.repeat(32),
    });
    expect(ok.media.scanner).toMatchObject({ kind: 'clamav', host: 'clamav.internal', port: 3310 });
    expect(ok.media.cdn).toEqual({
      baseUrl: 'https://cdn.a5roofing.example',
      signingSecret: 'c'.repeat(32),
    });
  });
});

/** Minimal clamd: understands PING and zINSTREAM and reports EICAR as infected. */
function fakeClamd(): Promise<{
  server: Server;
  port: number;
  behaviour: { mode: 'normal' | 'error' | 'hangup' };
}> {
  const behaviour = { mode: 'normal' as 'normal' | 'error' | 'hangup' };
  const server = createServer((socket: Socket) => {
    let buffer = Buffer.alloc(0);
    let command: string | null = null;
    let payload = Buffer.alloc(0);
    socket.on('data', (data) => {
      buffer = Buffer.concat([buffer, data]);
      if (command === null) {
        const nul = buffer.indexOf(0);
        if (nul === -1) return;
        command = buffer.subarray(0, nul).toString();
        buffer = buffer.subarray(nul + 1);
        if (command === 'zPING') return void socket.end('PONG\0');
        if (behaviour.mode === 'hangup') return void socket.destroy();
      }
      while (buffer.length >= 4) {
        const size = buffer.readUInt32BE(0);
        if (size === 0) {
          const text = payload.toString('latin1');
          if (behaviour.mode === 'error')
            return void socket.end('INSTREAM size limit exceeded. ERROR\0');
          return void socket.end(
            text.includes('EICAR-STANDARD-ANTIVIRUS-TEST-FILE')
              ? 'stream: Win.Test.EICAR_HDB-1 FOUND\0'
              : 'stream: OK\0',
          );
        }
        if (buffer.length < 4 + size) return;
        payload = Buffer.concat([payload, buffer.subarray(4, 4 + size)]);
        buffer = buffer.subarray(4 + size);
      }
    });
    socket.on('error', () => undefined);
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({ server, port: (server.address() as { port: number }).port, behaviour }),
    ),
  );
}

describe('ClamAvScanner', () => {
  let clamd: Awaited<ReturnType<typeof fakeClamd>>;
  let dir: string;

  beforeAll(async () => {
    clamd = await fakeClamd();
    dir = await mkdtemp(join(tmpdir(), 'a5-clam-'));
  });
  afterAll(async () => {
    clamd.server.close();
    await rm(dir, { recursive: true, force: true });
  });

  const scanner = () =>
    new ClamAvScanner({ host: '127.0.0.1', port: clamd.port, timeoutMs: 5_000, chunkSize: 1024 });

  it('streams a file over INSTREAM and reports clean and infected files', async () => {
    clamd.behaviour.mode = 'normal';
    const clean = join(dir, 'clean.pdf');
    await writeFile(clean, Buffer.alloc(10_000, 7));
    expect(await scanner().scanFile(clean)).toEqual({ status: 'clean', engine: 'clamav' });

    const dirty = join(dir, 'dirty.pdf');
    await writeFile(
      dirty,
      Buffer.concat([
        Buffer.alloc(5_000, 1),
        Buffer.from('X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*'),
        Buffer.alloc(5_000, 1),
      ]),
    );
    expect(await scanner().scanFile(dirty)).toEqual({
      status: 'infected',
      engine: 'clamav',
      signature: 'Win.Test.EICAR_HDB-1',
    });
    await expect(scanner().ping()).resolves.toBeUndefined();
  });

  it('throws (so the job is retried) when clamd errors, hangs up or is unreachable', async () => {
    const file = join(dir, 'any.bin');
    await writeFile(file, Buffer.alloc(100, 3));
    clamd.behaviour.mode = 'error';
    await expect(scanner().scanFile(file)).rejects.toThrow(/could not scan the file/);
    clamd.behaviour.mode = 'hangup';
    await expect(scanner().scanFile(file)).rejects.toThrow();
    const dead = new ClamAvScanner({ host: '127.0.0.1', port: 1, timeoutMs: 1_000 });
    await expect(dead.scanFile(file)).rejects.toThrow(/clamd is unreachable/);
    await expect(dead.ping()).rejects.toThrow(/clamd is unreachable/);
    clamd.behaviour.mode = 'normal';
  });

  it('parses clamd replies', () => {
    expect(parseClamdReply('stream: OK')).toEqual({ status: 'clean', engine: 'clamav' });
    expect(parseClamdReply('stream: Eicar-Signature FOUND')).toMatchObject({
      status: 'infected',
      signature: 'Eicar-Signature',
    });
    expect(() => parseClamdReply('')).toThrow('empty reply');
    expect(() => parseClamdReply("stream: Can't open file ERROR")).toThrow();
  });

  it('the development scanner records that scanning was skipped', async () => {
    expect(await new NoopScanner(testLogger()).scanFile('/nonexistent')).toEqual({
      status: 'skipped',
      engine: 'none',
    });
  });
});
