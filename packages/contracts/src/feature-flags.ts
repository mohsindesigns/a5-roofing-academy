export const FEATURE_FLAGS = [
  {
    key: 'voice_ai',
    label: 'Voice AI role-play',
    description: 'Speech-to-text and text-to-speech in the AI trainer.',
    default: false,
  },
  {
    key: 'leaderboards',
    label: 'Leaderboards',
    description: 'Team leaderboards for training progress and AI scores.',
    default: false,
  },
  {
    key: 'advanced_reporting',
    label: 'Advanced reporting',
    description: 'Cohort analytics and scheduled exports.',
    default: true,
  },
  {
    key: 'manager_approvals',
    label: 'Manager approvals',
    description: 'Manager approval lessons and certification approvals.',
    default: true,
  },
  {
    key: 'certification_expiration',
    label: 'Certification expiration',
    description: 'Expiry dates, renewal reminders and recertification.',
    default: true,
  },
  {
    key: 'sms_notifications',
    label: 'SMS notifications',
    description: 'Deliver notifications by text message.',
    default: false,
  },
] as const;

export type FeatureFlagKey = (typeof FEATURE_FLAGS)[number]['key'];
export type FeatureFlagState = Record<FeatureFlagKey, boolean>;

export function defaultFeatureFlags(): FeatureFlagState {
  return Object.fromEntries(FEATURE_FLAGS.map((f) => [f.key, f.default])) as FeatureFlagState;
}
