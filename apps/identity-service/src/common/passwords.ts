import { Injectable } from '@nestjs/common';
import { hash, verify, Algorithm } from '@node-rs/argon2';

const COMMON_PASSWORDS = new Set([
  'password',
  'password1',
  'password123',
  '123456789',
  '1234567890',
  'qwertyuiop',
  'iloveyou',
  'letmein123',
  'welcome123',
  'roofing123',
  'a5roofing',
  'changeme123',
]);

/** OWASP-recommended Argon2id parameters (19 MiB, 2 iterations). */
const OPTIONS = { algorithm: Algorithm.Argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 };

@Injectable()
export class PasswordService {
  private dummyHash: Promise<string> | null = null;

  hash(password: string): Promise<string> {
    return hash(password, OPTIONS);
  }

  async verify(passwordHash: string, password: string): Promise<boolean> {
    try {
      return await verify(passwordHash, password);
    } catch {
      return false;
    }
  }

  /** Spend the same time as a real verification so unknown emails cannot be detected by timing. */
  async verifyAgainstDummy(password: string): Promise<void> {
    this.dummyHash ??= this.hash('not-a-real-password-placeholder');
    await this.verify(await this.dummyHash, password);
  }

  /** Returns a problem description, or null when the password satisfies the policy. */
  policyProblem(
    password: string,
    policy: { minLength: number },
    context: { email?: string; firstName?: string; lastName?: string } = {},
  ): string | null {
    if (password.length < policy.minLength) return `Use at least ${policy.minLength} characters.`;
    if (password.length > 128) return 'Use at most 128 characters.';
    const lower = password.toLowerCase();
    if (COMMON_PASSWORDS.has(lower))
      return 'This password is too common. Choose something less predictable.';
    const local = context.email?.split('@')[0]?.toLowerCase();
    if (local && local.length >= 4 && lower.includes(local))
      return 'Do not include your email address in your password.';
    for (const name of [context.firstName, context.lastName]) {
      if (name && name.length >= 4 && lower.includes(name.toLowerCase()))
        return 'Do not include your name in your password.';
    }
    if (/^(.)\1+$/.test(password)) return 'Do not repeat a single character.';
    return null;
  }
}
