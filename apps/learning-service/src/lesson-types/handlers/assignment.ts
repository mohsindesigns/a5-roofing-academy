import { learning } from '@a5/contracts';
import { defineLessonType } from '../types.js';

export const assignmentLesson = defineLessonType<learning.AssignmentLessonConfig>({
  type: 'assignment',
  label: 'Assignment',
  configSchema: learning.assignmentLessonConfigSchema,
  completion: 'submission',
  learnerCompletion() {
    return {
      allowed: false,
      reason:
        'Submit your response; the lesson completes when your trainer or manager approves it.',
    };
  },
  completionHint(config) {
    const words = config.minWords > 0 ? ` of at least ${config.minWords} words` : '';
    return `Submit your response${words}. It completes when your trainer or manager approves it.`;
  },
  grant() {
    return null;
  },
  references() {
    return {};
  },
});

export function countWords(text: string): number {
  const trimmed = text.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}
