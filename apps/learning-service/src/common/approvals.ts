import type { learning } from '@a5/contracts';
import type { Selectable } from '@a5/database';
import type { ApprovalRequestsTable, DbOrTrx } from '../database/index.js';
import { iso } from '../engine/dto.js';
import { displayNames, personRef } from './people.js';

type ApprovalRow = Selectable<ApprovalRequestsTable>;

/** Approval queue items with learner, program, lesson and (for assignments) the submission. */
export async function approvalSummaries(
  db: DbOrTrx,
  rows: ApprovalRow[],
): Promise<learning.ApprovalSummary[]> {
  if (rows.length === 0) return [];
  const submissionIds = rows.map((r) => r.submission_id).filter((id): id is string => Boolean(id));
  const [names, programs, lessons, submissions] = await Promise.all([
    displayNames(db, [...rows.map((r) => r.user_id), ...rows.map((r) => r.decided_by)]),
    db
      .selectFrom('programs')
      .select(['id', 'title'])
      .where('id', 'in', [...new Set(rows.map((r) => r.program_id))])
      .execute(),
    db
      .selectFrom('lessons')
      .select(['id', 'title', 'type'])
      .where('id', 'in', [...new Set(rows.map((r) => r.lesson_id))])
      .execute(),
    submissionIds.length
      ? db
          .selectFrom('assignment_submissions')
          .select(['id', 'body', 'word_count', 'submitted_at'])
          .where('id', 'in', submissionIds)
          .execute()
      : Promise.resolve([]),
  ]);
  return rows.map((r) => {
    const lesson = lessons.find((l) => l.id === r.lesson_id);
    const submission = submissions.find((s) => s.id === r.submission_id);
    return {
      id: r.id,
      kind: r.kind,
      status: r.status,
      learner: { id: r.user_id, displayName: names.get(r.user_id) ?? 'Unknown learner' },
      program: {
        id: r.program_id,
        title: programs.find((p) => p.id === r.program_id)?.title ?? 'Program',
      },
      lesson: {
        id: r.lesson_id,
        title: lesson?.title ?? 'Lesson',
        type: lesson?.type ?? 'manager_approval',
      },
      enrollmentId: r.enrollment_id,
      requestedAt: r.requested_at.toISOString(),
      requestNote: r.request_note,
      decidedAt: iso(r.decided_at),
      decidedBy: personRef(r.decided_by, names, r.decided_by_name),
      comment: r.comment,
      submission: submission
        ? {
            id: submission.id,
            body: submission.body,
            wordCount: submission.word_count,
            submittedAt: submission.submitted_at.toISOString(),
          }
        : null,
    };
  });
}
