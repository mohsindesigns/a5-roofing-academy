export interface MediaProbe {
  formatName: string;
  durationSeconds: number | null;
  /** Display dimensions (rotation applied). */
  video: { width: number; height: number; codec: string } | null;
  audio: { codec: string; channels: number } | null;
}

export interface HlsRenditionOutput {
  name: string;
  width: number;
  height: number;
  /** Peak bandwidth from the master playlist (bits per second). */
  bandwidth: number;
  codecs: string | null;
  /** Variant playlist file name inside the output directory. */
  playlistFile: string;
}

export interface HlsOutput {
  /** Master playlist file name inside the output directory. */
  masterFile: string;
  renditions: HlsRenditionOutput[];
  /** Every file written (flat names, no directories). */
  files: string[];
}

/**
 * Turns a source video into an adaptive HLS package and a poster frame. The ffmpeg implementation
 * runs in the worker; a managed service (MediaConvert, Mux) can implement the same contract.
 */
export interface Transcoder {
  probe(inputPath: string): Promise<MediaProbe>;
  transcodeToHls(inputPath: string, outputDir: string, probe: MediaProbe): Promise<HlsOutput>;
  thumbnail(inputPath: string, outputPath: string, atSeconds: number): Promise<void>;
}

export interface LadderRung {
  name: string;
  /** Short side in pixels (height for landscape video). */
  size: number;
  videoKbps: number;
  audioKbps: number;
}

export const HLS_LADDER: readonly LadderRung[] = [
  { name: '360p', size: 360, videoKbps: 800, audioKbps: 96 },
  { name: '720p', size: 720, videoKbps: 2800, audioKbps: 128 },
  { name: '1080p', size: 1080, videoKbps: 5000, audioKbps: 160 },
];

export const HLS_SEGMENT_SECONDS = 6;

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

export interface PlannedRendition extends LadderRung {
  width: number;
  height: number;
}

/**
 * Pick the ladder rungs that do not upscale the source (by its short side, so portrait video is
 * handled). Sources smaller than the lowest rung get a single rendition at their own size.
 */
export function planLadder(
  sourceWidth: number,
  sourceHeight: number,
  ladder: readonly LadderRung[] = HLS_LADDER,
): PlannedRendition[] {
  const landscape = sourceWidth >= sourceHeight;
  const shortSide = Math.min(sourceWidth, sourceHeight);
  const scaled = (size: number) =>
    landscape
      ? { width: even((sourceWidth * size) / sourceHeight), height: size }
      : { width: size, height: even((sourceHeight * size) / sourceWidth) };
  const rungs = ladder.filter((r) => r.size <= shortSide);
  if (rungs.length === 0) {
    const size = even(shortSide);
    const base = ladder[0]!;
    const ratio = size / base.size;
    return [
      {
        name: `${size}p`,
        size,
        videoKbps: Math.max(200, Math.round(base.videoKbps * ratio)),
        audioKbps: base.audioKbps,
        ...scaled(size),
      },
    ];
  }
  return rungs.map((r) => ({ ...r, ...scaled(r.size) }));
}
