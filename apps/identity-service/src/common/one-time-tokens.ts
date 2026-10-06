import { createHash } from 'node:crypto';
import { randomToken, uuidv7 } from '@a5/observability';
import type { OneTimeTokenPurpose, Trx } from '../database/index.js';

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('base64url');
}

/**
 * Issue a single-use token (activation or password reset). Earlier unused tokens of the same
 * purpose are invalidated so only the latest link works. Only the hash is stored.
 */
export async function issueOneTimeToken(
  trx: Trx,
  userId: string,
  purpose: OneTimeTokenPurpose,
  ttlMs: number,
  createdBy: string | null,
): Promise<{ token: string; expiresAt: Date }> {
  await trx
    .updateTable('one_time_tokens')
    .set({ used_at: new Date() })
    .where('user_id', '=', userId)
    .where('purpose', '=', purpose)
    .where('used_at', 'is', null)
    .execute();
  const token = randomToken(32);
  const expiresAt = new Date(Date.now() + ttlMs);
  await trx
    .insertInto('one_time_tokens')
    .values({
      id: uuidv7(),
      user_id: userId,
      purpose,
      token_hash: hashToken(token),
      expires_at: expiresAt,
      used_at: null,
      created_by: createdBy,
    })
    .execute();
  return { token, expiresAt };
}
