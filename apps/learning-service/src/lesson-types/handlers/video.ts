import { learning } from '@a5/contracts';
import { defineLessonType } from '../types.js';

type VideoConfig = learning.VideoLessonConfig;

/** The lesson's minimum, or the program default when the lesson does not set one. */
export function effectiveMinWatchPercent(
  config: VideoConfig,
  settings: learning.ProgramSettings,
): number {
  return config.minWatchPercent ?? settings.defaultMinWatchPercent;
}

export const videoLesson = defineLessonType<VideoConfig>({
  type: 'video',
  label: 'Video',
  configSchema: learning.videoLessonConfigSchema,
  completion: 'video',
  learnerCompletion(config, { settings, progress }) {
    const min = effectiveMinWatchPercent(config, settings);
    if (config.completion === 'auto') {
      return {
        allowed: false,
        reason: `This video completes automatically once you have watched ${min}% of it.`,
      };
    }
    const watched = progress?.data.watchedPercent ?? 0;
    return watched >= min
      ? { allowed: true, reason: 'You watched enough of the video to mark it complete.' }
      : {
          allowed: false,
          reason: `Watch at least ${min}% of the video before marking it complete (you are at ${Math.floor(watched)}%).`,
        };
  },
  completionHint(config, settings) {
    const min = effectiveMinWatchPercent(config, settings);
    return config.completion === 'auto'
      ? `Completes automatically when you have watched ${min}% of the video.`
      : `Watch at least ${min}% of the video, then mark it complete.`;
  },
  /**
   * Policy keys are the ones media-service reads: `minWatchPercent`, `allowSeekAhead` (our
   * `allowSkipping`) and `maxCreditedPlaybackRate`. `completionPercent` is left to media's default
   * (98); whether the lesson is complete stays decided here, from video.progressed/completed.
   */
  grant(config, settings) {
    return {
      resource: { type: 'media', id: config.mediaAssetId },
      policy: {
        minWatchPercent: effectiveMinWatchPercent(config, settings),
        allowSeekAhead: config.allowSkipping,
        maxCreditedPlaybackRate: config.maxCreditedPlaybackRate,
      },
    };
  },
  references(config) {
    return { mediaAssetIds: [config.mediaAssetId] };
  },
});
