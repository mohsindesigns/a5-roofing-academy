import { learning } from '@a5/contracts';
import { defineLessonType, type LessonTypeHandler } from '../types.js';

type AiConfig = learning.AiSimulationLessonConfig;

/** AI role-play lessons complete when a scored session reaches the lesson's minimum score. */
function aiLessonType(
  type: 'ai_simulation' | 'scenario',
  label: string,
): LessonTypeHandler<AiConfig> {
  return defineLessonType<AiConfig>({
    type,
    label,
    configSchema: learning.aiSimulationLessonConfigSchema,
    completion: 'ai_score',
    learnerCompletion(config) {
      return {
        allowed: false,
        reason: `This lesson completes automatically when a role-play scores ${config.minScore} or higher.`,
      };
    },
    completionHint(config) {
      return `Complete the role-play with a score of ${config.minScore} or higher.`;
    },
    grant(config) {
      return {
        resource: { type: 'ai_scenario', id: config.scenarioId },
        policy: { minScore: config.minScore },
      };
    },
    references(config) {
      return { aiScenario: { scenarioId: config.scenarioId, minScore: config.minScore } };
    },
  });
}

export const aiSimulationLesson = aiLessonType('ai_simulation', 'AI role-play');
export const scenarioLesson = aiLessonType('scenario', 'Scenario practice');
