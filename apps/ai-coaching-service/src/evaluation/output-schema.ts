import { z } from 'zod';

const evidence = z.object({
  turn: z.int().describe('Transcript turn number shown in brackets'),
  quote: z.string().describe("Exact words copied from the representative's line"),
});

/**
 * What the evaluator model returns (structured output / forced tool input). The service maps it to
 * the stored scorecard: it validates quotes against the transcript and computes the overall score.
 */
export const evaluationOutputSchema = z.object({
  categoryScores: z
    .array(
      z.object({
        key: z.string().describe('Rubric category key'),
        score: z.int().min(0).max(100),
        rationale: z.string(),
        evidence: z.array(evidence),
      }),
    )
    .describe('One entry per rubric category'),
  strengths: z.array(z.object({ point: z.string(), evidence: z.array(evidence) })),
  missedOpportunities: z.array(
    z.object({
      point: z.string(),
      turn: z.int().nullable(),
      quote: z.string().nullable(),
      betterApproach: z.string(),
    }),
  ),
  questionsToAsk: z.array(z.object({ question: z.string(), why: z.string() })),
  riskyStatements: z.array(z.object({ turn: z.int(), quote: z.string(), issue: z.string(), saferAlternative: z.string() })),
  recommendedResponses: z.array(
    z.object({
      turn: z.int().nullable(),
      repSaid: z.string().nullable(),
      betterResponse: z.string(),
      why: z.string(),
    }),
  ),
  nextGoal: z.string(),
  summary: z.string(),
});

export type EvaluationOutput = z.infer<typeof evaluationOutputSchema>;

export const EVALUATION_SCHEMA_NAME = 'submit_scorecard';
export const EVALUATION_SCHEMA_DESCRIPTION =
  'Submit the scorecard for the representative: rubric category scores with rationale and quoted evidence, strengths, missed opportunities, questions to ask, risky statements, recommended responses, next goal and summary.';
