import type { Selectable } from '@a5/database';
import type { AiPersonasTable, AiScenariosTable } from '../database/schema.js';
import type { PersonaSnapshot, ScenarioSnapshot } from '../providers/types.js';

export function personaSnapshot(row: Selectable<AiPersonasTable>): PersonaSnapshot {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    temperament: row.temperament,
    speakingStyle: row.speaking_style,
    background: row.background,
    traits: [...row.traits],
  };
}

export function scenarioSnapshot(row: Selectable<AiScenariosTable>): ScenarioSnapshot {
  return {
    id: row.id,
    title: row.title,
    category: row.category,
    difficulty: row.difficulty,
    objection: row.objection,
    background: row.background,
    propertyContext: row.property_context,
    trigger: row.trigger,
    hiddenConcern: row.hidden_concern,
    expectedBehaviors: [...row.expected_behaviors],
    requiredTalkingPoints: [...row.required_talking_points],
    forbiddenClaims: [...row.forbidden_claims],
    aiInstructions: row.ai_instructions,
    openingLine: row.opening_line,
    passingScore: row.passing_score,
    maxTurns: row.max_turns,
  };
}

/** Prompt versions store snapshots as JSON; read them back with defaults for robustness. */
export function readPersonaSnapshot(json: Record<string, unknown>): PersonaSnapshot {
  const j = json as Partial<PersonaSnapshot>;
  return {
    id: String(j.id ?? ''),
    name: String(j.name ?? ''),
    description: String(j.description ?? ''),
    temperament: String(j.temperament ?? ''),
    speakingStyle: String(j.speakingStyle ?? ''),
    background: String(j.background ?? ''),
    traits: Array.isArray(j.traits) ? j.traits.map(String) : [],
  };
}

export function readScenarioSnapshot(json: Record<string, unknown>): ScenarioSnapshot {
  const j = json as Partial<ScenarioSnapshot>;
  const list = (v: unknown) => (Array.isArray(v) ? v.map(String) : []);
  return {
    id: String(j.id ?? ''),
    title: String(j.title ?? ''),
    category: String(j.category ?? ''),
    difficulty: (j.difficulty ?? 'beginner') as ScenarioSnapshot['difficulty'],
    objection: String(j.objection ?? ''),
    background: String(j.background ?? ''),
    propertyContext: String(j.propertyContext ?? ''),
    trigger: String(j.trigger ?? ''),
    hiddenConcern: String(j.hiddenConcern ?? ''),
    expectedBehaviors: list(j.expectedBehaviors),
    requiredTalkingPoints: list(j.requiredTalkingPoints),
    forbiddenClaims: list(j.forbiddenClaims),
    aiInstructions: String(j.aiInstructions ?? ''),
    openingLine: String(j.openingLine ?? ''),
    passingScore: Number(j.passingScore ?? 75),
    maxTurns: Number(j.maxTurns ?? 12),
  };
}
