import type { ai } from '@a5/contracts';
import {
  PERSONAS,
  PROGRAM,
  SCENARIOS,
  JOURNEYS,
  RUBRIC,
  PEOPLE,
  SEED_NOW,
  allLessons,
  daysAgo,
  seedId,
  type PersonKey,
} from '@a5/seed-data';
import type { EndReason, RubricCategoryRecord } from '../database/schema.js';
import { normalizeEvaluation, type NormalizedScorecard } from '../evaluation/normalize.js';
import {
  compileEvaluatorPrompt,
  compileHomeownerPrompt,
  formatTranscriptForEvaluation,
} from '../prompts/compiler.js';
import type { PersonaSnapshot, ScenarioSnapshot, TranscriptLine } from '../providers/types.js';
import {
  buildEvaluation,
  analyzeTranscript,
  calibrateScores,
  scoreCategories,
  weightedOverall,
} from '../providers/simulator/evaluator.js';
import { DEV_SIMULATOR_MODEL } from '../providers/simulator/simulator.provider.js';
import { DEFAULT_PASSING_SCORE, DEFAULT_RUBRIC_CATEGORIES } from '../rubrics/default-categories.js';
import { PERSONA_CONTENT } from './content/personas.js';
import { SCENARIO_CONTENT } from './content/scenarios.js';
import { TRANSCRIPTS, type TranscriptVariant } from './content/transcripts.js';

/** Author of the seeded content (Sales Training Manager). */
export const SEED_AUTHOR_ID = PEOPLE.shelby.id;
/** Seeded content predates the earliest seeded practice session. */
export const SEED_CONTENT_CREATED_AT = new Date('2024-09-02T15:00:00Z');
export const SEED_RUBRIC_VERSION_ID = seedId('rubric-version:a5-objection-handling:1');

export const SEED_PERSONAS = PERSONAS.map((p) => {
  const c = PERSONA_CONTENT[p.key];
  return { id: p.id, key: p.key, name: p.name, ...c };
});

export const SEED_RUBRIC = {
  id: RUBRIC.id,
  versionId: SEED_RUBRIC_VERSION_ID,
  title: RUBRIC.title,
  description:
    'The A5 standard for objection handling at the door: fourteen weighted categories from discovery to compliance, scored 0-100 with quoted evidence.',
  categories: DEFAULT_RUBRIC_CATEGORIES,
  passingScore: DEFAULT_PASSING_SCORE,
};

/** Scenario definitions in the API's create shape. */
export const SEED_SCENARIOS = SCENARIOS.map((s) => {
  const c = SCENARIO_CONTENT[s.key];
  if (!c) throw new Error(`No seed content for scenario ${s.key}`);
  const persona = PERSONAS.find((p) => p.key === s.personaKey)!;
  const request: ai.CreateScenarioRequest = {
    title: s.title,
    category: s.category,
    difficulty: s.difficulty,
    personaId: persona.id,
    objection: s.objection,
    repBrief: c.repBrief,
    background: c.background,
    propertyContext: c.propertyContext,
    trigger: c.trigger,
    hiddenConcern: c.hiddenConcern,
    expectedBehaviors: c.expectedBehaviors,
    requiredTalkingPoints: c.requiredTalkingPoints,
    forbiddenClaims: c.forbiddenClaims,
    aiInstructions: c.aiInstructions,
    openingLine: c.openingLine,
    passingScore: s.passingScore,
    rubricId: RUBRIC.id,
    maxTurns: c.maxTurns,
    provider: null,
    model: null,
    evaluationModel: null,
    modelSettings: {},
  };
  return { id: s.id, key: s.key, request };
});

export function personaSnapshotOf(key: string): PersonaSnapshot {
  const p = SEED_PERSONAS.find((x) => x.key === key)!;
  return {
    id: p.id,
    name: p.name,
    description: p.description,
    temperament: p.temperament,
    speakingStyle: p.speakingStyle,
    background: p.background,
    traits: [...p.traits],
  };
}

