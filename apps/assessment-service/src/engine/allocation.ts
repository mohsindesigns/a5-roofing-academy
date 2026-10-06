import { shuffle, type Rng } from './random.js';

export interface PoolDemand {
  key: string;
  count: number;
  /** Question ids that satisfy the pool rule. Pools may overlap. */
  candidates: readonly string[];
}

export interface PoolAllocation {
  ok: boolean;
  /** Pool key → assigned question ids, in draw order. */
  assigned: Map<string, string[]>;
  shortfalls: Array<{ key: string; required: number; assigned: number }>;
}

/**
 * Assign distinct questions to pools so that every pool gets `count` of its own candidates.
 *
 * Overlapping pools (e.g. "3 hard Insurance questions" and "10 questions from the whole bank") make
 * a greedy draw fail even when an assignment exists, so this solves it as a bipartite b-matching
 * with augmenting paths. With an `rng` the candidate lists are shuffled first, which turns the
 * matching into a random draw; without one it is a deterministic feasibility check.
 */
export function allocatePools(pools: readonly PoolDemand[], rng?: Rng): PoolAllocation {
  const lists = pools.map((p) =>
    rng ? shuffle([...new Set(p.candidates)], rng) : [...new Set(p.candidates)],
  );
  const slotPool: number[] = [];
  // Most constrained pools first keeps augmenting paths short.
  const order = pools
    .map((_, i) => i)
    .sort((a, b) => lists[a]!.length / pools[a]!.count - lists[b]!.length / pools[b]!.count);
  for (const index of order) for (let n = 0; n < pools[index]!.count; n++) slotPool.push(index);

  const owner = new Map<string, number>();
  const tryAssign = (slot: number, visited: Set<string>): boolean => {
    for (const question of lists[slotPool[slot]!]!) {
      if (visited.has(question)) continue;
      visited.add(question);
      const current = owner.get(question);
      if (current === undefined || tryAssign(current, visited)) {
        owner.set(question, slot);
        return true;
      }
    }
    return false;
  };
  for (let slot = 0; slot < slotPool.length; slot++) tryAssign(slot, new Set());

  const byPool = new Map<number, Set<string>>();
  for (const [question, slot] of owner) {
    const pool = slotPool[slot]!;
    if (!byPool.has(pool)) byPool.set(pool, new Set());
    byPool.get(pool)!.add(question);
  }
  const assigned = new Map<string, string[]>();
  const shortfalls: PoolAllocation['shortfalls'] = [];
  pools.forEach((pool, index) => {
    const chosen = byPool.get(index) ?? new Set<string>();
    // Keep the (possibly shuffled) candidate order so the draw order is random too.
    assigned.set(
      pool.key,
      lists[index]!.filter((q) => chosen.has(q)),
    );
    if (chosen.size < pool.count)
      shortfalls.push({ key: pool.key, required: pool.count, assigned: chosen.size });
  });
  return { ok: shortfalls.length === 0, assigned, shortfalls };
}
