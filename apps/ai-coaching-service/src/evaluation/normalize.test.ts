import { describe, expect, it } from 'vitest';
import { DEFAULT_RUBRIC_CATEGORIES } from '../rubrics/default-categories.js';
import type { TranscriptLine } from '../providers/types.js';
import { groundQuote, normalizeEvaluation, weightedScore } from './normalize.js';
import type { EvaluationOutput } from './output-schema.js';

const transcript: TranscriptLine[] = [
  { seq: 1, role: 'homeowner', content: "I don't have time." },
  {
    seq: 2,
    role: 'rep',
    content:
      "Hi, I'm Pat with A5 Roofing.  What have you noticed on the roof since the “April” storm?",
  },
  { seq: 3, role: 'homeowner', content: 'A stain in the closet.' },
  { seq: 4, role: 'rep', content: "Insurance will pay for the whole roof, don't worry." },
];

function output(over: Partial<EvaluationOutput> = {}): EvaluationOutput {
  return {
    categoryScores: DEFAULT_RUBRIC_CATEGORIES.map((c) => ({
      key: c.key,
      score: 80,
      rationale: 'Great job! Asked a good question.',
      evidence: [{ turn: 2, quote: 'What have you noticed on the roof' }],
    })),
    strengths: [
      { point: 'Opened with a question.', evidence: [{ turn: 2, quote: 'what have you noticed' }] },
    ],
    missedOpportunities: [
      {
        point: 'No isolation.',
        turn: 2,
        quote: "Hi, I'm Pat with A5 Roofing.",
        betterApproach: 'Ask whether time is the only issue.',
      },
    ],
    questionsToAsk: [
      { question: 'What worries you most?', why: 'It surfaces the hidden concern.' },
    ],
    riskyStatements: [
      {
        turn: 4,
        quote: 'Insurance will pay for the whole roof',
        issue: 'Promise.',
        saferAlternative: 'Describe the process.',
      },
    ],
    recommendedResponses: [
      {
        turn: 4,
        repSaid: 'Insurance will pay',
        betterResponse: 'I cannot say what insurance will do.',
        why: 'Accurate.',
      },
    ],
    nextGoal: 'Ask two open questions.',
    summary: 'The rep asked one open question and then promised an insurance outcome.',
    ...over,
  };
}

describe('quote grounding', () => {
  it('accepts quotes that were really said, ignoring case, quotes and spacing', () => {
    expect(
      groundQuote(transcript, 2, 'WHAT have you noticed on the roof since the "April" storm?'),
    ).toEqual({ seq: 2, quote: 'WHAT have you noticed on the roof since the "April" storm?' });
    expect(groundQuote(transcript, 4, '"insurance will pay"')?.seq).toBe(4);
  });

  it('moves a quote to the turn that actually contains it, and drops invented ones', () => {
    expect(groundQuote(transcript, 2, 'Insurance will pay for the whole roof')?.seq).toBe(4);
    expect(groundQuote(transcript, 2, 'We offer a lifetime warranty')).toBeNull();
    expect(groundQuote(transcript, 1, "I don't have time")).toBeNull(); // homeowner lines are not rep evidence
    expect(groundQuote(transcript, 2, null)).toBeNull();
    expect(groundQuote(transcript, 2, 'ab')).toBeNull();
  });
});

describe('scorecard normalisation', () => {
  it('computes the overall score from rubric weights, not from the model', () => {
    const card = normalizeEvaluation(
      'anthropic',
      output({
        categoryScores: output().categoryScores.map((c) => ({
          ...c,
          score: c.key === 'compliance' ? 20 : 90,
        })),
      }),
      DEFAULT_RUBRIC_CATEGORIES,
      transcript,
      75,
    );
    // 92 weighted points at 90 plus compliance (8) at 20.
    expect(card.overallScore).toBe(Math.round((92 * 90 + 8 * 20) / 100));
    expect(card.overallScore).toBe(84);
    expect(card.passed).toBe(true);
    expect(
      normalizeEvaluation('anthropic', output(), DEFAULT_RUBRIC_CATEGORIES, transcript, 90).passed,
    ).toBe(false);
    expect(
      weightedScore([
        { score: 100, weight: 1 },
        { score: 0, weight: 3 },
      ]),
    ).toBe(25);
    expect(weightedScore([])).toBe(0);
  });

  it('clamps scores, keeps rubric order and labels, and only keeps verified evidence', () => {
    const shuffled = output()
      .categoryScores.reverse()
      .map((c, i) => ({ ...c, score: i === 0 ? 140 : c.score }));
    const card = normalizeEvaluation(
      'anthropic',
      output({ categoryScores: shuffled }),
      DEFAULT_RUBRIC_CATEGORIES,
      transcript,
      75,
    );
    expect(card.categoryScores.map((c) => c.key)).toEqual(
      DEFAULT_RUBRIC_CATEGORIES.map((c) => c.key),
    );
    expect(card.categoryScores.every((c) => c.score >= 0 && c.score <= 100)).toBe(true);
    expect(card.categoryScores[0]).toMatchObject({ label: 'Discovery', weight: 10 });
    const bogus = normalizeEvaluation(
      'anthropic',
      output({
        strengths: [
          {
            point: 'Invented praise.',
            evidence: [{ turn: 2, quote: 'We guarantee the lowest price' }],
          },
        ],
        riskyStatements: [
          { turn: 4, quote: 'Made-up statement', issue: 'x', saferAlternative: 'y' },
        ],
        missedOpportunities: [
          { point: 'Missed it.', turn: 2, quote: 'Not a real quote', betterApproach: 'Better.' },
        ],
      }),
      DEFAULT_RUBRIC_CATEGORIES,
      transcript,
      75,
    );
    expect(bogus.strengths).toEqual([]); // ungrounded praise is dropped
    expect(bogus.riskyStatements).toEqual([]);
    expect(bogus.missedOpportunities[0]).toMatchObject({ seq: null, quote: null });
  });

  it('removes empty praise from rationales', () => {
    const card = normalizeEvaluation(
      'anthropic',
      output(),
      DEFAULT_RUBRIC_CATEGORIES,
      transcript,
      75,
    );
    expect(card.categoryScores[0]!.rationale).toBe('Asked a good question.');
  });

  it('rejects a scorecard that skips rubric categories so the job is retried', () => {
    const partial = output({ categoryScores: output().categoryScores.slice(0, 10) });
    expect(() =>
      normalizeEvaluation('anthropic', partial, DEFAULT_RUBRIC_CATEGORIES, transcript, 75),
    ).toThrow(/did not score: .*compliance/);
    try {
      normalizeEvaluation('anthropic', partial, DEFAULT_RUBRIC_CATEGORIES, transcript, 75);
    } catch (err) {
      expect(err).toMatchObject({ kind: 'invalid_output', retryable: true });
    }
  });
});
