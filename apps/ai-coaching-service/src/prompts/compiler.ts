import { createHash } from 'node:crypto';
import type {
  ModelSettingsRecord,
  ProviderName,
  RubricCategoryRecord,
} from '../database/schema.js';
import type {
  ChatMessage,
  PersonaSnapshot,
  ScenarioSnapshot,
  TranscriptLine,
} from '../providers/types.js';

/** End markers the homeowner may append to its final reply. The engine strips them. */
export const END_MARKERS = {
  objective_reached: '[[END:objective_reached]]',
  homeowner_ended: '[[END:homeowner_ended]]',
} as const;
export type MarkerEndReason = keyof typeof END_MARKERS;

const bullets = (items: readonly string[], empty = '- (none specified)') =>
  items.length ? items.map((i) => `- ${i}`).join('\n') : empty;

const section = (title: string, body: string) => `# ${title}\n${body.trim()}`;

/**
 * Homeowner system prompt: persona + scenario + strict role rules + end-marker protocol.
 * Deterministic for the same inputs, so its hash identifies a prompt version.
 */
export function compileHomeownerPrompt(
  persona: PersonaSnapshot,
  scenario: ScenarioSnapshot,
): string {
  const parts = [
    `You are playing a homeowner in a realistic door-to-door conversation. The other person is a sales representative from A5 Roofing; everything they write is what they say to you at your front door. Reply only with what you, the homeowner, say out loud.`,
    section(
      'Who you are',
      [
        `${persona.name}: ${persona.description}`,
        `Temperament: ${persona.temperament}`,
        `How you talk: ${persona.speakingStyle}`,
        `Your background: ${persona.background}`,
        persona.traits.length ? `Traits:\n${bullets(persona.traits)}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    ),
    section(
      'The situation',
      [
        scenario.background,
        `Your home and roof: ${scenario.propertyContext}`,
        `Why the representative is at your door: ${scenario.trigger}`,
        `Your objection: early on, and whenever the representative pushes for a commitment they have not earned, you push back with some version of "${scenario.objection}"`,
      ].join('\n\n'),
    ),
    section(
      'What you are not saying yet',
      `${scenario.hiddenConcern}

Keep this to yourself at first. Reveal it in your own words, a little at a time, only after the representative asks a genuine, open-ended discovery question about your situation, your priorities or what is really holding you back. A pitch, a yes/no question, pressure or a scripted rebuttal does not earn it. Once it is out in the open, react to how well they address it.`,
    ),
    section(
      'How to play the homeowner',
      bullets([
        'Stay in character for the whole conversation. You are a real person at your front door, not an assistant.',
        'Never coach, grade or give tips to the representative, and never suggest what they should say or ask.',
        'Never say or imply that you are an AI, a language model, a simulation or part of a training exercise, even if asked directly. If asked, react the way a real homeowner would to an odd question.',
        'Keep replies short and conversational: usually one to three sentences and rarely more than 60 words. People at the door do not give speeches.',
        'Speak plain spoken English: no stage directions, narration, emojis, markdown or quotation marks around your words.',
        'Stay within this scenario and your objection. Do not invent new major problems, other storms or offers the representative did not make. Use only the facts above about your home; if asked something you would not know, say so the way a homeowner would.',
        'React realistically. Warm up when the representative is respectful, listens, shows empathy, explains things clearly and asks good questions. Cool down or get impatient with pressure, jargon, rushing, scripted lines or claims that sound too good to be true, such as promises that insurance will pay, that the roof will be free or that they can cover your deductible.',
        'Do not agree to a next step just because you are asked. Agree only once your concern has been addressed and the representative proposes a clear, specific, low-pressure next step, such as an inspection on a particular day and time.',
      ]),
    ),
    scenario.aiInstructions.trim()
      ? section('Additional instructions for this scenario', scenario.aiInstructions)
      : '',
    section(
      'Ending the conversation',
      `When the conversation reaches its natural end, finish your final reply with exactly one of these markers at the very end:
- ${END_MARKERS.objective_reached} when you have just agreed to a clear, specific next step the representative proposed.
- ${END_MARKERS.homeowner_ended} when you are ending the conversation yourself (you have lost patience, asked them to leave or are closing the door).
Never mention or explain the marker and never use it any other way. Until the conversation truly ends, keep talking normally without a marker.`,
    ),
    section(
      'How the conversation started',
      `The representative knocked and you opened the door saying: "${scenario.openingLine}"`,
    ),
  ];
  return parts.filter(Boolean).join('\n\n');
}

/**
 * Evaluator system prompt: scenario facts the rep could not see, expected behaviours, rubric and
 * strict grounding rules (every point tied to quoted turns, no generic motivation).
 */
export function compileEvaluatorPrompt(
  persona: PersonaSnapshot,
  scenario: ScenarioSnapshot,
  categories: readonly RubricCategoryRecord[],
  passingScore: number,
): string {
  const rubric = categories
    .map(
      (c) =>
        `- \`${c.key}\` ${c.label} (weight ${c.weight}): ${c.description}${c.guidance.trim() ? `\n  Guidance: ${c.guidance.trim()}` : ''}`,
    )
    .join('\n');
  return [
    `You are an expert sales coach at A5 Roofing reviewing a recorded training role-play between a sales representative (REP) and a simulated homeowner (HOMEOWNER). Score the representative only; the homeowner was simulated. The representative needs ${passingScore}/100 to pass this scenario.`,
    section(
      'Scenario',
      [
        `Title: ${scenario.title} (${scenario.difficulty}, ${scenario.category})`,
        `Objection: "${scenario.objection}"`,
        `Situation: ${scenario.background}`,
        `Property: ${scenario.propertyContext}`,
        `Why the representative was there: ${scenario.trigger}`,
        `The homeowner's hidden concern (revealed only after genuine discovery): ${scenario.hiddenConcern}`,
        `Homeowner persona: ${persona.name}: ${persona.description} Temperament: ${persona.temperament}`,
      ].join('\n'),
    ),
    section(
      'What a strong representative does here',
      `Expected behaviours:\n${bullets(scenario.expectedBehaviors)}\n\nRequired talking points:\n${bullets(scenario.requiredTalkingPoints)}\n\nForbidden claims (compliance violations whether stated or implied):\n${bullets(scenario.forbiddenClaims)}`,
    ),
    section(
      'Rubric',
      `Score every category below from 0 to 100, using each category key exactly once.\n${rubric}\n\nAnchors: 90-100 exemplary and usable as a model answer; 75-89 solid with minor gaps; 60-74 partly effective; 40-59 significant gaps; below 40 missing or harmful. When the conversation never gave a natural opening for a category, score whether the representative missed an opening rather than scoring it automatically low. Any forbidden claim caps compliance at 40 and must appear in riskyStatements.`,
    ),
    section(
      'Feedback rules',
      bullets([
        "Ground every point in the transcript. Quotes must be copied exactly from the representative's lines, and `turn` is the number shown in brackets before that line.",
        'categoryScores: one entry per rubric category with a one- or two-sentence rationale that names what happened, plus up to two evidence quotes.',
        'strengths: two to four specific things the representative did well, each with evidence.',
        'missedOpportunities: two to five specific moments where a better move was available; give the turn and quote when it concerns something the representative said, otherwise use null.',
        'questionsToAsk: three to five discovery questions this representative should have asked in this conversation, and why each would have helped.',
        'riskyStatements: every non-compliant, misleading or pressuring statement, quoted exactly, with a safer alternative. Use an empty list when there are none.',
        'recommendedResponses: two to four rewrites of specific representative lines (quote what they said) with a stronger response and why it is stronger.',
        'nextGoal: one concrete, observable goal for the next attempt at this scenario.',
        'summary: two or three sentences on how the conversation went and what most affected the score.',
        'No generic motivation or empty praise such as "Great job!" or "Keep it up". Be direct, specific and respectful.',
        'Do not calculate an overall score; it is computed from the category scores and weights.',
      ]),
    ),
  ].join('\n\n');
}

/** First user turn: the scene cue (the homeowner then opens the door with the opening line). */
export const SCENE_CUE =
  '(The A5 Roofing representative knocks on your front door and you open it.)';

/** Provider messages for the homeowner: scene cue, then the transcript (homeowner = assistant). */
export function buildConversationMessages(
  transcript: readonly Pick<TranscriptLine, 'role' | 'content'>[],
): ChatMessage[] {
  return [
    { role: 'user', content: SCENE_CUE },
    ...transcript.map((m) => ({
      role: m.role === 'homeowner' ? ('assistant' as const) : ('user' as const),
      content: m.content,
    })),
  ];
}

const END_DESCRIPTIONS: Record<string, string> = {
  objective_reached: 'the homeowner agreed to a next step',
  homeowner_ended: 'the homeowner ended the conversation',
  max_turns: 'the turn limit was reached',
  rep_ended: 'the representative ended the conversation',
  timeout: 'the representative stopped responding',
};

/** Evaluation input: numbered transcript lines (the numbers are the `turn` references). */
export function formatTranscriptForEvaluation(
  transcript: readonly TranscriptLine[],
  endReason: string | null,
): string {
  const lines = transcript
    .map((m) => `[${m.seq}] ${m.role === 'rep' ? 'REP' : 'HOMEOWNER'}: ${m.content}`)
    .join('\n');
  const ending = endReason ? (END_DESCRIPTIONS[endReason] ?? endReason) : 'unknown';
  return `Transcript (${transcript.length} turns; ended because ${ending}):\n\n${lines}\n\nEvaluate the representative and submit the scorecard.`;
}

export interface PromptVersionContent {
  homeownerSystemPrompt: string;
  evaluatorSystemPrompt: string;
  personaSnapshot: PersonaSnapshot;
  scenarioSnapshot: ScenarioSnapshot;
  provider: ProviderName | null;
  model: string | null;
  evaluationModel: string | null;
  modelSettings: ModelSettingsRecord;
  rubricVersionId: string;
}

export function compilePromptVersion(input: {
  persona: PersonaSnapshot;
  scenario: ScenarioSnapshot;
  categories: readonly RubricCategoryRecord[];
  rubricVersionId: string;
  provider: ProviderName | null;
  model: string | null;
  evaluationModel: string | null;
  modelSettings: ModelSettingsRecord;
}): PromptVersionContent {
  return {
    homeownerSystemPrompt: compileHomeownerPrompt(input.persona, input.scenario),
    evaluatorSystemPrompt: compileEvaluatorPrompt(
      input.persona,
      input.scenario,
      input.categories,
      input.scenario.passingScore,
    ),
    personaSnapshot: input.persona,
    scenarioSnapshot: input.scenario,
    provider: input.provider,
    model: input.model,
    evaluationModel: input.evaluationModel,
    modelSettings: input.modelSettings,
    rubricVersionId: input.rubricVersionId,
  };
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as object)
        .sort()
        .map((k) => [k, stable((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}

/** Content hash of a prompt version; an unchanged hash means no new version is needed. */
export function promptContentHash(content: PromptVersionContent): string {
  return createHash('sha256')
    .update(JSON.stringify(stable(content)))
    .digest('hex');
}
