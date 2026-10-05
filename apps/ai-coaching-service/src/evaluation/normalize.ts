import type {
  CategoryScoreRecord,
  EvidenceRecord,
  RubricCategoryRecord,
} from '../database/schema.js';
import { ProviderError, type ProviderName, type TranscriptLine } from '../providers/types.js';
import type { EvaluationOutput } from './output-schema.js';

export interface NormalizedScorecard {
  overallScore: number;
  passed: boolean;
  passingScore: number;
  categoryScores: CategoryScoreRecord[];
  strengths: Array<{ point: string; evidence: EvidenceRecord[] }>;
  missedOpportunities: Array<{
    point: string;
    seq: number | null;
    quote: string | null;
    betterApproach: string;
  }>;
  questionsToAsk: Array<{ question: string; why: string }>;
  riskyStatements: Array<{ seq: number; quote: string; issue: string; saferAlternative: string }>;
  recommendedResponses: Array<{
    seq: number | null;
    repSaid: string | null;
    betterResponse: string;
    why: string;
  }>;
  nextGoal: string;
  summary: string;
}

const squash = (s: string) =>
  s.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim().toLowerCase();

/** Generic motivation is not feedback. */
const EMPTY_PRAISE =
  /(^|\s)(great job|good job|keep it up|keep up the (good|great) work|well done|you('re| are) doing (great|amazing)|nice work)[!.]*(?=\s|$)/gi;

function clean(text: string): string {
  return text.replace(EMPTY_PRAISE, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Validates a quote against the representative's lines: the cited turn first, then any rep line.
 * Returns null when the words were not actually said.
 */
export function groundQuote(
  transcript: readonly TranscriptLine[],
  turn: number | null,
  quote: string | null,
): EvidenceRecord | null {
  if (!quote) return null;
  const q = squash(quote.replace(/^["'“]+|["'”]+$/g, ''));
  if (q.length < 3) return null;
  const reps = transcript.filter((l) => l.role === 'rep');
  const cited = reps.find((l) => l.seq === turn);
  if (cited && squash(cited.content).includes(q))
    return { seq: cited.seq, quote: quote.trim().replace(/^["“]+|["”]+$/g, '') };
  const any = reps.find((l) => squash(l.content).includes(q));
  return any ? { seq: any.seq, quote: quote.trim().replace(/^["“]+|["”]+$/g, '') } : null;
}

export function weightedScore(
  categoryScores: readonly { score: number; weight: number }[],
): number {
  const total = categoryScores.reduce((s, c) => s + c.weight, 0);
  if (total <= 0) return 0;
  return Math.round(categoryScores.reduce((s, c) => s + c.score * c.weight, 0) / total);
}

/**
 * Turn raw evaluator output into a stored scorecard: one score per rubric category (missing
 * categories are an invalid output and retried), quotes verified against the transcript,
 * overall score computed from the rubric weights.
 */
export function normalizeEvaluation(
  provider: ProviderName,
  output: EvaluationOutput,
  categories: readonly RubricCategoryRecord[],
  transcript: readonly TranscriptLine[],
  passingScore: number,
): NormalizedScorecard {
  const byKey = new Map(output.categoryScores.map((c) => [c.key.trim().toLowerCase(), c]));
  const missing = categories.filter((c) => !byKey.has(c.key));
  if (missing.length) {
    throw new ProviderError(
      provider,
      'invalid_output',
      `The evaluator did not score: ${missing.map((c) => c.key).join(', ')}.`,
    );
  }
  const ground = (list: readonly { turn: number; quote: string }[]) =>
    list
      .map((e) => groundQuote(transcript, e.turn, e.quote))
      .filter((e): e is EvidenceRecord => e !== null);

  const categoryScores: CategoryScoreRecord[] = categories.map((c) => {
    const raw = byKey.get(c.key)!;
    return {
      key: c.key,
      label: c.label,
      weight: c.weight,
      score: Math.max(0, Math.min(100, Math.round(raw.score))),
      rationale: clean(raw.rationale),
      evidence: ground(raw.evidence).slice(0, 3),
    };
  });
  const overallScore = weightedScore(categoryScores);

  return {
    overallScore,
    passed: overallScore >= passingScore,
    passingScore,
    categoryScores,
    strengths: output.strengths
      .map((s) => ({ point: clean(s.point), evidence: ground(s.evidence) }))
      .filter((s) => s.point && s.evidence.length > 0),
    missedOpportunities: output.missedOpportunities.map((m) => {
      const e = groundQuote(transcript, m.turn, m.quote);
      return {
        point: clean(m.point),
        seq: e?.seq ?? null,
        quote: e?.quote ?? null,
        betterApproach: clean(m.betterApproach),
      };
    }),
    questionsToAsk: output.questionsToAsk.map((q) => ({
      question: q.question.trim(),
      why: clean(q.why),
    })),
    riskyStatements: output.riskyStatements.flatMap((r) => {
      const e = groundQuote(transcript, r.turn, r.quote);
      return e
        ? [
            {
              seq: e.seq,
              quote: e.quote,
              issue: clean(r.issue),
              saferAlternative: clean(r.saferAlternative),
            },
          ]
        : [];
    }),
    recommendedResponses: output.recommendedResponses.map((r) => {
      const e = groundQuote(transcript, r.turn, r.repSaid);
      return {
        seq: e?.seq ?? null,
        repSaid: e?.quote ?? null,
        betterResponse: r.betterResponse.trim(),
        why: clean(r.why),
      };
    }),
    nextGoal: clean(output.nextGoal),
    summary: clean(output.summary),
  };
}
