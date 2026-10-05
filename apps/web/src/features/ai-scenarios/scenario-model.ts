import { ai } from '@a5/contracts';

/** Form state: everything is text so inputs stay controlled; `buildRequest` converts it. */
export interface ScenarioFormValues {
  title: string;
  category: string;
  difficulty: ai.ScenarioDifficulty;
  personaId: string;
  rubricId: string;
  objection: string;
  repBrief: string;
  background: string;
  propertyContext: string;
  trigger: string;
  hiddenConcern: string;
  openingLine: string;
  aiInstructions: string;
  /** One item per line. */
  expectedBehaviors: string;
  requiredTalkingPoints: string;
  forbiddenClaims: string;
  passingScore: string;
  maxTurns: string;
  provider: '' | ai.AiProvider;
  model: string;
  evaluationModel: string;
  temperature: string;
  maxOutputTokens: string;
  effort: '' | (typeof ai.EFFORT_LEVELS)[number];
  evaluationEffort: '' | (typeof ai.EFFORT_LEVELS)[number];
  changeNote: string;
}

export const FIELD_NAMES = [
  'title',
  'category',
  'difficulty',
  'personaId',
  'rubricId',
  'objection',
  'repBrief',
  'background',
  'propertyContext',
  'trigger',
  'hiddenConcern',
  'openingLine',
  'aiInstructions',
  'expectedBehaviors',
  'requiredTalkingPoints',
  'forbiddenClaims',
  'passingScore',
  'maxTurns',
  'provider',
  'model',
  'evaluationModel',
  'temperature',
  'maxOutputTokens',
  'effort',
  'evaluationEffort',
  'changeNote',
] as const satisfies ReadonlyArray<keyof ScenarioFormValues>;

export function emptyScenario(): ScenarioFormValues {
  return {
    title: '',
    category: '',
    difficulty: 'intermediate',
    personaId: '',
    rubricId: '',
    objection: '',
    repBrief: '',
    background: '',
    propertyContext: '',
    trigger: '',
    hiddenConcern: '',
    openingLine: '',
    aiInstructions: '',
    expectedBehaviors: '',
    requiredTalkingPoints: '',
    forbiddenClaims: '',
    passingScore: '75',
    maxTurns: '10',
    provider: '',
    model: '',
    evaluationModel: '',
    temperature: '',
    maxOutputTokens: '',
    effort: '',
    evaluationEffort: '',
    changeNote: '',
  };
}

export function fromScenario(s: ai.ScenarioDetail): ScenarioFormValues {
  return {
    title: s.title,
    category: s.category,
    difficulty: s.difficulty,
    personaId: s.persona.id,
    rubricId: s.rubric.id,
    objection: s.objection,
    repBrief: s.repBrief,
    background: s.background,
    propertyContext: s.propertyContext,
    trigger: s.trigger,
    hiddenConcern: s.hiddenConcern,
    openingLine: s.openingLine,
    aiInstructions: s.aiInstructions,
    expectedBehaviors: s.expectedBehaviors.join('\n'),
    requiredTalkingPoints: s.requiredTalkingPoints.join('\n'),
    forbiddenClaims: s.forbiddenClaims.join('\n'),
    passingScore: String(s.passingScore),
    maxTurns: String(s.maxTurns),
    provider: s.provider ?? '',
    model: s.model ?? '',
    evaluationModel: s.evaluationModel ?? '',
    temperature:
      s.modelSettings.temperature === undefined ? '' : String(s.modelSettings.temperature),
    maxOutputTokens:
      s.modelSettings.maxOutputTokens === undefined ? '' : String(s.modelSettings.maxOutputTokens),
    effort: s.modelSettings.effort ?? '',
    evaluationEffort: s.modelSettings.evaluationEffort ?? '',
    changeNote: '',
  };
}

const lines = (s: string) =>
  s
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
const number = (s: string) => (s.trim() === '' ? undefined : Number(s));
const orNull = (s: string) => (s.trim() === '' ? null : s.trim());

