import type { PermissionKey } from './catalog.js';

/**
 * Data scope attached to a role.
 * - own: only the user's own records
 * - managed: users in teams the user manages plus direct reports / assigned trainees
 * - organization: everything inside the user's organization
 * - platform: every organization (super administrators)
 */
export const DATA_SCOPES = ['own', 'managed', 'organization', 'platform'] as const;
export type DataScope = (typeof DATA_SCOPES)[number];

const rank: Record<DataScope, number> = { own: 0, managed: 1, organization: 2, platform: 3 };

export function scopeRank(scope: DataScope): number {
  return rank[scope];
}

export function widestScope(a: DataScope, b: DataScope): DataScope {
  return rank[a] >= rank[b] ? a : b;
}

export function scopeCovers(granted: DataScope, required: DataScope): boolean {
  return rank[granted] >= rank[required];
}

export type PermissionMap = Partial<Record<PermissionKey, DataScope>>;

/** Read-only view over an effective permission map. Shared by the web app and services. */
export class PermissionSet {
  constructor(private readonly map: PermissionMap) {}

  static empty(): PermissionSet {
    return new PermissionSet({});
  }

  has(key: PermissionKey): boolean {
    return this.map[key] !== undefined;
  }

  hasAll(keys: readonly PermissionKey[]): boolean {
    return keys.every((k) => this.has(k));
  }

  hasAny(keys: readonly PermissionKey[]): boolean {
    return keys.some((k) => this.has(k));
  }

  scope(key: PermissionKey): DataScope | null {
    return this.map[key] ?? null;
  }

  keys(): PermissionKey[] {
    return Object.keys(this.map) as PermissionKey[];
  }

  toJSON(): PermissionMap {
    return { ...this.map };
  }
}

/** Compact wire format: scope -> keys. Keeps internal tokens small. */
export type CompactPermissions = Partial<Record<DataScope, PermissionKey[]>>;

export function compactPermissions(map: PermissionMap): CompactPermissions {
  const out: CompactPermissions = {};
  for (const [key, scope] of Object.entries(map) as Array<[PermissionKey, DataScope]>) {
    (out[scope] ??= []).push(key);
  }
  return out;
}

export function expandPermissions(compact: CompactPermissions): PermissionMap {
  const out: PermissionMap = {};
  for (const scope of DATA_SCOPES) {
    for (const key of compact[scope] ?? []) {
      const existing = out[key];
      out[key] = existing ? widestScope(existing, scope) : scope;
    }
  }
  return out;
}
