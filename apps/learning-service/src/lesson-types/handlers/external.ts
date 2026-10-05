import { learning } from '@a5/contracts';
import { defineLessonType } from '../types.js';

export const externalLesson = defineLessonType<learning.ExternalLessonConfig>({
  type: 'external',
  label: 'External link',
  configSchema: learning.externalLessonConfigSchema,
  completion: 'manual',
  learnerCompletion() {
    return { allowed: true, reason: 'Mark the lesson complete when you have finished the linked material.' };
  },
  completionHint(config) {
    return `Open ${config.linkLabel ?? 'the linked page'}, work through it, then select "Mark complete".`;
  },
  grant() {
    return null;
  },
  references() {
    return {};
  },
});
