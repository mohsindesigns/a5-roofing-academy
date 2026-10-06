import { learning } from '@a5/contracts';
import { defineLessonType } from '../types.js';

/**
 * Manager sign-off. An approval request is opened automatically when the learner reaches the
 * lesson; approving it completes the lesson.
 */
export const managerApprovalLesson = defineLessonType<learning.ManagerApprovalLessonConfig>({
  type: 'manager_approval',
  label: 'Manager approval',
  configSchema: learning.managerApprovalLessonConfigSchema,
  completion: 'approval',
  learnerCompletion() {
    return {
      allowed: false,
      reason: 'Your manager completes this step by approving your sign-off request.',
    };
  },
  completionHint() {
    return 'Completes when your manager approves the sign-off request.';
  },
  grant() {
    return null;
  },
  references() {
    return {};
  },
});