export function scenarioSnapshotOf(key: string): ScenarioSnapshot {
  const s = SEED_SCENARIOS.find((x) => x.key === key)!;
  const r = s.request;
  return {
    id: s.id,
    title: r.title,
    category: r.category,
    difficulty: r.difficulty,
    objection: r.objection,
    background: r.background,
    propertyContext: r.propertyContext,
    trigger: r.trigger,
    hiddenConcern: r.hiddenConcern,
    expectedBehaviors: [...r.expectedBehaviors],
    requiredTalkingPoints: [...r.requiredTalkingPoints],
    forbiddenClaims: [...r.forbiddenClaims],
    aiInstructions: r.aiInstructions,
    openingLine: r.openingLine,
    passingScore: r.passingScore,
    maxTurns: r.maxTurns,
  };
}

export interface SeedMessage {
  id: string;
  seq: number;
  role: 'homeowner' | 'rep';
  content: string;
  createdAt: Date;
  inputTokens: number | null;
  outputTokens: number | null;
  latencyMs: number | null;
}

export interface SeedSession {
  id: string;
  person: PersonKey;
  userId: string;
  scenarioKey: string;
  scenarioId: string;
  variant: string;
  mode: 'practice' | 'assigned';
  context: { programId?: string; lessonId?: string };
  endReason: EndReason;
  startedAt: Date;
  endedAt: Date;
  turnCount: number;
  messages: SeedMessage[];
  card: NormalizedScorecard;
  evaluatedAt: Date;
  /** Heuristic overall before calibration to the journey score, and the largest category shift. */
  rawOverall: number;
  maxCategoryShift: number;
  evaluationOutput: unknown;
  usage: {
    conversation: Array<{ at: Date; input: number; output: number; latencyMs: number }>;
    evaluation: { at: Date; input: number; output: number; latencyMs: number };
  };
}

const hash = (s: string) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
};
const tokens = (text: string) => Math.ceil(text.length / 4);

function pickVariant(scenarioKey: string, score: number, occurrence: number): TranscriptVariant {
  const forScenario = TRANSCRIPTS.filter((t) => t.scenario === scenarioKey);
  if (!forScenario.length) throw new Error(`No seeded transcript for scenario ${scenarioKey}`);
  const inBand = forScenario.filter((t) => score >= t.band[0] && score <= t.band[1]);
  const pool = inBand.length
    ? inBand
    : [...forScenario]
        .sort(
          (a, b) =>
            Math.min(Math.abs(score - a.band[0]), Math.abs(score - a.band[1])) -
            Math.min(Math.abs(score - b.band[0]), Math.abs(score - b.band[1])),
        )
        .slice(0, 1);
  return pool[occurrence % pool.length]!;
}

/** Category scores of an evaluation under a rubric (heuristic, then calibrated to the target). */
export function evaluateSeedTranscript(
  persona: PersonaSnapshot,
  scenario: ScenarioSnapshot,
  categories: RubricCategoryRecord[],
  transcript: TranscriptLine[],
  endReason: EndReason,
  target: number,
) {
  const analysis = analyzeTranscript({ persona, scenario, categories, transcript, endReason });
  const raw = scoreCategories(analysis);
  const caps: Record<string, number> =
    analysis.forbiddenCount > 0 ? { compliance: 40, insurance_knowledge: 39 } : {};
  const calibrated = calibrateScores(raw, categories, target, caps);
  const output = buildEvaluation(analysis, calibrated);
  const card = normalizeEvaluation(
    'dev_simulator',
    output,
    categories,
    transcript,
    scenario.passingScore,
  );
  const maxShift = Math.max(
    ...categories.map((c) => Math.abs((calibrated[c.key] ?? 0) - (raw[c.key] ?? 0))),
  );
  return { card, output, rawOverall: Math.round(weightedOverall(raw, categories)), maxShift };
}

