import { media } from '@a5/contracts';

const DEFAULTS = media.playbackPolicySchema.parse({});

/**
 * Read the watch policy from a lesson grant. Learning owns the values; unknown keys are ignored and
 * invalid values fall back to the defaults field by field, so a bad value can never loosen crediting
 * beyond the contract's bounds.
 */
export function parsePlaybackPolicy(raw: Record<string, unknown> | undefined): media.PlaybackPolicy {
  const shape = media.playbackPolicySchema.shape;
  const pick = <K extends keyof media.PlaybackPolicy>(key: K): media.PlaybackPolicy[K] => {
    const value = raw?.[key];
    if (value === undefined) return DEFAULTS[key];
    const parsed = shape[key].safeParse(value);
    return parsed.success ? (parsed.data as media.PlaybackPolicy[K]) : DEFAULTS[key];
  };
  return {
    maxCreditedPlaybackRate: pick('maxCreditedPlaybackRate'),
    completionPercent: pick('completionPercent'),
    minWatchPercent: pick('minWatchPercent'),
    allowSeekAhead: pick('allowSeekAhead'),
  };
}