/** The request body the API expects, built from form text (not yet validated). */
export function buildRequest(v: ScenarioFormValues) {
  const modelSettings: ai.ModelSettings = {};
  const temperature = number(v.temperature);
  const maxOutputTokens = number(v.maxOutputTokens);
  if (temperature !== undefined) modelSettings.temperature = temperature;
  if (maxOutputTokens !== undefined) modelSettings.maxOutputTokens = maxOutputTokens;
  if (v.effort) modelSettings.effort = v.effort;
  if (v.evaluationEffort) modelSettings.evaluationEffort = v.evaluationEffort;
  return {
    title: v.title,
    category: v.category,
    difficulty: v.difficulty,
    personaId: v.personaId,
    objection: v.objection,
    repBrief: v.repBrief,
    background: v.background,
    propertyContext: v.propertyContext,
    trigger: v.trigger,
    hiddenConcern: v.hiddenConcern,
    expectedBehaviors: lines(v.expectedBehaviors),
    requiredTalkingPoints: lines(v.requiredTalkingPoints),
    forbiddenClaims: lines(v.forbiddenClaims),
    aiInstructions: v.aiInstructions,
    openingLine: v.openingLine,
    passingScore: number(v.passingScore),
    rubricId: v.rubricId,
    maxTurns: number(v.maxTurns),
    provider: v.provider || null,
    model: orNull(v.model),
    evaluationModel: orNull(v.evaluationModel),
    modelSettings,
    ...(v.changeNote.trim() && { changeNote: v.changeNote.trim() }),
  };
}

export interface FieldIssue {
  field: keyof ScenarioFormValues;
  message: string;
}

/** Maps a path in the API request to the form field the user can fix. */
function fieldForPath(path: ReadonlyArray<PropertyKey>): keyof ScenarioFormValues | null {
  const [head, second] = path;
  if (head === 'modelSettings' && typeof second === 'string') {
    return (['temperature', 'maxOutputTokens', 'effort', 'evaluationEffort'] as const).includes(
      second as 'temperature',
    )
      ? (second as keyof ScenarioFormValues)
      : null;
  }
  return typeof head === 'string' && (FIELD_NAMES as readonly string[]).includes(head)
    ? (head as keyof ScenarioFormValues)
    : null;
}

export function friendlyIssue(issue: {
  code: string;
  message: string;
  origin?: unknown;
  maximum?: unknown;
  minimum?: unknown;
}): string {
  if (issue.code === 'too_big' && issue.origin === 'string')
    return `Use at most ${String(issue.maximum)} characters`;
  if (issue.code === 'too_big' && issue.origin === 'array')
    return `Use at most ${String(issue.maximum)} lines`;
  if (issue.code === 'too_big') return `Use ${String(issue.maximum)} or less`;
  if (issue.code === 'too_small' && issue.origin === 'number')
    return `Use ${String(issue.minimum)} or more`;
  if (issue.code === 'too_small') return 'Required';
  if (issue.code === 'invalid_type') return 'Required';
  if (issue.code === 'invalid_format') return 'Choose one of the options';
  return issue.message;
}

/**
 * Validates with the same schema the API uses, so the form and the server never disagree about
 * what is allowed. Returns the first message per field.
 */
export function validateScenario(
  values: ScenarioFormValues,
): { ok: true; request: ai.CreateScenarioRequest } | { ok: false; issues: FieldIssue[] } {
  const parsed = ai.createScenarioRequestSchema.safeParse(buildRequest(values));
  if (parsed.success) return { ok: true, request: parsed.data };
  const seen = new Set<string>();
  const issues: FieldIssue[] = [];
  for (const issue of parsed.error.issues) {
    const field = fieldForPath(issue.path);
    if (!field || seen.has(field)) continue;
    seen.add(field);
    const message =
      field === 'personaId'
        ? 'Choose a persona'
        : field === 'rubricId'
          ? 'Choose a rubric'
          : friendlyIssue(issue);
    issues.push({ field, message });
  }
  return { ok: false, issues };
}

/** Only the request fields that differ from the saved scenario, so a save changes what was edited. */
export function changedFields(
  request: ai.CreateScenarioRequest,
  saved: ScenarioFormValues,
): ai.UpdateScenarioRequest {
  const before = buildRequest(saved) as Record<string, unknown>;
  const patch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(request)) {
    if (key === 'changeNote') continue;
    if (JSON.stringify(value) !== JSON.stringify(before[key])) patch[key] = value;
  }
  if (request.changeNote) patch.changeNote = request.changeNote;
  return patch as ai.UpdateScenarioRequest;
}
