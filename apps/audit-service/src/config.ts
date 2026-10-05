import { env, z } from '@a5/config';
import { loadServiceConfig } from '@a5/nest-kit';

const auditEnv = z.object({
  /** Future months that always have a partition. */
  AUDIT_PARTITION_MONTHS_AHEAD: env.int(3),
  /** How often the partition job runs (it also runs at startup). */
  AUDIT_PARTITION_INTERVAL_MS: env.int(6 * 3_600_000),
  /** Largest CSV export; bigger selections must be narrowed. */
  AUDIT_EXPORT_MAX_ROWS: env.int(100_000),
  /** `before` / `after` snapshots larger than this (JSON bytes) are replaced by a truncation marker. */
  AUDIT_MAX_SNAPSHOT_BYTES: env.int(64 * 1024),
});

export function loadAuditConfig(source?: Record<string, string | undefined>) {
  const config = loadServiceConfig('audit-service', 4090, auditEnv, { source });
  const e = config.env;
  return {
    ...config,
    partitions: {
      monthsAhead: Math.min(24, Math.max(1, e.AUDIT_PARTITION_MONTHS_AHEAD)),
      intervalMs: Math.max(1_000, e.AUDIT_PARTITION_INTERVAL_MS),
    },
    exportMaxRows: Math.max(1, e.AUDIT_EXPORT_MAX_ROWS),
    maxSnapshotBytes: Math.max(1_024, e.AUDIT_MAX_SNAPSHOT_BYTES),
  };
}

export type AuditConfig = ReturnType<typeof loadAuditConfig>;
export const AUDIT_CONFIG = Symbol('AUDIT_CONFIG');
