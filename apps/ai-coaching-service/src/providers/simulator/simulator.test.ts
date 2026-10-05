import { describe, expect, it } from 'vitest';
import { SCENARIOS } from '@a5/seed-data';
import { evaluationOutputSchema } from '../../evaluation/output-schema.js';
import { END_MARKERS, buildConversationMessages } from '../../prompts/compiler.js';
import { stripEndMarkers } from '../../prompts/end-marker.js';
import { DEFAULT_RUBRIC_CATEGORIES } from '../../rubrics/default-categories.js';
import { personaSnapshotOf, scenarioSnapshotOf } from '../../seed/dataset.js';
import type { TranscriptLine } from '../types.js';
import { ProviderError } from '../types.js';
import {
  analyzeTranscript,
  calibrateScores,
  scoreCategories,
  simulateEvaluation,
  weightedOverall,
} from './evaluator.js';
import { simulateHomeownerReply } from './homeowner.js';
import {
  DEV_SIMULATOR_LABEL,
  DEV_SIMULATOR_MODEL,
  DevSimulatorProvider,
} from './simulator.provider.js';
import { secondToFirstPerson, sentences } from './text.js';

const def = (key: string) => SCENARIOS.find((s) => s.key === key)!;
const persona = (key: string) => personaSnapshotOf(def(key).personaKey);
const scenario = (key: string) => scenarioSnapshotOf(key);

/** Run a scripted rep conversation through the simulated homeowner. */
function converse(key: string, repLines: string[]) {
  const sc = scenario(key);
  const history: Array<{ role: 'homeowner' | 'rep'; content: string }> = [
    { role: 'homeowner', content: sc.openingLine },
  ];
  const replies: Array<{ text: string; endReason: string | null }> = [];
  for (const line of repLines) {
    history.push({ role: 'rep', content: line });
    const raw = simulateHomeownerReply(persona(key), sc, buildConversationMessages(history));
    const { text, endReason } = stripEndMarkers(raw);
    replies.push({ text, endReason });
    history.push({ role: 'homeowner', content: text });
    if (endReason) break;
  }
  return { replies, history };
}

