// API contracts for the media domain. Shared by media-service and the web app.
import { z } from 'zod';
import {
  isoDateTime,
  nameString,
  optionalText,
  pageQuerySchema,
  pageSchema,
  queryBoolean,
  queryList,
} from './common.js';

// ------------------------------------------------------------------ enums

export const MEDIA_KINDS = ['video', 'document', 'image', 'caption'] as const;
export const mediaKindSchema = z.enum(MEDIA_KINDS);
export type MediaKind = z.infer<typeof mediaKindSchema>;

export const MEDIA_STATUSES = [
  'awaiting_upload',
  'uploaded',
  'scanning',
  'processing',
  'ready',
  'failed',
  'rejected',
  'archived',
] as const;
export const mediaStatusSchema = z.enum(MEDIA_STATUSES);
export type MediaStatus = z.infer<typeof mediaStatusSchema>;

export const SCAN_STATUSES = ['pending', 'clean', 'infected', 'skipped', 'error'] as const;
export const scanStatusSchema = z.enum(SCAN_STATUSES);
export type ScanStatus = z.infer<typeof scanStatusSchema>;

/**
 * MIME types accepted per kind. The service validates against the same list (plus magic bytes),
 * so the web app can reject unsupported files before uploading.
 */
export const MEDIA_MIME_TYPES = {
  video: ['video/mp4', 'video/quicktime', 'video/webm', 'video/x-matroska'],
  document: [
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ],
  image: ['image/png', 'image/jpeg', 'image/webp'],
  caption: ['text/vtt'],
} as const satisfies Record<MediaKind, readonly string[]>;

/** File name extensions accepted for each MIME type. */
export const MEDIA_FILE_EXTENSIONS: Record<string, readonly string[]> = {
  'video/mp4': ['mp4', 'm4v'],
  'video/quicktime': ['mov'],
  'video/webm': ['webm'],
  'video/x-matroska': ['mkv'],
  'application/pdf': ['pdf'],
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['docx'],
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': ['pptx'],
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['xlsx'],
  'image/png': ['png'],
  'image/jpeg': ['jpg', 'jpeg'],
  'image/webp': ['webp'],
  'text/vtt': ['vtt'],
};

/** BCP 47 language tag such as `en`, `en-US` or `es-419`. */
export const languageTagSchema = z
  .string()
  .trim()
  .regex(/^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})*$/, 'Use a language code such as en or es-US');

// ------------------------------------------------------------------ uploads

const fileName = z
  .string()
  .trim()
  .min(1, 'Required')
  .max(255, 'Use a file name with at most 255 characters');

const uploadFields = {
  title: nameString(200),
  description: optionalText(2000),
  filename: fileName,
  mimeType: z.string().trim().toLowerCase().min(3).max(127),
  sizeBytes: z.int().positive('The file is empty').max(Number.MAX_SAFE_INTEGER),
};

export const captionLinkSchema = z.object({
  /** Video the captions belong to. */
  videoAssetId: z.uuid(),
  language: languageTagSchema,
  label: nameString(80),
  isDefault: z.boolean().default(false),
});
export type CaptionLink = z.infer<typeof captionLinkSchema>;

export const createUploadRequestSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('video'), ...uploadFields }),
  z.object({ kind: z.literal('document'), ...uploadFields }),
  z.object({ kind: z.literal('image'), ...uploadFields }),
  z.object({ kind: z.literal('caption'), ...uploadFields, caption: captionLinkSchema }),
]);
export type CreateUploadRequest = z.infer<typeof createUploadRequestSchema>;

export const uploadTargetSchema = z.object({
  method: z.enum(['POST', 'PUT']),
  url: z.string(),
  /** Form fields for POST uploads; they must precede the file field. */
  fields: z.record(z.string(), z.string()),
  /** Headers the client must send with PUT uploads. */
  headers: z.record(z.string(), z.string()),
  expiresAt: isoDateTime,
});
export type UploadTarget = z.infer<typeof uploadTargetSchema>;

export const createUploadResponseSchema = z.object({
  assetId: z.uuid(),
  upload: uploadTargetSchema,
  maxBytes: z.int(),
});
export type CreateUploadResponse = z.infer<typeof createUploadResponseSchema>;

/** Captions for an existing video go through the same upload flow (kind `caption`). */
export const createCaptionUploadRequestSchema = z.object({
  language: languageTagSchema,
  label: nameString(80),
  isDefault: z.boolean().default(false),
  filename: fileName,
  sizeBytes: z.int().positive('The file is empty').max(Number.MAX_SAFE_INTEGER),
});
export type CreateCaptionUploadRequest = z.infer<typeof createCaptionUploadRequestSchema>;

export const createCaptionUploadResponseSchema = createUploadResponseSchema.extend({
  captionId: z.uuid(),
});

