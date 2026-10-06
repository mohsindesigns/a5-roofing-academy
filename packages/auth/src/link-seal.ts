import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

const PREFIX = 'sealed1.';

function keyFrom(secret: string): Buffer {
  return Buffer.from(hkdfSync('sha256', secret, 'a5-link-seal', 'one-time-link-v1', 32));
}

/**
 * Encrypts a one-time link (activation, password reset) before it is written to an event, so the
 * outbox table, the event stream and backups never hold a usable credential. Only services that
 * share `INTERNAL_AUTH_SECRET` can open it, and the notification service does so just in time.
 */
export function sealLink(secret: string, url: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyFrom(secret), iv);
  const body = Buffer.concat([cipher.update(url, 'utf8'), cipher.final()]);
  return `${PREFIX}${[iv, cipher.getAuthTag(), body].map((b) => b.toString('base64url')).join('.')}`;
}

/** Opens a sealed link. Values that were never sealed are returned unchanged. */
export function unsealLink(secret: string, value: string): string {
  if (!value.startsWith(PREFIX)) return value;
  const [iv, tag, body] = value.slice(PREFIX.length).split('.');
  if (!iv || !tag || !body) throw new Error('Malformed sealed link');
  const decipher = createDecipheriv('aes-256-gcm', keyFrom(secret), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(body, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

export const isSealedLink = (value: string): boolean => value.startsWith(PREFIX);