/** Practice sessions for every `JOURNEYS[].aiSessions` entry, with transcripts and scorecards. */
export function buildSeedSessions(): SeedSession[] {
  const lessons = allLessons();
  const sessions: SeedSession[] = [];
  const occurrence = new Map<string, number>();

  for (const journey of JOURNEYS) {
    const person = PEOPLE[journey.person];
    journey.aiSessions.forEach((entry, index) => {
      const scenarioDef = SCENARIOS.find((s) => s.key === entry.scenario);
      if (!scenarioDef)
        throw new Error(`Unknown scenario ${entry.scenario} in journey of ${journey.person}`);
      const n = occurrence.get(entry.scenario) ?? 0;
      occurrence.set(entry.scenario, n + 1);
      const variant = pickVariant(entry.scenario, entry.score, n);
      const persona = personaSnapshotOf(scenarioDef.personaKey);
      const scenario = scenarioSnapshotOf(entry.scenario);
      const lesson = lessons.find((l) => l.type === 'ai_simulation' && l.ref === entry.scenario);
      const id = seedId(`ai-session:${journey.person}:${entry.scenario}:${index}`);
      const seed = hash(id);

      const startedAt = new Date(
        daysAgo(entry.daysAgo).getTime() + ((seed % 7) - 2) * 3_600_000 + (seed % 50) * 60_000,
      );
      const lines: TranscriptLine[] = [
        { seq: 1, role: 'homeowner', content: scenario.openingLine },
      ];
      const times: Date[] = [startedAt];
      const latencies: Array<number | null> = [null];
      variant.lines.forEach((raw, i) => {
        const role = i % 2 === 0 ? 'rep' : 'homeowner';
        const gap =
          role === 'rep'
            ? 22_000 + ((seed >>> (i % 16)) % 34_000)
            : 4_000 + ((seed >>> ((i + 3) % 16)) % 5_000);
        times.push(new Date(times[times.length - 1]!.getTime() + gap));
        lines.push({
          seq: lines.length + 1,
          role,
          content: raw.replaceAll('{rep}', person.firstName),
        });
        latencies.push(role === 'homeowner' ? 650 + ((seed >>> (i % 12)) % 1_400) : null);
      });

      const rubricCategories = SEED_RUBRIC.categories;
      const { card, output, rawOverall, maxShift } = evaluateSeedTranscript(
        persona,
        scenario,
        rubricCategories,
        lines,
        variant.endReason,
        entry.score,
      );
      if (card.overallScore !== entry.score)
        throw new Error(
          `Seeded evaluation for ${id} scored ${card.overallScore}, expected ${entry.score}`,
        );

      const system = compileHomeownerPrompt(persona, scenario);
      const evaluatorSystem = compileEvaluatorPrompt(
        persona,
        scenario,
        rubricCategories,
        scenario.passingScore,
      );
      const messages: SeedMessage[] = lines.map((l, i) => {
        const homeownerReply = l.role === 'homeowner' && i > 0;
        const history = lines.slice(0, i).reduce((sum, x) => sum + x.content.length, system.length);
        return {
          id: seedId(`ai-message:${id}:${l.seq}`),
          seq: l.seq,
          role: l.role,
          content: l.content,
          createdAt: times[i]!,
          inputTokens: homeownerReply ? Math.ceil(history / 4) : null,
          outputTokens: homeownerReply ? tokens(l.content) : null,
          latencyMs: homeownerReply ? latencies[i]! : null,
        };
      });
      const endedAt = new Date(
        times[times.length - 1]!.getTime() +
          (variant.endReason === 'rep_ended' ? 9_000 + (seed % 20_000) : 400),
      );
      const evaluatedAt = new Date(endedAt.getTime() + 25_000 + (seed % 30_000));
      const evalInput = tokens(
        evaluatorSystem + formatTranscriptForEvaluation(lines, variant.endReason),
      );

      sessions.push({
        id,
        person: journey.person,
        userId: person.id,
        scenarioKey: entry.scenario,
        scenarioId: scenarioDef.id,
        variant: variant.key,
        mode: lesson ? 'assigned' : 'practice',
        context: lesson ? { programId: PROGRAM.id, lessonId: lesson.id } : {},
        endReason: variant.endReason,
        startedAt,
        endedAt,
        turnCount: lines.filter((l) => l.role === 'rep').length,
        messages,
        card,
        evaluatedAt,
        rawOverall,
        maxCategoryShift: maxShift,
        evaluationOutput: output,
        usage: {
          conversation: messages
            .filter((m) => m.role === 'homeowner' && m.seq > 1)
            .map((m) => ({
              at: m.createdAt,
              input: m.inputTokens ?? 0,
              output: m.outputTokens ?? 0,
              latencyMs: m.latencyMs ?? 0,
            })),
          evaluation: {
            at: evaluatedAt,
            input: evalInput,
            output: tokens(JSON.stringify(output)),
            latencyMs: 900 + (seed % 700),
          },
        },
      });
    });
  }
  return sessions;
}

export { DEV_SIMULATOR_MODEL, SEED_NOW };
