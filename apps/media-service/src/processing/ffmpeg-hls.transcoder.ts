import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { HLS_PLAYLIST_FILE } from '../storage/keys.js';
import { ProcessError, lastLine, runProcess } from './process-runner.js';
import {
  HLS_SEGMENT_SECONDS,
  planLadder,
  type HlsOutput,
  type HlsRenditionOutput,
  type MediaProbe,
  type Transcoder,
} from './transcoder.js';

export interface FfmpegOptions {
  ffmpegPath: string;
  ffprobePath: string;
  /** Upper bound for one transcode. */
  timeoutMs: number;
}

/** Raised when the input itself is unusable (not a transient failure). */
export class InvalidMediaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidMediaError';
  }
}

interface ProbeJson {
  format?: { format_name?: string; duration?: string };
  streams?: Array<{
    codec_type?: string;
    codec_name?: string;
    width?: number;
    height?: number;
    channels?: number;
    duration?: string;
    tags?: { rotate?: string };
    side_data_list?: Array<{ rotation?: number }>;
  }>;
}

/** Parse an HLS attribute list (`BANDWIDTH=800000,RESOLUTION=640x360,CODECS="avc1,mp4a"`). */
export function parseAttributes(list: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
  for (let m = re.exec(list); m; m = re.exec(list)) out[m[1]!] = m[2]!.replace(/^"|"$/g, '');
  return out;
}

/** Variant streams declared in a master playlist. */
export function parseMasterPlaylist(
  text: string,
): Array<{
  uri: string;
  bandwidth: number;
  width: number | null;
  height: number | null;
  codecs: string | null;
}> {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  const variants: Array<{
    uri: string;
    bandwidth: number;
    width: number | null;
    height: number | null;
    codecs: string | null;
  }> = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.startsWith('#EXT-X-STREAM-INF:')) continue;
    const attrs = parseAttributes(line.slice('#EXT-X-STREAM-INF:'.length));
    const uri = lines.slice(i + 1).find((l) => l && !l.startsWith('#'));
    if (!uri) continue;
    const [w, h] = (attrs.RESOLUTION ?? '').split('x').map(Number);
    variants.push({
      uri,
      bandwidth: Number(attrs.BANDWIDTH ?? 0),
      width: Number.isFinite(w) && w ? w : null,
      height: Number.isFinite(h) && h ? h : null,
      codecs: attrs.CODECS ?? null,
    });
  }
  return variants;
}

export class FfmpegHlsTranscoder implements Transcoder {
  constructor(private readonly options: FfmpegOptions) {}

  async probe(inputPath: string): Promise<MediaProbe> {
    let stdout: string;
    try {
      ({ stdout } = await runProcess(
        this.options.ffprobePath,
        ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', inputPath],
        { timeoutMs: 120_000 },
      ));
    } catch (err) {
      if (err instanceof ProcessError && err.exitCode !== null) {
        throw new InvalidMediaError(
          `The file could not be read as media (${lastLine(err.stderrTail) || 'unknown format'}).`,
        );
      }
      throw err;
    }
    const json = JSON.parse(stdout) as ProbeJson;
    const streams = json.streams ?? [];
    const v = streams.find((s) => s.codec_type === 'video' && s.width && s.height);
    const a = streams.find((s) => s.codec_type === 'audio');
    let video: MediaProbe['video'] = null;
    if (v) {
      const rotation = Number(
        v.side_data_list?.find((d) => d.rotation !== undefined)?.rotation ?? v.tags?.rotate ?? 0,
      );
      const quarter = Math.abs(rotation) % 180 === 90;
      video = {
        width: quarter ? v.height! : v.width!,
        height: quarter ? v.width! : v.height!,
        codec: v.codec_name ?? 'unknown',
      };
    }
    const durations = [json.format?.duration, v?.duration]
      .map(Number)
      .filter((d) => Number.isFinite(d) && d > 0);
    return {
      formatName: json.format?.format_name ?? 'unknown',
      durationSeconds: durations.length ? Math.round(durations[0]! * 1000) / 1000 : null,
      video,
      audio: a ? { codec: a.codec_name ?? 'unknown', channels: a.channels ?? 2 } : null,
    };
  }

