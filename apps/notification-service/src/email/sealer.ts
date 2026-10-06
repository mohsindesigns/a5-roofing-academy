import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

const VERSION = 'v1';

/**
 * Authenticated encryption (AES-256-GCM) for email content that contains one-time links. The
 * sealed text is kept only until the message is delivered or abandoned, so a database or backup
 * never holds a usable activation or reset link.
 */
export class ContentSealer {
  private readonly key: Buffer;

  constructor(secret: string) {
    this.key = Buffer.from(
      hkdfSync('sha256', secret, 'a5-notification-service', 'sealed-email-content-v1', 32),
    );
  }

  seal(value: unknown): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(value), 'utf8'),
      cipher.final(),
    ]);
    return [
      VERSION,
      iv.toString('base64url'),
      cipher.getAuthTag().toString('base64url'),
      ciphertext.toString('base64url'),
    ].join('.');
  }

  /** Throws when the value was tampered with or sealed with another key. */
  unseal<T>(sealed: string): T {
    const [version, iv, tag, ciphertext] = sealed.split('.');
    if (version !== VERSION || !iv || !tag || !ciphertext)
      throw new Error('Unsupported sealed content format');
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    const plain = Buffer.concat([
      decipher.update(Buffer.from(ciphertext, 'base64url')),
      decipher.final(),
    ]);
    return JSON.parse(plain.toString('utf8')) as T;
  }
}
