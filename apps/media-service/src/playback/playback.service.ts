import { Inject, Injectable } from '@nestjs/common';
import { TokenError, verifyLessonGrant, type LessonGrant, type Principal } from '@a5/auth';
import { media } from '@a5/contracts';
import { AppError, ForbiddenError, NotFoundError, PreconditionError } from '@a5/nest-kit';
import { MEDIA_CONFIG, type MediaConfig } from '../config.js';
import { MediaReadService, isPlayable, type AssetRow } from '../library/media-read.service.js';
import { TelemetryService } from '../telemetry/telemetry.service.js';
import { MediaTokens, type HlsTokenClaims, type PlaybackTokenClaims } from './media-tokens.js';
import { parsePlaybackPolicy } from './playback-policy.js';

const PENDING = new Set<media.MediaStatus>([
  'awaiting_upload',
  'uploaded',
  'scanning',
  'processing',
]);

interface DescribeOptions {
  viewerId: string;
  policy: media.PlaybackPolicy;
  /** Learning context for progress; null for administrator previews. */
  context: { type: string; id: string } | null;
}

@Injectable()
export class PlaybackService {
  constructor(
    @Inject(MEDIA_CONFIG) private readonly config: MediaConfig,
    private readonly read: MediaReadService,
    private readonly tokens: MediaTokens,
    private readonly telemetry: TelemetryService,
  ) {}

  /** Exchange a lesson grant issued by learning-service for a playback descriptor. */
  async forLesson(p: Principal, grantToken: string): Promise<media.PlaybackDescriptor> {
    let grant: LessonGrant;
    try {
      grant = await verifyLessonGrant(grantToken, this.config.media.lessonGrantSecret);
    } catch (err) {
      if (err instanceof TokenError && err.code === 'expired') {
        throw new AppError(
          403,
          'GRANT_EXPIRED',
          'This lesson link has expired. Reopen the lesson from your training plan.',
        );
      }
      throw new AppError(
        403,
        'GRANT_INVALID',
        'This lesson link is not valid. Reopen the lesson from your training plan.',
      );
    }
    if (grant.userId !== p.userId || grant.organizationId !== p.organizationId) {
      throw new ForbiddenError(
        'This lesson was opened for a different account. Reopen it from your training plan.',
      );
    }
    if (grant.resource.type !== 'media' && grant.resource.type !== 'document') {
      throw new ForbiddenError('This lesson does not include a video or document.');
    }
    const asset = await this.read.find(grant.organizationId, grant.resource.id);
    if (!asset || asset.kind === 'caption') throw new NotFoundError('Media');
    this.assertPlayable(asset);
    return this.describe(asset, {
      viewerId: p.userId,
      policy: parsePlaybackPolicy(grant.policy),
      context: { type: 'lesson', id: grant.lessonId },
    });
  }

  /** Administrator preview: same descriptor, no progress and no telemetry. */
  async preview(p: Principal, id: string): Promise<media.PlaybackDescriptor> {
    const asset = await this.read.get(p.organizationId, id);
    if (asset.kind === 'caption')
      throw new PreconditionError(
        'NOT_PLAYABLE',
        'Caption files are previewed together with their video.',
      );
    this.assertPlayable(asset);
    return this.describe(asset, {
      viewerId: p.userId,
      policy: parsePlaybackPolicy({}),
      context: null,
    });
  }

  private assertPlayable(asset: AssetRow): void {
    if (isPlayable(asset)) return;
    if (PENDING.has(asset.status)) {
      throw new PreconditionError(
        'MEDIA_NOT_READY',
        'This media is still being processed. Try again in a few minutes.',
      );
    }
    throw new PreconditionError(
      'MEDIA_UNAVAILABLE',
      'This media is not available. Ask your training administrator to replace it.',
    );
  }

  private async describe(
    asset: AssetRow,
    options: DescribeOptions,
  ): Promise<media.PlaybackDescriptor> {
    const ttl = this.config.media.playbackTtlSeconds;
    const sign = (key: string, extra: { contentType?: string } = {}) =>
      this.read.sign(key, { expiresInSeconds: ttl, ...extra });
    const hls = this.tokens.sign<HlsTokenClaims>(
      { typ: 'hls', aid: asset.id, org: asset.organization_id, sub: options.viewerId },
      ttl,
    );
    const isVideo = asset.kind === 'video';

    let kind: media.PlaybackDescriptor['kind'];
    let url: string;
    if (isVideo && asset.hls_master_key) {
      kind = 'hls';
      const master = asset.hls_master_key.slice(asset.hls_master_key.lastIndexOf('/') + 1);
      url = `${this.config.media.publicApiBaseUrl}/api/v1/media/hls/${asset.id}/${master}?token=${encodeURIComponent(hls.token)}`;
    } else {
      kind = isVideo ? 'progressive' : 'document';
      url = await sign(asset.storage_key, { contentType: asset.mime_type });
    }

    const [captions, chapters, resume] = await Promise.all([
      isVideo
        ? this.read.captions(asset.id).then((rows) =>
            Promise.all(
              rows
                .filter((c) => c.status === 'ready')
                .map(async (c) => ({
                  id: c.id,
                  language: c.language,
                  label: c.label,
                  isDefault: c.is_default,
                  url: await sign(c.storage_key, { contentType: 'text/vtt' }),
                })),
            ),
          )
        : Promise.resolve([]),
      isVideo ? this.read.chapters(asset.id) : Promise.resolve([]),
      options.context && isVideo
        ? this.telemetry.resume(
            options.viewerId,
            asset.id,
            options.context.type,
            options.context.id,
            options.policy.completionPercent,
          )
        : Promise.resolve(null),
    ]);

    const playbackToken =
      options.context && isVideo && asset.duration_seconds
        ? this.tokens.sign<PlaybackTokenClaims>(
            {
              typ: 'play',
              sub: options.viewerId,
              org: asset.organization_id,
              aid: asset.id,
              ct: options.context.type,
              ci: options.context.id,
              dur: asset.duration_seconds,
              pol: options.policy,
            },
            ttl,
          ).token
        : null;

    return {
      assetId: asset.id,
      title: asset.title,
      kind,
      mimeType: asset.mime_type,
      url,
      posterUrl: asset.thumbnail_key ? await sign(asset.thumbnail_key) : null,
      durationSeconds: asset.duration_seconds,
      captions,
      chapters,
      resume,
      policy: options.policy,
      playbackToken,
      heartbeatIntervalSeconds: this.config.media.heartbeatIntervalSeconds,
      expiresAt: hls.expiresAt.toISOString(),
    };
  }
}