// ------------------------------------------------------------------ library

export const mediaAssetSummarySchema = z.object({
  id: z.uuid(),
  kind: mediaKindSchema,
  title: z.string(),
  description: z.string().nullable(),
  originalFilename: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number(),
  status: mediaStatusSchema,
  scanStatus: scanStatusSchema,
  durationSeconds: z.number().nullable(),
  width: z.int().nullable(),
  height: z.int().nullable(),
  /** Short-lived signed URL of the poster frame (videos) or the image itself (images). */
  thumbnailUrl: z.string().nullable(),
  /** Readable reason when the asset failed processing or was rejected. */
  error: z.string().nullable(),
  createdBy: z.uuid(),
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
  readyAt: isoDateTime.nullable(),
  archivedAt: isoDateTime.nullable(),
});
export type MediaAssetSummary = z.infer<typeof mediaAssetSummarySchema>;

export const renditionSchema = z.object({
  name: z.string(),
  width: z.int(),
  height: z.int(),
  bandwidth: z.int(),
  codecs: z.string().nullable(),
});
export type Rendition = z.infer<typeof renditionSchema>;

export const captionSchema = z.object({
  id: z.uuid(),
  captionAssetId: z.uuid(),
  language: z.string(),
  label: z.string(),
  isDefault: z.boolean(),
  status: mediaStatusSchema,
  url: z.string().nullable(),
});
export type Caption = z.infer<typeof captionSchema>;

export const chapterSchema = z.object({
  id: z.uuid(),
  startSeconds: z.number(),
  title: z.string(),
  position: z.int(),
});
export type Chapter = z.infer<typeof chapterSchema>;

export const transcriptSegmentSchema = z
  .object({
    startSeconds: z.number().min(0).max(86_400),
    endSeconds: z.number().min(0).max(86_400),
    text: z.string().trim().min(1).max(2_000),
    speaker: z.string().trim().max(80).nullable().optional(),
  })
  .refine((s) => s.endSeconds > s.startSeconds, {
    path: ['endSeconds'],
    message: 'Must be after the start',
  });
export type TranscriptSegment = z.infer<typeof transcriptSegmentSchema>;

export const transcriptSchema = z.object({
  language: z.string(),
  segments: z.array(transcriptSegmentSchema),
  updatedAt: isoDateTime,
});
export type Transcript = z.infer<typeof transcriptSchema>;

export const mediaAssetDetailSchema = mediaAssetSummarySchema.extend({
  checksum: z.string().nullable(),
  /** Video a caption asset belongs to. */
  parentAssetId: z.uuid().nullable(),
  /** Signed download URL of the original file (ready assets only). */
  downloadUrl: z.string().nullable(),
  renditions: z.array(renditionSchema),
  captions: z.array(captionSchema),
  chapters: z.array(chapterSchema),
  transcripts: z.array(transcriptSchema),
});
export type MediaAssetDetail = z.infer<typeof mediaAssetDetailSchema>;

export const MEDIA_SORTS = [
  'title',
  'createdAt',
  'updatedAt',
  'sizeBytes',
  'durationSeconds',
] as const;

export const listMediaQuerySchema = pageQuerySchema.extend({
  kind: queryList(mediaKindSchema),
  status: queryList(mediaStatusSchema),
  /** Archived assets are hidden unless requested (or filtered by status). */
  includeArchived: queryBoolean,
});
export type ListMediaQuery = z.infer<typeof listMediaQuerySchema>;

export const mediaPageSchema = pageSchema(mediaAssetSummarySchema);

export const updateMediaRequestSchema = z
  .object({ title: nameString(200).optional(), description: optionalText(2000) })
  .refine((v) => v.title !== undefined || v.description !== undefined, {
    message: 'Nothing to update',
  });
export type UpdateMediaRequest = z.infer<typeof updateMediaRequestSchema>;

const startSeconds = z.number().min(0, 'Must be zero or more').max(86_400);

export const createChapterRequestSchema = z.object({ startSeconds, title: nameString(120) });
export type CreateChapterRequest = z.infer<typeof createChapterRequestSchema>;

export const updateChapterRequestSchema = z
  .object({ startSeconds: startSeconds.optional(), title: nameString(120).optional() })
  .refine((v) => v.startSeconds !== undefined || v.title !== undefined, {
    message: 'Nothing to update',
  });
export type UpdateChapterRequest = z.infer<typeof updateChapterRequestSchema>;

export const chapterListSchema = z.object({ items: z.array(chapterSchema) });

export const updateCaptionRequestSchema = z
  .object({ label: nameString(80).optional(), isDefault: z.boolean().optional() })
  .refine((v) => v.label !== undefined || v.isDefault !== undefined, {
    message: 'Nothing to update',
  });
