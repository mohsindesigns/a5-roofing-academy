import pg from 'pg';
import { Kysely, PostgresDialect, type LogEvent } from 'kysely';

// Return BIGINT/COUNT as numbers and NUMERIC as floats. Values in this platform (counts, scores,
// sequences) are well below 2^53; certificate sequences are formatted from the number directly.
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v));
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v) => Number.parseFloat(v));
// Calendar dates stay 'YYYY-MM-DD' strings; converting them to Date would shift them by time zone.
pg.types.setTypeParser(pg.types.builtins.DATE, (v) => v);

export interface DatabaseOptions {
  url: string;
  poolMax?: number;
  statementTimeoutMs?: number;
  applicationName?: string;
  /** Log queries slower than this many milliseconds. */
  slowQueryMs?: number;
  onSlowQuery?: (event: { sql: string; durationMs: number }) => void;
  onError?: (event: { sql: string; error: unknown }) => void;
}

export interface Database<DB> {
  db: Kysely<DB>;
  pool: pg.Pool;
  destroy(): Promise<void>;
  ping(): Promise<void>;
}

export function createDatabase<DB>(options: DatabaseOptions): Database<DB> {
  const pool = new pg.Pool({
    connectionString: options.url,
    max: options.poolMax ?? 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    application_name: options.applicationName,
    statement_timeout: options.statementTimeoutMs ?? 15_000,
  });
  const slow = options.slowQueryMs ?? 500;
  const db = new Kysely<DB>({
    dialect: new PostgresDialect({ pool }),
    log(event: LogEvent) {
      if (event.level === 'error') {
        options.onError?.({ sql: event.query.sql, error: event.error });
      } else if (event.queryDurationMillis >= slow) {
        options.onSlowQuery?.({ sql: event.query.sql, durationMs: event.queryDurationMillis });
      }
    },
  });
  return {
    db,
    pool,
    destroy: () => db.destroy(),
    async ping() {
      const client = await pool.connect();
      try {
        await client.query('select 1');
      } finally {
        client.release();
      }
    },
  };
}
