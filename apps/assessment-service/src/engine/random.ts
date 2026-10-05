import { createHash, randomBytes } from 'node:crypto';

/** Source of uniform numbers in [0, 1). */
export interface Rng {
  next(): number;
}

/**
 * Small, fast PRNG (sfc32) seeded from a SHA-256 of the seed string. Deterministic seeds are used by
 * the seed data; live attempts use `randomRng()`. Randomness is snapshotted on the attempt, so the
 * generator never needs to be replayed.
 */
export function seededRng(seed: string): Rng {
  const h = createHash('sha256').update(seed).digest();
  let a = h.readUInt32LE(0);
  let b = h.readUInt32LE(4);
  let c = h.readUInt32LE(8);
  let d = h.readUInt32LE(12);
  const rng: Rng = {
    next() {
      a >>>= 0;
      b >>>= 0;
      c >>>= 0;
      d >>>= 0;
      let t = (a + b) | 0;
      a = b ^ (b >>> 9);
      b = (c + (c << 3)) | 0;
      c = (c << 21) | (c >>> 11);
      d = (d + 1) | 0;
      t = (t + d) | 0;
      c = (c + t) | 0;
      return (t >>> 0) / 4294967296;
    },
  };
  for (let i = 0; i < 12; i++) rng.next();
  return rng;
}

export function randomRng(): Rng {
  return seededRng(randomBytes(32).toString('hex'));
}

/** Fisher–Yates shuffle; returns a new array. */
export function shuffle<T>(items: readonly T[], rng: Rng): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng.next() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}
