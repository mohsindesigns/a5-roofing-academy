import type { Producer } from '@a5/events';

export type Access = 'required' | 'optional' | 'public';
export type RateClass = 'default' | 'login' | 'sensitive' | 'public';

export interface RouteRule {
  prefix: string;
  service: Producer;
  access: Access;
  rate: RateClass;
  /** Long-lived streaming responses (SSE): no upstream timeout, no compression. */
  stream?: boolean;
  /** Allows larger request bodies (multipart image uploads). */
  upload?: boolean;
  /** Restrict to these methods (others fall through to the next rule). */
  methods?: string[];
}

const r = (
  prefix: string,
  service: Producer,
  opts: Partial<Omit<RouteRule, 'prefix' | 'service'>> = {},
): RouteRule => ({ prefix, service, access: 'required', rate: 'default', ...opts });

/**
 * Public API surface. The browser only ever talks to these prefixes; services are reachable
 * nowhere else. Most specific prefixes win.
 */
export const ROUTES: RouteRule[] = [
  // identity
  r('/api/v1/auth/login', 'identity-service', { access: 'public', rate: 'login' }),
  r('/api/v1/auth/refresh', 'identity-service', { access: 'public', rate: 'sensitive' }),
  r('/api/v1/auth/logout', 'identity-service', { access: 'optional', rate: 'sensitive' }),
  r('/api/v1/auth/password/change', 'identity-service', { rate: 'sensitive' }),
  r('/api/v1/auth/password', 'identity-service', { access: 'public', rate: 'sensitive' }),
  r('/api/v1/auth/tokens', 'identity-service', { access: 'public', rate: 'sensitive' }),
  r('/api/v1/auth/activate', 'identity-service', { access: 'public', rate: 'sensitive' }),
  r('/api/v1/auth', 'identity-service'),
  ...[
    'users',
    'roles',
    'permissions',
    'organization',
    'locations',
    'departments',
    'teams',
    'settings',
    'feature-flags',
  ].map((p) => r(`/api/v1/${p}`, 'identity-service')),
  // learning
  ...['programs', 'enrollments', 'lessons', 'progress', 'learning'].map((p) =>
    r(`/api/v1/${p}`, 'learning-service'),
  ),
  // media
  r('/api/v1/media/hls', 'media-service', { access: 'public', rate: 'public' }),
  // navigator.sendBeacon cannot send Authorization headers; the body carries a signed playback token.
  r('/api/v1/media/playback/beacon', 'media-service', { access: 'public', rate: 'default' }),
  r('/api/v1/media/dev-storage', 'media-service', {
    access: 'public',
    rate: 'public',
    upload: true,
  }),
  r('/api/v1/media', 'media-service'),
  // assessment
  ...['question-banks', 'questions', 'assessments', 'attempts'].map((p) =>
    r(`/api/v1/${p}`, 'assessment-service'),
  ),
  // ai coaching
  r('/api/v1/ai', 'ai-coaching-service', { stream: true }),
  // certification
  r('/api/v1/public/certificates', 'certification-service', { access: 'public', rate: 'public' }),
  r('/api/v1/certification-assets', 'certification-service', { upload: true }),
  r('/api/v1/certification-files', 'certification-service', { access: 'public', rate: 'public' }),
  ...[
    'certifications',
    'certificate-templates',
    'certificates',
    'signatories',
    'stamps',
    'certification-settings',
  ].map((p) => r(`/api/v1/${p}`, 'certification-service')),
  // notifications
  r('/api/v1/notifications/stream', 'notification-service', { stream: true }),
  ...['notifications', 'notification-templates', 'notification-rules'].map((p) =>
    r(`/api/v1/${p}`, 'notification-service'),
  ),
  // analytics & audit
  // Signed export downloads are opened by the browser without a bearer token.
  r('/api/v1/reports/files', 'analytics-service', { access: 'public', rate: 'public' }),
  ...['analytics', 'reports'].map((p) => r(`/api/v1/${p}`, 'analytics-service')),
  r('/api/v1/audit', 'audit-service'),
].sort((a, b) => b.prefix.length - a.prefix.length);

/** Find the rule for a path, matching whole segments only. */
export function matchRoute(path: string, method: string): RouteRule | null {
  for (const rule of ROUTES) {
    if (rule.methods && !rule.methods.includes(method)) continue;
    if (path === rule.prefix || path.startsWith(`${rule.prefix}/`)) return rule;
  }
  return null;
}
