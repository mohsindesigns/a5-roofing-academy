import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ROLES,
  PERMISSIONS,
  PERMISSION_KEYS,
  PermissionSet,
  compactPermissions,
  expandPermissions,
  widestScope,
} from './index.js';

describe('permission catalog', () => {
  it('has unique resource.action keys', () => {
    expect(new Set(PERMISSION_KEYS).size).toBe(PERMISSION_KEYS.length);
    for (const key of PERMISSION_KEYS) expect(key).toMatch(/^[a-z_]+\.[a-z_]+$/);
  });

  it('default roles only reference known permissions', () => {
    const known = new Set<string>(PERMISSION_KEYS);
    for (const role of DEFAULT_ROLES) {
      for (const p of role.permissions) expect(known.has(p), `${role.key}:${p}`).toBe(true);
    }
  });

  it('only super admin holds platform permissions', () => {
    const platform = PERMISSIONS.filter((p) => 'platform' in p && p.platform).map((p) => p.key);
    for (const role of DEFAULT_ROLES.filter((r) => r.key !== 'super_admin')) {
      for (const p of platform) expect(role.permissions).not.toContain(p);
    }
  });

  it('sales reps have only self-service permissions', () => {
    const rep = DEFAULT_ROLES.find((r) => r.key === 'sales_rep')!;
    const selfKeys = PERMISSIONS.filter((p) => p.module === 'self').map((p) => p.key);
    expect([...rep.permissions].sort()).toEqual([...selfKeys].sort());
  });
});

describe('scopes', () => {
  it('picks the widest scope', () => {
    expect(widestScope('own', 'managed')).toBe('managed');
    expect(widestScope('platform', 'organization')).toBe('platform');
  });

  it('round-trips compact permissions', () => {
    const map = { 'users.view': 'managed', 'roles.view': 'organization' } as const;
    expect(expandPermissions(compactPermissions(map))).toEqual(map);
  });

  it('expands duplicated keys to the widest scope', () => {
    expect(expandPermissions({ own: ['users.view'], organization: ['users.view'] })).toEqual({
      'users.view': 'organization',
    });
  });

  it('PermissionSet answers has/scope', () => {
    const set = new PermissionSet({ 'users.view': 'managed' });
    expect(set.has('users.view')).toBe(true);
    expect(set.has('users.create')).toBe(false);
    expect(set.scope('users.view')).toBe('managed');
    expect(set.hasAny(['users.create', 'users.view'])).toBe(true);
    expect(set.hasAll(['users.create', 'users.view'])).toBe(false);
  });
});
