import type { Generated, OutboxSchema } from '@a5/database';
import type { MediaKind, MediaStatus, ScanStatus, TranscriptSegment } from '@a5/contracts/media';

export interface MediaAssetsTable {
  id: string;
  organization_id: string;
  kind: MediaKind;
  title: string;
  description: string | null;
  /** Display metadata only; storage keys are generated. */
  original_filename: string;
  storage_key: string;
  mime_type: string;
  size_bytes: number;
  /** SHA-256 (hex) of the source, computed while processing. */
  checksum: string | null;
  status: MediaStatus;
  scan_status: Generated<ScanStatus>;
  duration_seconds: number | null;
  width: number | null;
  height: number | null;
  hls_master_key: string | null;
  thumbnail_key: string | null;
  error: string | null;
  /** Video a caption asset belongs to. */
  parent_asset_id: string | null;
  uploaded_at: Date | null;
  ready_at: Date | null;
  archived_at: Date | null;
  created_by: string;
  updated_by: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface MediaRenditionsTable {
  id: string;
  asset_id: string;
  name: string;
  width: number;
  height: number;
  bandwidth: number;
  codecs: string | null;
  playlist_key: string;
  created_at: Generated<Date>;
}

export interface MediaCaptionsTable {
  id: string;
  /** The video. */
  asset_id: string;
  /** The WebVTT file, uploaded as a media asset of kind `caption`. */
  caption_asset_id: string;
  language: string;
  label: string;
  storage_key: string;
  is_default: boolean;
  created_by: string;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface MediaChaptersTable {
  id: string;
  asset_id: string;
  start_seconds: number;
  title: string;
  position: number;
  created_by: string | null;
  updated_by: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface MediaTranscriptsTable {
  id: string;
  asset_id: string;
  language: string;
  segments: TranscriptSegment[];
  updated_by: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

/** Merged, credited content intervals `[start, end]` in seconds. */
export type IntervalList = Array<[number, number]>;

export interface VideoProgressTable {
  id: string;
  organization_id: string;
  user_id: string;
  asset_id: string;
  context_type: string;
  context_id: string;
  watched_seconds: number;
  duration_seconds: number;
  percent: number;
  last_position_seconds: number;
  intervals: IntervalList;
  started_at: Date;
  completed_at: Date | null;
  /** 5 % boundaries for which `video.progressed` has been emitted. */
  milestones_emitted: number[];
  updated_at: Generated<Date>;
}

export interface MediaDatabase extends OutboxSchema {
  media_assets: MediaAssetsTable;
  media_renditions: MediaRenditionsTable;
  media_captions: MediaCaptionsTable;
  media_chapters: MediaChaptersTable;
  media_transcripts: MediaTranscriptsTable;
  video_progress: VideoProgressTable;
}
