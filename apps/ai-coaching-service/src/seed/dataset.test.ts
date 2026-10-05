import { describe, expect, it } from 'vitest';
import { JOURNEYS, PERSONAS, PROGRAM, SCENARIOS, allLessons } from '@a5/seed-data';
import { scorecardSchema } from '@a5/contracts/ai';
import { compileHomeownerPrompt } from '../prompts/compiler.js';
import { PERSONA_CONTENT } from './content/personas.js';
import { SCENARIO_CONTENT } from './content/scenarios.js';
import { TRANSCRIPTS } from './content/transcripts.js';
import {
  SEED_PERSONAS,
  SEED_RUBRIC,
  SEED_SCENARIOS,
  buildSeedSessions,
  personaSnapshotOf,
  scenarioSnapshotOf,
} from './dataset.js';

const sessions = buildSeedSessions();
const journeySessions = JOURNEYS.flatMap((j) =>
  j.aiSessions.map((s) => ({ person: j.person, ...s })),
);

describe('seeded content', () => {
  it('has a rich persona for every seeded persona key', () => {
    expect(SEED_PERSONAS).toHaveLength(PERSONAS.length);
    for (const p of SEED_PERSONAS) {
      expect(p.description.length, p.key).toBeGreaterThan(120);
      expect(p.speakingStyle.length).toBeGreaterThan(60);
      expect(p.background.length).toBeGreaterThan(60);
      expect(p.traits.length).toBeGreaterThanOrEqual(3);
    }
    expect(Object.keys(PERSONA_CONTENT).sort()).toEqual(PERSONAS.map((p) => p.key).sort());
  });

  it('uses the 14-category A5 rubric with weights summing to 100', () => {
    expect(SEED_RUBRIC.categories.map((c) => c.key)).toEqual([
      'discovery',
      'listening',
      'rapport',
      'empathy',
      'communication',
      'confidence',
      'roofing_knowledge',
      'insurance_knowledge',
      'value_presentation',
      'objection_isolation',
      'objection_handling',
      'question_quality',
      'next_step_closing',
      'compliance',
    ]);
    expect(SEED_RUBRIC.categories.reduce((s, c) => s + c.weight, 0)).toBe(100);
    for (const c of SEED_RUBRIC.categories) {
      expect(c.description.length).toBeGreaterThan(30);
      expect(c.guidance.length).toBeGreaterThan(30);
    }
  });

  it('defines every scenario completely and realistically', () => {
    expect(SEED_SCENARIOS).toHaveLength(10);
    expect(Object.keys(SCENARIO_CONTENT).sort()).toEqual(SCENARIOS.map((s) => s.key).sort());
    for (const s of SEED_SCENARIOS) {
      const r = s.request;
      expect(r.background.length, s.key).toBeGreaterThan(80);
      expect(r.propertyContext.length).toBeGreaterThan(80);
      expect(r.hiddenConcern.length).toBeGreaterThan(100);
      expect(r.expectedBehaviors.length).toBeGreaterThanOrEqual(5);
      expect(r.requiredTalkingPoints.length).toBeGreaterThanOrEqual(4);
      expect(r.forbiddenClaims.join(' ')).toMatch(/insurance will pay/i);
      expect(r.forbiddenClaims.join(' ')).toMatch(/free or will cost/i);
      expect(r.aiInstructions.length).toBeGreaterThan(100);
      expect(r.openingLine.length).toBeGreaterThan(20);
      expect(r.repBrief).not.toContain(r.hiddenConcern.slice(0, 40));
      expect(r.maxTurns).toBeGreaterThanOrEqual(8);
      expect(`${r.background} ${r.propertyContext} ${r.repBrief}`).toMatch(
        /Plano|Fort Worth|Frisco|Richardson|McKinney|Arlington|Garland|Irving|Denton|Southlake/,
      );
      expect(`${r.background} ${r.propertyContext}`).not.toMatch(/lorem|ipsum|John Doe/i);
    }
    // The brief's example: 2009 3-tab shingles in Plano after an April hail storm.
    expect(SEED_SCENARIOS.find((s) => s.key === 'no-time')!.request.propertyContext).toMatch(
      /2009.*3-tab shingles.*April/s,
    );
  });

  it('compiles a homeowner prompt for every seeded scenario that never leaks into the rep brief', () => {
    for (const s of SCENARIOS) {
      const prompt = compileHomeownerPrompt(
        personaSnapshotOf(s.personaKey),
        scenarioSnapshotOf(s.key),
      );
      expect(prompt).toContain(SCENARIO_CONTENT[s.key]!.hiddenConcern);
      expect(prompt).toContain(s.objection);
    }
  });
});

