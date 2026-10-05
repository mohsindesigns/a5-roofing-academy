import { learning } from '@a5/contracts';
import { defineLessonType } from '../types.js';

export const acknowledgmentLesson = defineLessonType<learning.AcknowledgmentLessonConfig>({
  type: 'acknowledgment',
  label: 'Acknowledgment',
  configSchema: learning.acknowledgmentLessonConfigSchema,
  completion: 'acknowledgment',
  learnerCompletion() {
    return { allowed: false, reason: 'Read the statement and acknowledge it by typing your full name.' };
  },
  completionHint() {
    return 'Read the statement, then type your full name to acknowledge it.';
  },
  grant() {
    return null;
  },
  references() {
    return {};
  },
});

/** Normalize a typed or directory name for comparison (case and spacing do not matter). */
export function normalizeName(name: string): string {
  return name.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US');
}
