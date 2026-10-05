import { describe, expect, it } from 'vitest';
import { DEFAULT_RUBRIC_CATEGORIES } from '../rubrics/default-categories.js';
import type { PersonaSnapshot, ScenarioSnapshot } from '../providers/types.js';
import {
  END_MARKERS,
  SCENE_CUE,
  buildConversationMessages,
  compileEvaluatorPrompt,
  compileHomeownerPrompt,
  compilePromptVersion,
  formatTranscriptForEvaluation,
  promptContentHash,
} from './compiler.js';

const persona: PersonaSnapshot = {
  id: 'p1',
  name: 'Busy homeowner',
  description: 'Always mid-task, keys in hand.',
  temperament: 'Hurried, clipped and impatient.',
  speakingStyle: 'Short sentences.',
  background: 'Works long hours.',
  traits: ['Checks the time', 'Warms up when someone is brief'],
};

const scenario: ScenarioSnapshot = {
  id: 's1',
  title: 'The Busy Homeowner',
  category: 'Brush-off',
  difficulty: 'beginner',
  objection: "I don't have time.",
  background: 'It is 5:15 p.m. in a Plano subdivision.',
  propertyContext: 'A 2009 two-story with original 3-tab shingles after the April 14 hailstorm.',
  trigger: 'A5 Roofing is canvassing after the storm.',
  hiddenConcern:
    'A salesman once sat at your table for two hours. You are worried about the stain in the hall closet.',
  expectedBehaviors: ['Acknowledges the time pressure'],
  requiredTalkingPoints: ['The inspection takes fifteen minutes'],
  forbiddenClaims: ['Promising that insurance will pay'],
  aiInstructions: 'Glance at your keys often.',
  openingLine: "Oh, hi. I really don't have time right now.",
  passingScore: 75,
  maxTurns: 10,
};

describe('homeowner prompt', () => {
  const prompt = compileHomeownerPrompt(persona, scenario);

  it('puts persona, situation, property and objection into the prompt', () => {
    expect(prompt).toContain('Busy homeowner: Always mid-task, keys in hand.');
    expect(prompt).toContain('Temperament: Hurried, clipped and impatient.');
    expect(prompt).toContain('How you talk: Short sentences.');
    expect(prompt).toContain('- Checks the time');
    expect(prompt).toContain('It is 5:15 p.m. in a Plano subdivision.');
    expect(prompt).toContain(
      '2009 two-story with original 3-tab shingles after the April 14 hailstorm',
    );
    expect(prompt).toContain('A5 Roofing is canvassing after the storm.');
    expect(prompt).toContain(`"I don't have time."`);
    expect(prompt).toContain(`you opened the door saying: "${scenario.openingLine}"`);
    expect(prompt).toContain('Glance at your keys often.');
  });

  it('keeps the hidden concern private until genuine discovery', () => {
    const section = prompt.slice(prompt.indexOf('# What you are not saying yet'));
    expect(section).toContain(scenario.hiddenConcern);
    expect(section).toMatch(/Keep this to yourself at first/);
    expect(section).toMatch(/genuine, open-ended discovery question/);
    expect(section).toMatch(/does not earn it/);
  });

  it('sets the role rules: in character, never coach, never reveal being an AI, short replies', () => {
    expect(prompt).toMatch(/Stay in character for the whole conversation/);
    expect(prompt).toMatch(/Never coach, grade or give tips/);
    expect(prompt).toMatch(/Never say or imply that you are an AI/);
    expect(prompt).toMatch(/usually one to three sentences and rarely more than 60 words/);
    expect(prompt).toMatch(/Stay within this scenario and your objection/);
    expect(prompt).toMatch(/promises that insurance will pay, that the roof will be free/);
  });

  it('defines the end-marker protocol', () => {
    expect(prompt).toContain(END_MARKERS.objective_reached);
    expect(prompt).toContain(END_MARKERS.homeowner_ended);
    expect(prompt).toMatch(/Never mention or explain the marker/);
    expect(END_MARKERS.objective_reached).toBe('[[END:objective_reached]]');
  });

  it('omits empty optional sections and is deterministic', () => {
    expect(compileHomeownerPrompt(persona, { ...scenario, aiInstructions: '  ' })).not.toContain(
      'Additional instructions',
    );
    expect(compileHomeownerPrompt(persona, scenario)).toBe(prompt);
    expect(compileHomeownerPrompt({ ...persona, traits: [] }, scenario)).not.toContain('Traits:');
  });
});

