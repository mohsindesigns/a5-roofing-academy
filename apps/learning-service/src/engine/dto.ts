import type { Selectable } from '@a5/database';
import type { learning } from '@a5/contracts';
import type { EnrollmentsTable, LessonProgressTable } from '../database/schema.js';

export type EnrollmentRow = Selectable<EnrollmentsTable>;
export type LessonProgressRow = Selectable<LessonProgressTable>;

export const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

export function isOverdue(row: Pick<EnrollmentRow, 'status' | 'due_at'>, now: Date = new Date()): boolean {
  return row.status === 'active' && row.due_at !== null && row.due_at < now;
}

export function enrollmentProgressDto(row: EnrollmentRow, now: Date = new Date()): learning.EnrollmentProgress {
  return {
    id: row.id,
    status: row.status,
    source: row.source,
    enrolledAt: row.enrolled_at.toISOString(),
    dueAt: iso(row.due_at),
    overdue: isOverdue(row, now),
    startedAt: iso(row.started_at),
    completedAt: iso(row.completed_at),
    lastActivityAt: iso(row.last_activity_at),
    progressPercent: Number(row.progress_percent),
    requiredTotal: row.required_total,
    requiredCompleted: row.required_completed,
    currentLessonId: row.current_lesson_id,
    currentPhaseId: row.current_phase_id,
  };
}

export function lessonProgressDto(lessonId: string, row: LessonProgressRow | undefined | null): learning.LessonProgress {
  if (!row) {
    return {
      lessonId,
      status: 'not_started',
      percent: 0,
      startedAt: null,
      completedAt: null,
      completionSource: null,
      watchedPercent: null,
      bestScore: null,
    };
  }
  return {
    lessonId,
    status: row.status,
    percent: Number(row.percent),
    startedAt: iso(row.started_at),
    completedAt: iso(row.completed_at),
    completionSource: row.completion_source,
    watchedPercent: typeof row.data?.watchedPercent === 'number' ? row.data.watchedPercent : null,
    bestScore: typeof row.data?.bestScore === 'number' ? row.data.bestScore : null,
  };
}
