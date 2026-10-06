import { learning } from '@a5/contracts';
import { defineLessonType, type AssessmentKind, type LessonTypeHandler } from '../types.js';

type AssessmentConfig = learning.AssessmentLessonConfig;

/** Quiz and final assessment lessons complete when assessment-service grades a passing attempt. */
function assessmentLessonType(
  type: 'quiz' | 'final_assessment',
  label: string,
  kind: AssessmentKind,
): LessonTypeHandler<AssessmentConfig> {
  return defineLessonType<AssessmentConfig>({
    type,
    label,
    configSchema: learning.assessmentLessonConfigSchema,
    completion: 'assessment',
    learnerCompletion() {
      return {
        allowed: false,
        reason: 'This lesson completes automatically when you pass the assessment.',
      };
    },
    completionHint() {
      return 'Completes automatically when you pass the assessment.';
    },
    grant(config) {
      return { resource: { type: 'assessment', id: config.assessmentId }, policy: { kind } };
    },
    references(config) {
      return { assessment: { assessmentId: config.assessmentId, kind } };
    },
  });
}

export const quizLesson = assessmentLessonType('quiz', 'Quiz', 'quiz');
export const finalAssessmentLesson = assessmentLessonType(
  'final_assessment',
  'Final assessment',
  'final',
);