export type UpdateCaptionRequest = z.infer<typeof updateCaptionRequestSchema>;

export const setTranscriptRequestSchema = z.object({
  language: languageTagSchema,
  segments: z.array(transcriptSegmentSchema).max(20_000),
});
export type SetTranscriptRequest = z.infer<typeof setTranscriptRequestSchema>;

// ------------------------------------------------------------------ playback

/**
 * Watch policy carried by the lesson grant (configured on the lesson in learning-service).
 * Missing values fall back to these defaults.
 */
export const playbackPolicySchema = z.object({
  /** Highest playback rate that still earns full watch credit. Faster viewing is not credited. */
  maxCreditedPlaybackRate: z.number().min(0.25).max(4).default(2),
  /** Credited percentage at which `video.completed` is emitted. */
  completionPercent: z.number().min(1).max(100).default(98),
  /** Lesson minimum the learner must reach (informational for the player; learning enforces it). */
  minWatchPercent: z.number().min(0).max(100).nullable().default(null),
  /** Whether the player lets the learner skip ahead of what they have watched. */
  allowSeekAhead: z.boolean().default(true),
});
export type PlaybackPolicy = z.infer<typeof playbackPolicySchema>;

export const playbackRequestSchema = z.object({ grant: z.string().min(20).max(8_192) });
export type PlaybackRequest = z.infer<typeof playbackRequestSchema>;

export const playbackCaptionSchema = z.object({
  id: z.uuid(),
  language: z.string(),
  label: z.string(),
  isDefault: z.boolean(),
  url: z.string(),
});

export const playbackResumeSchema = z.object({
  positionSeconds: z.number(),
  watchedPercent: z.number(),
  completed: z.boolean(),
});
export type PlaybackResume = z.infer<typeof playbackResumeSchema>;

export const playbackDescriptorSchema = z.object({
  assetId: z.uuid(),
  title: z.string(),
  /** `hls`: adaptive stream (url is the master playlist); `progressive`: single file; `document`: PDF/image. */
  kind: z.enum(['hls', 'progressive', 'document']),
  mimeType: z.string(),
  url: z.string(),
  posterUrl: z.string().nullable(),
  durationSeconds: z.number().nullable(),
  captions: z.array(playbackCaptionSchema),
  chapters: z.array(chapterSchema),
  /** Learner's saved progress; null for previews and documents. */
  resume: playbackResumeSchema.nullable(),
  policy: playbackPolicySchema,
  /** Signed token for watch telemetry (heartbeats and beacons); null for previews and documents. */
  playbackToken: z.string().nullable(),
  heartbeatIntervalSeconds: z.int(),
  /** URLs and tokens stop working at this time; request a new descriptor to continue. */
  expiresAt: isoDateTime,
});
export type PlaybackDescriptor = z.infer<typeof playbackDescriptorSchema>;

export const watchIntervalSchema = z
  .object({
    /** Content time (seconds) where continuous playback started. */
    start: z.number().min(0).max(86_400),
    /** Content time (seconds) where it stopped (pause, seek, end, or heartbeat cut). */
    end: z.number().min(0).max(86_400),
    /** Playback rate used during the interval. */
    rate: z.number().gt(0).max(16),
  })
  .refine((i) => i.end >= i.start, { path: ['end'], message: 'Must not be before the start' });
export type WatchInterval = z.infer<typeof watchIntervalSchema>;

/**
 * Watch telemetry. Clients send the intervals played since the last acknowledged heartbeat every
 * ~15 s, and once more via `navigator.sendBeacon` on pause, end or page hide.
 */
export const heartbeatRequestSchema = z.object({
  playbackToken: z.string().min(20).max(4_096),
  intervals: z.array(watchIntervalSchema).max(200).default([]),
  positionSeconds: z.number().min(0).max(86_400),
  ended: z.boolean().default(false),
  clientSentAt: isoDateTime.optional(),
});
export type HeartbeatRequest = z.infer<typeof heartbeatRequestSchema>;

export const heartbeatResponseSchema = z.object({
  /** Total credited content seconds (merged, no double counting). */
  watchedSeconds: z.number(),
  watchedPercent: z.number(),
  /** New content seconds credited by this heartbeat. */
  creditedSeconds: z.number(),
  completed: z.boolean(),
  nextHeartbeatSeconds: z.int(),
});
export type HeartbeatResponse = z.infer<typeof heartbeatResponseSchema>;

// ------------------------------------------------------------------ internal

export const internalMediaAssetSchema = z.object({
  id: z.uuid(),
  organizationId: z.uuid(),
  title: z.string(),
  kind: mediaKindSchema,
  status: mediaStatusSchema,
  durationSeconds: z.number().nullable(),
});
export type InternalMediaAsset = z.infer<typeof internalMediaAssetSchema>;
