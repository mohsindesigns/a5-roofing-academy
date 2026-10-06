import type { DbOrTrx } from '../database/index.js';
import { assembleTree, type ProgramTree } from './tree.js';

/** The working copy of a program without archived nodes, as learners would see it once published. */
export async function loadWorkingTree(db: DbOrTrx, programId: string): Promise<ProgramTree | null> {
  const program = await db
    .selectFrom('programs')
    .selectAll()
    .where('id', '=', programId)
    .executeTakeFirst();
  if (!program) return null;
  const [phases, modules, lessons] = await Promise.all([
    db.selectFrom('program_phases').selectAll().where('program_id', '=', programId).execute(),
    db.selectFrom('program_modules').selectAll().where('program_id', '=', programId).execute(),
    db.selectFrom('lessons').selectAll().where('program_id', '=', programId).execute(),
  ]);
  const resources = lessons.length
    ? await db
        .selectFrom('lesson_resources')
        .selectAll()
        .where(
          'lesson_id',
          'in',
          lessons.map((l) => l.id),
        )
        .execute()
    : [];
  return assembleTree(program, { phases, modules, lessons, resources }, 0);
}
