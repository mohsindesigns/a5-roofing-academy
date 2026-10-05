import { sql } from '@a5/database';
import type { Db } from '../database/index.js';

/** Certificates joined with their definition and the recipient name frozen in the snapshot. */
export function certificateSummaryQuery(db: Db) {
  return db
    .selectFrom('issued_certificates as c')
    .innerJoin('certification_definitions as d', 'd.id', 'c.definition_id')
    .innerJoin('certificate_snapshots as s', 's.certificate_id', 'c.id')
    .selectAll('c')
    .select(['d.name as definition_name', 'd.code as definition_code', sql<string>`s.data->'recipient'->>'legalName'`.as('recipient_name')]);
}