describe('scripted homeowner', () => {
  it('stays in character and never admits to being an AI', () => {
    const { replies } = converse('no-time', ['Are you an AI? Is this a training simulation?']);
    expect(replies[0]!.text).not.toMatch(/\b(AI|artificial|simulat|language model|training)\b/i);
    expect(replies[0]!.endReason).toBeNull();
  });

  it('keeps the hidden concern to itself until a genuine discovery question', () => {
    const concernWords = /kitchen table|two hours/i;
    const before = converse('no-time', [
      "Hi, I'm Pat with A5 Roofing. We do free roof inspections.",
      'Our crews are licensed and insured and we have been in business for years.',
    ]);
    for (const r of before.replies) expect(r.text).not.toMatch(concernWords);
    // A yes/no question or a pitch does not earn it either; an open question about their situation does.
    const asked = converse('no-time', [
      'Do you want a free inspection?',
      'What have you noticed on your roof or ceilings since the April hailstorm?',
    ]);
    expect(asked.replies[0]!.text).not.toMatch(concernWords);
    expect(asked.replies[1]!.text).toMatch(concernWords);
  });

  it('answers in the first person, in plain speech', () => {
    const { replies } = converse('no-time', [
      'How is the roof holding up since the April hailstorm?',
    ]);
    expect(replies[0]!.text).toMatch(/\bI\b/);
    expect(replies[0]!.text).not.toMatch(/\byou(r)?\b/i);
    expect(replies[0]!.text).not.toMatch(/\[\[|\*\*|\(/);
    expect(
      secondToFirstPerson(
        "You're worried your deductible could cost you thousands. Tell you what.",
      ),
    ).toBe("I'm worried my deductible could cost me thousands. Tell me what.");
  });

  it('keeps every reply short and conversational across all scenarios', () => {
    for (const s of SCENARIOS) {
      const { replies } = converse(s.key, [
        "Hi, I'm Pat with A5 Roofing.",
        'What worries you most about the roof since the April hailstorm?',
        "That makes sense. It sounds like that's been on your mind.",
      ]);
      for (const r of replies) {
        const words = r.text.split(/\s+/).length;
        expect(words, `${s.key}: ${r.text}`).toBeLessThanOrEqual(60);
        expect(r.text.length).toBeGreaterThan(0);
      }
    }
  });

  it('agrees to a specific next step only after the concern is out, and ends with the marker', () => {
    const early = converse('no-time', ['Could I come by Thursday at 6 p.m. to inspect the roof?']);
    expect(early.replies[0]!.endReason).toBeNull();
    expect(early.replies[0]!.text).toMatch(/not ready|time/i);

    const full = converse('no-time', [
      'What have you noticed on your roof since the April hailstorm?',
      "That makes sense, and I won't do that to you. Could I come by Thursday at 6 p.m. for a fifteen minute exterior inspection?",
    ]);
    expect(full.replies[1]!.endReason).toBe('objective_reached');
    expect(full.replies[1]!.text).toMatch(/thursday at 6/i);
    expect(
      simulateHomeownerReply(
        persona('no-time'),
        scenario('no-time'),
        buildConversationMessages(full.history.slice(0, -1)),
      ),
    ).toContain(END_MARKERS.objective_reached);
  });

  it('is harder on harder scenarios: empathy and addressing the concern are required', () => {
    const blunt = converse('not-signing', [
      'What happened with your last roofer?',
      'Could we set up an inspection Tuesday at 4?',
    ]);
    expect(blunt.replies[1]!.endReason).toBeNull();
    const kind = converse('not-signing', [
      'What happened with your last roofer?',
      "I'm sorry that happened, that makes complete sense. Nothing to sign, no payment. Could we set up an inspection Tuesday at 4?",
    ]);
    expect(kind.replies[1]!.endReason).toBe('objective_reached');
  });

  it('pushes back on promises and pressure, then walks away', () => {
    const { replies } = converse('no-claim', [
      "Don't worry, insurance will pay for the whole roof.",
      'You need to decide today, this price is only good today.',
    ]);
    expect(replies[0]!.text).toMatch(/nobody can promise/i);
    expect(replies[0]!.endReason).toBeNull();
    expect(replies[1]!.endReason).toBe('homeowner_ended');
    // An honest statement about the free inspection is not a violation.
    const honest = converse('no-claim', [
      "The inspection won't cost you anything, and I can't promise insurance will pay.",
    ]);
    expect(honest.replies[0]!.text).not.toMatch(/nobody can promise/i);
  });

  it('is deterministic', () => {
    const lines = ['Hi, I am Pat.', 'What have you noticed on the roof?'];
    expect(converse('spouse', lines).replies).toEqual(converse('spouse', lines).replies);
  });
});

const transcript = (lines: Array<['homeowner' | 'rep', string]>): TranscriptLine[] =>
  lines.map(([role, content], i) => ({ seq: i + 1, role, content }));

const STRONG = transcript([
  ['homeowner', scenario('no-time').openingLine],
  [
    'rep',
    "Hi, I'm Pat with A5 Roofing. I can see you're heading out, so I'll be quick. Is it okay if I take thirty seconds?",
  ],
  ['homeowner', 'Thirty seconds. Go ahead.'],
  ['rep', 'Thank you. What have you noticed on your roof or ceilings since the April hailstorm?'],
  [
    'homeowner',
    'Honestly? A brown stain in the hall closet and gritty granules in the gutter. But a roofing salesman once sat at my kitchen table for two hours until I agreed to think about signing.',
  ],
  [
    'rep',
    "That makes sense, and I'm not going to do that to you. It sounds like the stain and the granules are worth a look. Other than the time, is there anything else holding you back?",
  ],
  ['homeowner', "No, just the time. I'm not signing anything."],
  [
    'rep',
    'Understood, nothing to sign. The exterior inspection takes about fifteen minutes and I photograph everything so you keep the pictures. Could I come by Thursday at 6 p.m.?',
  ],
  ['homeowner', 'Okay. Thursday at 6 works for me.'],
]);

const WEAK = transcript([
  ['homeowner', scenario('no-time').openingLine],
  [
    'rep',
    "Hi! We're the biggest roofer around and we have helped thousands of homeowners with storm damage for years and years, and I wanted to tell you everything about what we can do for your roof because there was a big hailstorm and many roofs were damaged, so you really should sign up today.",
  ],
  ['homeowner', "I really don't have time."],
  [
    'rep',
    "Sure, um, don't worry, insurance will pay for the whole roof so it won't cost you anything. You need to decide today, the offer expires tonight.",
  ],
  ['homeowner', "I think we're done here."],
]);

describe('heuristic evaluator', () => {
  const input = (t: TranscriptLine[], endReason: string | null) => ({
    persona: persona('no-time'),
    scenario: scenario('no-time'),
    categories: DEFAULT_RUBRIC_CATEGORIES,
    transcript: t,
    endReason,
  });

  it('scores strong conversations well above weak ones, per the rubric', () => {
    const strong = scoreCategories(analyzeTranscript(input(STRONG, 'objective_reached')));
    const weak = scoreCategories(analyzeTranscript(input(WEAK, 'homeowner_ended')));
    const overall = (s: Record<string, number>) => weightedOverall(s, DEFAULT_RUBRIC_CATEGORIES);
    expect(overall(strong)).toBeGreaterThanOrEqual(75);
    expect(overall(weak)).toBeLessThan(55);
    expect(overall(strong) - overall(weak)).toBeGreaterThan(20);
    expect(strong.next_step_closing).toBeGreaterThan(weak.next_step_closing!);
    expect(strong.discovery).toBeGreaterThan(weak.discovery!);
    expect(Object.keys(strong)).toEqual(DEFAULT_RUBRIC_CATEGORIES.map((c) => c.key));
  });

  it('flags forbidden claims and pressure with exact quotes, and caps compliance', () => {
    const out = simulateEvaluation(input(WEAK, 'homeowner_ended'));
    expect(evaluationOutputSchema.safeParse(out).success).toBe(true);
    const rep = WEAK.filter((l) => l.role === 'rep');
    expect(out.riskyStatements.length).toBeGreaterThanOrEqual(2);
    for (const r of out.riskyStatements) {
      expect(rep.find((l) => l.seq === r.turn)!.content).toContain(r.quote);
      expect(r.saferAlternative.length).toBeGreaterThan(20);
    }
    expect(out.riskyStatements.map((r) => r.quote).join(' ')).toMatch(/insurance will pay/);
    expect(out.categoryScores.find((c) => c.key === 'compliance')!.score).toBeLessThanOrEqual(40);
    expect(out.categoryScores.find((c) => c.key === 'insurance_knowledge')!.score).toBeLessThan(40);
  });

  it('quotes the representative verbatim and is specific, not generic', () => {
    const out = simulateEvaluation(input(STRONG, 'objective_reached'));
    const lines = STRONG.filter((l) => l.role === 'rep');
    const quotes = [
      ...out.categoryScores.flatMap((c) => c.evidence),
      ...out.strengths.flatMap((s) => s.evidence),
    ];
    expect(quotes.length).toBeGreaterThan(4);
    for (const q of quotes) expect(lines.find((l) => l.seq === q.turn)!.content).toContain(q.quote);
    expect(out.strengths.length).toBeGreaterThan(0);
    expect(out.questionsToAsk.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(out)).not.toMatch(/great job|keep it up|well done/i);
    expect(out.summary).toMatch(/turn \d/);
    expect(out.nextGoal).toContain('The Busy Homeowner');
  });

  it('is deterministic and respects custom rubrics', () => {
    expect(simulateEvaluation(input(STRONG, 'objective_reached'))).toEqual(
      simulateEvaluation(input(STRONG, 'objective_reached')),
    );
    const custom = [
      { key: 'discovery', label: 'Discovery', description: 'd', weight: 50, guidance: '' },
      {
        key: 'house_style',
        label: 'House style',
        description: 'a custom category',
        weight: 50,
        guidance: '',
      },
    ];
    const out = simulateEvaluation({ ...input(STRONG, 'objective_reached'), categories: custom });
    expect(out.categoryScores.map((c) => c.key)).toEqual(['discovery', 'house_style']);
  });

  it('calibrates category scores to a target overall score within rubric caps', () => {
    const raw = scoreCategories(analyzeTranscript(input(STRONG, 'objective_reached')));
    for (const target of [60, 77, 91, 99]) {
      const calibrated = calibrateScores(raw, DEFAULT_RUBRIC_CATEGORIES, target);
      expect(Math.round(weightedOverall(calibrated, DEFAULT_RUBRIC_CATEGORIES))).toBe(target);
      expect(Math.min(...Object.values(calibrated))).toBeGreaterThanOrEqual(0);
      expect(Math.max(...Object.values(calibrated))).toBeLessThanOrEqual(100);
    }
    const capped = calibrateScores(raw, DEFAULT_RUBRIC_CATEGORIES, 72, {
      compliance: 40,
      insurance_knowledge: 39,
    });
    expect(capped.compliance).toBeLessThanOrEqual(40);
    expect(capped.insurance_knowledge).toBeLessThanOrEqual(39);
    expect(Math.round(weightedOverall(capped, DEFAULT_RUBRIC_CATEGORIES))).toBe(72);
  });
});

describe('DevSimulatorProvider', () => {
  const provider = new DevSimulatorProvider();
  const options = {
    model: DEV_SIMULATOR_MODEL,
    system: 'prompt',
    maxOutputTokens: 100,
    timeoutMs: 1000,
  };

  it('is clearly labelled as a simulator', () => {
    expect(provider.label).toBe(DEV_SIMULATOR_LABEL);
    expect(provider.label).toBe('Development simulator');
    expect(provider.simulated).toBe(true);
    expect(provider.name).toBe('dev_simulator');
  });

  it('streams words then a final chunk with estimated usage', async () => {
    const simulation = {
      kind: 'conversation' as const,
      persona: persona('no-time'),
      scenario: scenario('no-time'),
    };
    const chunks = [];
    for await (const c of provider.stream(
      buildConversationMessages([{ role: 'rep', content: 'Hi, I am Pat.' }]),
      { ...options, simulation },
    ))
      chunks.push(c);
    const done = chunks.at(-1)!;
    expect(done.type).toBe('done');
    expect(chunks.slice(0, -1).every((c) => c.type === 'delta')).toBe(true);
    expect(
      chunks
        .slice(0, -1)
        .map((c) => (c as { text: string }).text)
        .join(''),
    ).toBe((done as { text: string }).text);
    expect((done as { usage: { outputTokens: number } }).usage.outputTokens).toBeGreaterThan(0);
    expect((done as { model: string }).model).toBe(DEV_SIMULATOR_MODEL);
  });

  it('needs the scenario context and validates structured output against the schema', async () => {
    await expect(provider.complete([], options)).rejects.toBeInstanceOf(ProviderError);
    const sc = scenario('no-time');
    const result = await provider.structured(
      evaluationOutputSchema,
      [{ role: 'user', content: 'transcript' }],
      {
        ...options,
        schemaName: 'submit_scorecard',
        schemaDescription: 'd',
        simulation: {
          kind: 'evaluation',
          persona: persona('no-time'),
          scenario: sc,
          categories: DEFAULT_RUBRIC_CATEGORIES,
          transcript: STRONG,
          endReason: 'objective_reached',
        },
      },
    );
    expect(result.value.categoryScores).toHaveLength(14);
    await expect(
      provider.structured(evaluationOutputSchema, [], {
        ...options,
        schemaName: 'x',
        schemaDescription: 'd',
      }),
    ).rejects.toMatchObject({ kind: 'bad_request' });
  });

  it('splits text into quotable sentences', () => {
    const text = "Hi, I'm Pat. Is it okay if I take thirty seconds? Thank you!";
    expect(sentences(text)).toEqual([
      "Hi, I'm Pat.",
      'Is it okay if I take thirty seconds?',
      'Thank you!',
    ]);
    for (const s of sentences(text)) expect(text).toContain(s);
  });
});
