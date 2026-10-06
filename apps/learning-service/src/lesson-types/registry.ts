import { learning } from '@a5/contracts';
import { ValidationError } from '@a5/nest-kit';
import { acknowledgmentLesson } from './handlers/acknowledgment.js';
import { aiSimulationLesson, scenarioLesson } from './handlers/ai-simulation.js';
import { articleLesson } from './handlers/article.js';
import { finalAssessmentLesson, quizLesson } from './handlers/assessment.js';
import { assignmentLesson } from './handlers/assignment.js';
import { documentLesson, pdfLesson } from './handlers/document.js';
import { externalLesson } from './handlers/external.js';
import { managerApprovalLesson } from './handlers/manager-approval.js';
import { videoLesson } from './handlers/video.js';
import type { LessonTypeHandler } from './types.js';

/** Lookup of lesson type handlers. One handler per type; types are data, not branches. */
export class LessonTypeRegistry {
  private readonly byType = new Map<string, LessonTypeHandler>();

  constructor(handlers: readonly LessonTypeHandler[]) {
    for (const h of handlers) {
      if (this.byType.has(h.type)) throw new Error(`Duplicate lesson type handler "${h.type}"`);
      this.byType.set(h.type, h);
    }
  }

  types(): learning.LessonType[] {
    return [...this.byType.keys()] as learning.LessonType[];
  }

  has(type: string): type is learning.LessonType {
    return this.byType.has(type);
  }

  get(type: string): LessonTypeHandler {
    const handler = this.byType.get(type);
    if (!handler) throw new Error(`No handler registered for lesson type "${type}"`);
    return handler;
  }

  /** Validate user input; throws a 400 with `config.*` field paths. */
  parseConfig(type: string, raw: unknown): Record<string, unknown> {
    const result = this.get(type).configSchema.safeParse(raw ?? {});
    if (!result.success) {
      throw new ValidationError(
        result.error.issues.map((i) => ({
          path: ['config', ...i.path.map(String)].join('.'),
          message: i.message,
        })),
      );
    }
    return result.data;
  }

  /** Read a stored config (validated when written) with current defaults applied. */
  readConfig(type: string, stored: unknown): Record<string, unknown> {
    const result = this.get(type).configSchema.safeParse(stored ?? {});
    return result.success ? result.data : ((stored ?? {}) as Record<string, unknown>);
  }
}

export const lessonTypes = new LessonTypeRegistry([
  videoLesson,
  articleLesson,
  pdfLesson,
  documentLesson,
  externalLesson,
  quizLesson,
  finalAssessmentLesson,
  assignmentLesson,
  aiSimulationLesson,
  scenarioLesson,
  managerApprovalLesson,
  acknowledgmentLesson,
] as LessonTypeHandler[]);