describe('evaluator prompt', () => {
  const prompt = compileEvaluatorPrompt(persona, scenario, DEFAULT_RUBRIC_CATEGORIES, 75);

  it('contains the rubric with keys, weights and guidance', () => {
    for (const c of DEFAULT_RUBRIC_CATEGORIES)
      expect(prompt).toContain(`\`${c.key}\` ${c.label} (weight ${c.weight})`);
    expect(DEFAULT_RUBRIC_CATEGORIES).toHaveLength(14);
    expect(DEFAULT_RUBRIC_CATEGORIES.reduce((s, c) => s + c.weight, 0)).toBe(100);
    expect(prompt).toContain('needs 75/100 to pass');
    expect(prompt).toContain('Any forbidden claim caps compliance at 40');
  });

  it('gives the evaluator what the rep could not see and the expectations to grade against', () => {
    expect(prompt).toContain(
      `hidden concern (revealed only after genuine discovery): ${scenario.hiddenConcern}`,
    );
    expect(prompt).toContain('- Acknowledges the time pressure');
    expect(prompt).toContain('- The inspection takes fifteen minutes');
    expect(prompt).toContain('- Promising that insurance will pay');
  });

  it('demands grounded, specific feedback', () => {
    expect(prompt).toMatch(/Quotes must be copied exactly/);
    expect(prompt).toMatch(/`turn` is the number shown in brackets/);
    expect(prompt).toMatch(/No generic motivation/);
    expect(prompt).toMatch(/riskyStatements: every non-compliant/);
    expect(prompt).toMatch(/Do not calculate an overall score/);
  });
});

describe('conversation and evaluation messages', () => {
  it('maps the homeowner to assistant and the rep to user after a scene cue', () => {
    expect(
      buildConversationMessages([
        { role: 'homeowner', content: 'Oh, hi.' },
        { role: 'rep', content: 'Hi, I am Pat.' },
      ]),
    ).toEqual([
      { role: 'user', content: SCENE_CUE },
      { role: 'assistant', content: 'Oh, hi.' },
      { role: 'user', content: 'Hi, I am Pat.' },
    ]);
  });

  it('numbers transcript lines so feedback can cite turns', () => {
    const text = formatTranscriptForEvaluation(
      [
        { seq: 1, role: 'homeowner', content: 'Oh, hi.' },
        { seq: 2, role: 'rep', content: 'Hi, I am Pat.' },
      ],
      'objective_reached',
    );
    expect(text).toContain('[1] HOMEOWNER: Oh, hi.');
    expect(text).toContain('[2] REP: Hi, I am Pat.');
    expect(text).toContain('ended because the homeowner agreed to a next step');
  });
});

describe('prompt version content hash', () => {
  const base = {
    persona,
    scenario,
    categories: DEFAULT_RUBRIC_CATEGORIES,
    rubricVersionId: 'rv1',
    provider: null,
    model: null,
    evaluationModel: null,
    modelSettings: {},
  } as const;

  it('is stable for identical content and changes with any prompt-relevant input', () => {
    const hash = promptContentHash(compilePromptVersion(base));
    expect(promptContentHash(compilePromptVersion({ ...base }))).toBe(hash);
    const changed = (patch: Partial<typeof base>) =>
      promptContentHash(compilePromptVersion({ ...base, ...patch }));
    expect(changed({ scenario: { ...scenario, openingLine: 'Hello.' } })).not.toBe(hash);
    expect(changed({ scenario: { ...scenario, hiddenConcern: 'Something else.' } })).not.toBe(hash);
    expect(changed({ persona: { ...persona, temperament: 'Calm.' } })).not.toBe(hash);
    expect(changed({ rubricVersionId: 'rv2' })).not.toBe(hash);
    expect(changed({ model: 'claude-opus-5-5' })).not.toBe(hash);
    expect(changed({ modelSettings: { effort: 'low' } })).not.toBe(hash);
    expect(
      changed({
        categories: DEFAULT_RUBRIC_CATEGORIES.map((c) =>
          c.key === 'compliance' ? { ...c, weight: 12 } : c,
        ),
      }),
    ).not.toBe(hash);
  });
});