describe('seeded practice sessions', () => {
  it('has one session for every JOURNEYS.aiSessions entry', () => {
    expect(sessions).toHaveLength(journeySessions.length);
    expect(sessions).toHaveLength(28);
    for (const j of journeySessions) {
      expect(
        sessions.filter((s) => s.person === j.person && s.scenarioKey === j.scenario).length,
      ).toBeGreaterThan(0);
    }
  });

  it('scores each evaluation exactly as listed, with consistent category scores', () => {
    const byPerson = new Map<string, typeof sessions>();
    for (const s of sessions) byPerson.set(s.person, [...(byPerson.get(s.person) ?? []), s]);
    for (const j of JOURNEYS) {
      const mine = byPerson.get(j.person) ?? [];
      expect(mine.map((s) => s.card.overallScore)).toEqual(j.aiSessions.map((x) => x.score));
      expect(mine.map((s) => s.scenarioKey)).toEqual(j.aiSessions.map((x) => x.scenario));
    }
    for (const s of sessions) {
      const weights = s.card.categoryScores.reduce((sum, c) => sum + c.weight, 0);
      expect(
        Math.round(s.card.categoryScores.reduce((sum, c) => sum + c.score * c.weight, 0) / weights),
      ).toBe(s.card.overallScore);
      expect(s.card.categoryScores).toHaveLength(14);
      const passing = SCENARIOS.find((x) => x.key === s.scenarioKey)!.passingScore;
      expect(s.card.passed).toBe(s.card.overallScore >= passing);
      expect(s.maxCategoryShift, `${s.person}/${s.scenarioKey}`).toBeLessThanOrEqual(16);
    }
    // Failing attempts exist (Naomi's first "Talk to My Spouse", Marcus's "My Roof Looks Fine").
    expect(
      sessions.filter((s) => !s.card.passed).map((s) => [s.person, s.card.overallScore]),
    ).toEqual([
      ['naomi', 72],
      ['marcus', 71],
    ]);
  });

  it('has realistic, varied 8-14 turn transcripts that start with the scenario opening line', () => {
    for (const s of sessions) {
      expect(s.messages.length, `${s.person}/${s.scenarioKey}`).toBeGreaterThanOrEqual(8);
      expect(s.messages.length).toBeLessThanOrEqual(14);
      expect(s.messages.map((m) => m.seq)).toEqual(s.messages.map((_, i) => i + 1));
      expect(s.messages[0]).toMatchObject({
        role: 'homeowner',
        content: SCENARIO_CONTENT[s.scenarioKey]!.openingLine,
      });
      expect(s.messages.map((m) => m.role)).toEqual(
        s.messages.map((_, i) => (i % 2 === 0 ? 'homeowner' : 'rep')),
      );
      expect(s.turnCount).toBe(s.messages.filter((m) => m.role === 'rep').length);
      expect(s.messages.every((m) => m.content.length > 3)).toBe(true);
      expect(s.messages.some((m) => m.content.includes('{rep}') || m.content.includes('[['))).toBe(
        false,
      );
      for (let i = 1; i < s.messages.length; i++)
        expect(s.messages[i]!.createdAt.getTime()).toBeGreaterThan(
          s.messages[i - 1]!.createdAt.getTime(),
        );
      expect(s.endedAt.getTime()).toBeGreaterThan(s.messages.at(-1)!.createdAt.getTime());
      expect(s.evaluatedAt.getTime()).toBeGreaterThan(s.endedAt.getTime());
    }
    // Different per scenario.
    const firstRepLines = new Set(
      sessions.filter((s) => s.person === 'destiny').map((s) => s.messages[1]!.content),
    );
    expect(firstRepLines.size).toBe(sessions.filter((s) => s.person === 'destiny').length);
    expect(new Set(TRANSCRIPTS.map((t) => t.scenario)).size).toBe(7);
    // The rep speaks as the learner.
    expect(
      sessions.find((s) => s.person === 'ashlyn' && s.scenarioKey === 'cheaper')!.messages[1]!
        .content,
    ).toContain("I'm Ashlyn");
  });

  it('uses seed time, lesson context and the dev simulator metadata', () => {
    const lessons = allLessons();
    for (const s of sessions) {
      const lesson = lessons.find((l) => l.type === 'ai_simulation' && l.ref === s.scenarioKey);
      if (lesson)
        expect(s).toMatchObject({
          mode: 'assigned',
          context: { programId: PROGRAM.id, lessonId: lesson.id },
        });
      else expect(s).toMatchObject({ mode: 'practice', context: {} });
      expect(s.card.categoryScores.length).toBe(14);
    }
    const daysAgo = (person: string, scenario: string) => {
      const s = sessions.find((x) => x.person === person && x.scenarioKey === scenario)!;
      return Math.round((Date.parse('2026-10-05T15:00:00Z') - s.startedAt.getTime()) / 86_400_000);
    };
    expect(daysAgo('caleb', 'no-time')).toBe(3);
    expect(daysAgo('ashlyn', 'no-time')).toBe(570);
    expect(sessions.find((s) => s.scenarioKey === 'not-signing')!.context).toEqual({});
    expect(sessions.find((s) => s.scenarioKey === 'no-claim')!.context).toMatchObject({
      lessonId: allLessons().find((l) => l.ref === 'no-claim')!.id,
    });
  });

  it('grounds every piece of feedback in what the rep actually said', () => {
    const squash = (t: string) => t.replace(/\s+/g, ' ').toLowerCase();
    for (const s of sessions) {
      const rep = s.messages.filter((m) => m.role === 'rep');
      const quotes = [
        ...s.card.categoryScores.flatMap((c) => c.evidence),
        ...s.card.strengths.flatMap((x) => x.evidence),
        ...s.card.riskyStatements,
        ...s.card.missedOpportunities.flatMap((m) =>
          m.quote ? [{ seq: m.seq!, quote: m.quote }] : [],
        ),
        ...s.card.recommendedResponses.flatMap((r) =>
          r.repSaid ? [{ seq: r.seq!, quote: r.repSaid }] : [],
        ),
      ];
      expect(quotes.length, `${s.person}/${s.scenarioKey}`).toBeGreaterThan(4);
      for (const q of quotes)
        expect(squash(rep.find((m) => m.seq === q.seq)!.content)).toContain(squash(q.quote));
      expect(s.card.strengths.length).toBeGreaterThan(0);
      expect(s.card.missedOpportunities.length).toBeGreaterThan(0);
      expect(s.card.questionsToAsk.length).toBeGreaterThan(0);
      expect(s.card.recommendedResponses.length).toBeGreaterThan(0);
      expect(s.card.summary.length).toBeGreaterThan(40);
      expect(JSON.stringify(s.card)).not.toMatch(/great job|keep it up|well done/i);
      expect(
        scorecardSchema.safeParse({
          ...s.card,
          id: '0190a3b2-0000-7000-8000-000000000001',
          provider: {
            name: 'dev_simulator',
            label: 'Development simulator',
            model: 'm',
            simulated: true,
          },
          promptVersionId: '0190a3b2-0000-7000-8000-000000000002',
          rubricVersionId: '0190a3b2-0000-7000-8000-000000000003',
          evaluatedAt: s.evaluatedAt.toISOString(),
        }).success,
      ).toBe(true);
    }
    // Naomi's failed attempt documents the compliance problem with the quote.
    const failed = sessions.find((s) => s.person === 'naomi' && s.card.overallScore === 72)!;
    expect(failed.card.riskyStatements[0]!.quote).toContain('insurance will pay');
    expect(
      failed.card.categoryScores.find((c) => c.key === 'compliance')!.score,
    ).toBeLessThanOrEqual(40);
  });
});
