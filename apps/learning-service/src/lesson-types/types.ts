import type { z } from 'zod';
import type { LessonGrant } from '@a5/auth';
import type { learning } from '@a5/contracts';
import type { LessonProgressData } from '../database/schema.js';

export type AssessmentKind = 'quiz' | 'exam' | 'final' | 'practice';

/** The learner's current progress on a lesson, as far as completion checks need it. */
export interface ProgressView {
  status: learning.LessonProgressStatus;
  percent: number;
  startedAt: Date | null;
  data: LessonProgressData;
}

export interface CompletionCheck {
  allowed: boolean;
  /** Learner-facing explanation (why it is or is not possible). */
  reason: string;
}

export interface LessonReferences {
  assessment?: { assessmentId: string; kind: AssessmentKind };
  aiScenario?: { scenarioId: string; minScore: number };
  mediaAssetIds?: string[];
}

export interface GrantSpec {
  resource: LessonGrant['resource'];
  policy: Record<string, unknown>;
}

/**
 * Backend half of a lesson type: configuration schema and completion strategy. Adding a lesson
 * type means adding one handler (plus its config schema in @a5/contracts and a web renderer).
 */
export interface LessonTypeHandler<C extends Record<string, unknown> = Record<string, unknown>> {
  readonly type: learning.LessonType;
  readonly label: string;
  readonly configSchema: z.ZodType<C>;
  readonly completion: learning.CompletionMode;
  /** May the learner press "Mark complete" now? */
  learnerCompletion(config: C, ctx: { settings: learning.ProgramSettings; progress: ProgressView | null }): CompletionCheck;
  /** Plain-language description of how the lesson completes. */
  completionHint(config: C, settings: learning.ProgramSettings): string;
  /** Capability for media, assessment or AI services; null when the lesson needs none. */
  grant(config: C, settings: learning.ProgramSettings): GrantSpec | null;
  /** Ids in other services this lesson points at. */
  references(config: C): LessonReferences;
  /** Checks beyond the config schema that must pass before publishing. */
  publishIssues?(lesson: { body: string | null; config: C }): string[];
}

export function defineLessonType<C extends Record<string, unknown>>(handler: LessonTypeHandler<C>): LessonTypeHandler<C> {
  return handler;
}
