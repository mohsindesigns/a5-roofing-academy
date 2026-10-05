import type { ai } from '@a5/contracts';
import { useScenario } from '@/features/ai-scenarios/api';
import { useCan } from '@/features/auth/session';
import { usePracticeBrief } from './api';

export interface ConversationContext {
  personaName: string;
  personaDescription: string | null;
  repBrief: string | null;
  scoredOn: string[];
}

/**
 * Who the learner is talking to and what they know going in. Learners read the practice brief;
 * a trainer test-running a draft reads the scenario record. Both are optional: the conversation
 * and the scorecard work without them.
 */
export function useConversationContext(
  session: Pick<ai.Session, 'isTest'> & { scenario: Pick<ai.Session['scenario'], 'id'> },
): ConversationContext {
  const canPractice = useCan('ai_practice.use');
  const brief = usePracticeBrief(!session.isTest && canPractice ? session.scenario.id : undefined);
  const admin = useScenario(session.isTest ? session.scenario.id : undefined);
  return {
    personaName: brief.data?.persona.name ?? admin.data?.persona.name ?? 'Homeowner',
    personaDescription: brief.data?.persona.description ?? null,
    repBrief: brief.data?.repBrief ?? admin.data?.repBrief ?? null,
    scoredOn: brief.data?.scoredOn.map((c) => c.label) ?? [],
  };
}