  async transcodeToHls(
    inputPath: string,
    outputDir: string,
    probe: MediaProbe,
  ): Promise<HlsOutput> {
    if (!probe.video)
      throw new InvalidMediaError('The file does not contain a playable video track.');
    const plan = planLadder(probe.video.width, probe.video.height);
    const landscape = probe.video.width >= probe.video.height;
    const n = plan.length;
    const filter = [
      `[0:v]split=${n}${plan.map((_, i) => `[v${i}]`).join('')}`,
      ...plan.map(
        (r, i) =>
          `[v${i}]scale=${landscape ? `-2:${r.size}` : `${r.size}:-2`},setsar=1,format=yuv420p[v${i}o]`,
      ),
    ].join(';');

    const args = ['-hide_banner', '-nostdin', '-y', '-i', inputPath, '-filter_complex', filter];
    plan.forEach((_, i) => args.push('-map', `[v${i}o]`));
    if (probe.audio) plan.forEach(() => args.push('-map', '0:a:0'));
    args.push('-c:v', 'libx264', '-preset', 'veryfast', '-sc_threshold', '0');
    args.push('-force_key_frames', `expr:gte(t,n_forced*${HLS_SEGMENT_SECONDS})`);
    plan.forEach((r, i) => {
      args.push(
        `-profile:v:${i}`,
        r.size <= 360 ? 'main' : 'high',
        `-b:v:${i}`,
        `${r.videoKbps}k`,
        `-maxrate:v:${i}`,
        `${Math.round(r.videoKbps * 1.07)}k`,
        `-bufsize:v:${i}`,
        `${Math.round(r.videoKbps * 1.5)}k`,
      );
    });
    if (probe.audio) {
      args.push('-c:a', 'aac', '-ac', '2', '-ar', '48000');
      plan.forEach((r, i) => args.push(`-b:a:${i}`, `${r.audioKbps}k`));
    }
    const streamMap = plan
      .map((r, i) => (probe.audio ? `v:${i},a:${i},name:${r.name}` : `v:${i},name:${r.name}`))
      .join(' ');
    args.push(
      '-f',
      'hls',
      '-hls_time',
      String(HLS_SEGMENT_SECONDS),
      '-hls_playlist_type',
      'vod',
      '-hls_list_size',
      '0',
      '-hls_flags',
      'independent_segments',
      '-hls_segment_type',
      'mpegts',
      '-hls_segment_filename',
      join(outputDir, '%v_%05d.ts'),
      '-master_pl_name',
      'master.m3u8',
      '-var_stream_map',
      streamMap,
      join(outputDir, '%v.m3u8'),
    );

    try {
      await runProcess(this.options.ffmpegPath, args, { timeoutMs: this.options.timeoutMs });
    } catch (err) {
      if (
        err instanceof ProcessError &&
        err.exitCode !== null &&
        /Invalid data|could not find codec|does not contain any stream/i.test(err.stderrTail)
      ) {
        throw new InvalidMediaError(
          `The video could not be decoded (${lastLine(err.stderrTail)}).`,
        );
      }
      throw err;
    }

    const files = (await readdir(outputDir)).sort();
    const masterText = await readFile(join(outputDir, 'master.m3u8'), 'utf8');
    const variants = parseMasterPlaylist(masterText);
    const renditions: HlsRenditionOutput[] = plan.map((r) => {
      const playlistFile = `${r.name}.m3u8`;
      const variant = variants.find((v) => v.uri === playlistFile);
      if (!variant || !files.includes(playlistFile))
        throw new Error(`ffmpeg did not produce the ${r.name} rendition`);
      return {
        name: r.name,
        width: variant.width ?? r.width,
        height: variant.height ?? r.height,
        bandwidth: variant.bandwidth || r.videoKbps * 1000,
        codecs: variant.codecs,
        playlistFile,
      };
    });
    for (const f of files) {
      if (f.endsWith('.m3u8') && !HLS_PLAYLIST_FILE.test(f))
        throw new Error(`Unexpected HLS output file ${f}`);
    }
    return { masterFile: 'master.m3u8', renditions, files };
  }

  async thumbnail(inputPath: string, outputPath: string, atSeconds: number): Promise<void> {
    const grab = (at: number) =>
      runProcess(
        this.options.ffmpegPath,
        [
          '-hide_banner',
          '-nostdin',
          '-y',
          '-ss',
          at.toFixed(3),
          '-i',
          inputPath,
          '-frames:v',
          '1',
          '-vf',
          "scale='min(1280,iw)':-2",
          '-q:v',
          '3',
          outputPath,
        ],
        { timeoutMs: 120_000 },
      );
    await grab(Math.max(0, atSeconds));
    const written = await stat(outputPath).catch(() => null);
    if (!written || written.size === 0) {
      // Seeking past the last decodable frame writes nothing; fall back to the first frame.
      await grab(0);
      const retry = await stat(outputPath).catch(() => null);
      if (!retry || retry.size === 0)
        throw new InvalidMediaError('A poster frame could not be extracted from the video.');
    }
  }
}
