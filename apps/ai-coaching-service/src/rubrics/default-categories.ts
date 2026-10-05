import type { RubricCategoryRecord } from '../database/schema.js';

/**
 * The A5 objection-handling rubric: fourteen categories, weights summing to 100. New rubrics
 * start from these; administrators edit them by publishing new rubric versions.
 */
export const DEFAULT_RUBRIC_CATEGORIES: RubricCategoryRecord[] = [
  {
    key: 'discovery',
    label: 'Discovery',
    description:
      "Uncovers the homeowner's real situation, priorities and the concern behind the objection.",
    weight: 10,
    guidance:
      'Strong reps ask at least two open questions before presenting and keep exploring until the hidden concern is spoken. Pitching before discovery, or asking only yes/no questions, scores below 60.',
  },
  {
    key: 'listening',
    label: 'Active listening',
    description:
      'Responds to what the homeowner actually said, paraphrases it and builds on it instead of following a script.',
    weight: 7,
    guidance:
      'Look for paraphrasing ("It sounds like…"), follow-up questions on the homeowner\'s words and answers that change based on what was said.',
  },
  {
    key: 'rapport',
    label: 'Rapport',
    description:
      "Creates a respectful, neighbourly connection: introduction, warmth and respect for the homeowner's time and property.",
    weight: 6,
    guidance:
      'Introduces self and A5, is polite and personable, and never argues. Pressure or sarcasm caps this category at 50.',
  },
  {
    key: 'empathy',
    label: 'Empathy',
    description:
      "Acknowledges and validates the homeowner's feelings and objection before responding.",
    weight: 6,
    guidance:
      'Credit explicit acknowledgment ("That makes sense", "I\'d feel the same") that is followed by genuine interest, not an immediate rebuttal.',
  },
  {
    key: 'communication',
    label: 'Clear communication',
    description:
      'Short, plain-language explanations a homeowner at the door can follow; no jargon dumps or monologues.',
    weight: 6,
    guidance:
      'Messages of one to three sentences that end with a question are ideal. Long monologues and unexplained jargon lose points.',
  },
  {
    key: 'confidence',
    label: 'Confidence',
    description:
      'Calm, professional certainty without arrogance; asks for what they want directly.',
    weight: 5,
    guidance:
      'Hedging ("I guess", "maybe", "sorry to bother you") and apologising for being there reduce the score; directness without pressure raises it.',
  },
  {
    key: 'roofing_knowledge',
    label: 'Roofing knowledge',
    description:
      'Accurately explains roof systems, materials and storm damage (hail bruising, granule loss, lifted or creased shingles, soft metals).',
    weight: 7,
    guidance:
      'Specific, accurate facts tied to this home (age, shingle type, storm) score highly. Inaccurate or exaggerated claims about damage score low.',
  },
  {
    key: 'insurance_knowledge',
    label: 'Insurance knowledge',
    description:
      'Explains the claim process accurately: inspection, documentation, adjuster, deductible, depreciation and timelines.',
    weight: 7,
    guidance:
      'Describe the process, never the outcome. Any promise about what insurance will pay or approve is a compliance failure and scores below 40 here too.',
  },
  {
    key: 'value_presentation',
    label: 'Value presentation',
    description:
      'Shows why A5 is worth choosing: documentation, workmanship warranty, licensing, local reputation, process.',
    weight: 7,
    guidance:
      "Value should be connected to the homeowner's stated concern, not a generic company pitch.",
  },
  {
    key: 'objection_isolation',
    label: 'Objection isolation',
    description:
      'Checks whether the stated objection is the only thing holding the homeowner back before answering it.',
    weight: 7,
    guidance:
      'Credit questions such as "Other than timing, is there anything else that would stop you?" asked before the rep answers the objection.',
  },
  {
    key: 'objection_handling',
    label: 'Objection handling',
    description:
      'Resolves the real concern with relevant specifics, covering the required talking points, without arguing.',
    weight: 10,
    guidance:
      'Full marks need the hidden concern surfaced and answered with specifics. Responding only to the surface objection caps the score around 65.',
  },
  {
    key: 'question_quality',
    label: 'Question quality',
    description: 'Open, purposeful questions that invite real answers, followed up thoughtfully.',
    weight: 6,
    guidance:
      'Most questions should be open (what, how, why). Leading or yes/no questions designed to trap the homeowner score low.',
  },
  {
    key: 'next_step_closing',
    label: 'Next-step closing',
    description:
      'Proposes a clear, specific, low-pressure next step (who, what, when) and secures agreement.',
    weight: 8,
    guidance:
      'A committed next step with a day and time scores 85+. A vague "can I come back sometime?" scores around 55. No ask scores below 35.',
  },
  {
    key: 'compliance',
    label: 'Compliance',
    description:
      'No forbidden claims or pressure: never promises insurance outcomes, free roofs, deductible waivers or premium effects; no high-pressure tactics.',
    weight: 8,
    guidance:
      'Any forbidden claim caps this category at 40. Each pressure tactic costs at least 10 points.',
  },
];

export const DEFAULT_PASSING_SCORE = 75;
