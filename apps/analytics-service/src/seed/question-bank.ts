import { ASSESSMENTS, seedId } from '@a5/seed-data';

/**
 * Question stems and categories behind the seeded assessments, used to derive per-question
 * results whose correctness adds up to each seeded score. Ids follow the shared seed convention
 * (`question:<assessment>:<n>`, `question-category:<slug>`).
 */
export const QUESTION_CATEGORIES = {
  company: { slug: 'company-culture', name: 'Company & culture', difficulty: 0.2 },
  journey: { slug: 'customer-journey', name: 'Customer journey', difficulty: 0.3 },
  roof: { slug: 'roof-systems', name: 'Roof systems', difficulty: 0.4 },
  storm: { slug: 'storm-damage', name: 'Storm damage', difficulty: 0.5 },
  claims: { slug: 'insurance-claims', name: 'Insurance claims', difficulty: 0.65 },
  discovery: { slug: 'discovery-rapport', name: 'Discovery & rapport', difficulty: 0.35 },
  objections: { slug: 'objection-handling', name: 'Objection handling', difficulty: 0.55 },
  compliance: { slug: 'compliance', name: 'Compliance', difficulty: 0.7 },
} as const;

type CategoryKey = keyof typeof QUESTION_CATEGORIES;

const STEMS: Record<string, Array<[CategoryKey, string]>> = {
  'quiz-w1': [
    ['company', 'What is the first commitment A5 makes to every homeowner?'],
    ['company', 'Which behaviour does the Sales Code of Conduct prohibit at the door?'],
    [
      'company',
      'Who should you contact when a homeowner asks a warranty question you cannot answer?',
    ],
    [
      'journey',
      'Put the A5 customer journey stages in order, from first knock to final walkthrough.',
    ],
    ['journey', 'At which stage does the production team take over from the sales representative?'],
    [
      'journey',
      'What must be completed before an inspection photo report is shared with the homeowner?',
    ],
    ['journey', 'What is the purpose of the final walkthrough?'],
    ['company', 'How quickly should you follow up after a homeowner requests a call back?'],
  ],
  'quiz-w2': [
    ['roof', 'What is the primary job of roof underlayment?'],
    ['roof', 'Which ventilation problem most often shortens shingle life in North Texas attics?'],
    ['roof', 'What does a drip edge protect?'],
    [
      'storm',
      'Which pattern on a shingle most strongly indicates hail impact rather than blistering?',
    ],
    ['storm', 'Which soft metals should you check first to confirm a hail event?'],
    ['storm', 'How do you document wind damage so an adjuster can verify it?'],
    ['claims', 'Who files the insurance claim: the homeowner or A5?'],
    ['claims', 'What is the deductible, and who is responsible for paying it?'],
    ['claims', 'What is recoverable depreciation?'],
    ['claims', 'When should you meet the adjuster on site?'],
  ],
  'quiz-w3': [
    ['discovery', 'What is the goal of the first 30 seconds at the door?'],
    ['discovery', "Which question best uncovers a homeowner's real concern?"],
    ['discovery', 'How should you respond when a homeowner says they only have a minute?'],
    ['discovery', 'Why do you summarise what the homeowner told you before presenting?'],
    ['objections', 'What are the four steps of the A5 objection framework?'],
    [
      'objections',
      'A homeowner says they need to talk to their spouse. What is the best next step?',
    ],
    ['objections', 'How do you respond when a homeowner wants three estimates?'],
    ['objections', 'Why should you never argue with a price objection?'],
    ['objections', 'What should every objection conversation end with?'],
    ['objections', "Which response to 'Another roofer is cheaper' follows the A5 framework?"],
  ],
  final: [
    ['compliance', 'Which statement about insurance coverage may a representative never make?'],
    ['compliance', "Can a representative offer to waive or cover a homeowner's deductible?"],
    ['compliance', 'What must be disclosed before a homeowner signs a contingency agreement?'],
    [
      'compliance',
      'How long does a Texas homeowner have to cancel a contract signed at their door?',
    ],
    [
      'compliance',
      'What do you do if a homeowner asks you to describe old damage as storm damage?',
    ],
    ['claims', "Which document explains the adjuster's approved scope and price?"],
    ['claims', 'What is a supplement, and when is it requested?'],
    ['storm', 'Which evidence best supports a wind claim for lifted shingles?'],
    ['roof', 'What attic ventilation ratio does A5 install to?'],
    ['roof', 'Why does A5 replace pipe boots on every re-roof?'],
    ['journey', 'What happens after the homeowner signs the agreement?'],
    ['journey', 'Who schedules the production start date with the homeowner?'],
    ['discovery', 'Which question identifies every decision maker early?'],
    ['discovery', 'What should you confirm before leaving a first appointment?'],
    [
      'objections',
      'A homeowner says their insurance company already inspected the roof. What is your best response?',
    ],
    ['objections', "How do you handle 'I'm not signing anything today'?"],
    ['objections', 'A homeowner says they already have a roofer. What should you ask?'],
    ['objections', "Which response best addresses 'My roof looks fine'?"],
    ['company', 'What does the A5 workmanship warranty cover?'],
    ['compliance', 'Which job photos may you post on social media?'],
  ],
};

export interface SeedQuestion {
  id: string;
  versionId: string;
  assessmentKey: string;
  number: number;
  prompt: string;
  categoryId: string;
  categoryName: string;
  difficulty: number;
}

function unit(text: string): number {
  // Stable pseudo-random number in [0, 1) derived from text.
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return ((h >>> 0) % 10_000) / 10_000;
}

export const seedUnit = unit;

export const QUESTIONS: Record<string, SeedQuestion[]> = Object.fromEntries(
  ASSESSMENTS.map((a) => {
    const stems = STEMS[a.key] ?? [];
    if (stems.length !== a.questionCount)
      throw new Error(
        `Seed question bank for ${a.key} has ${stems.length} questions, expected ${a.questionCount}`,
      );
    return [
      a.key,
      stems.map(([category, prompt], i) => {
        const c = QUESTION_CATEGORIES[category];
        return {
          id: seedId(`question:${a.key}:${i + 1}`),
          versionId: seedId(`question-version:${a.key}:${i + 1}:1`),
          assessmentKey: a.key,
          number: i + 1,
          prompt,
          categoryId: seedId(`question-category:${c.slug}`),
          categoryName: c.name,
          difficulty: c.difficulty + unit(`${a.key}:${i}`) * 0.3,
        };
      }),
    ];
  }),
);

/**
 * Per-question results for a score. Every question is worth one point; the awarded points add up
 * to exactly `scorePercent` (one multi-select question may earn partial credit). Harder questions
 * are missed first, with per-attempt variation.
 */
export function questionResults(assessmentKey: string, scorePercent: number, attemptSalt: string) {
  const questions = QUESTIONS[assessmentKey] ?? [];
  const n = questions.length;
  const total = Math.round(scorePercent * n) / 100;
  const full = Math.floor(total + 1e-9);
  const partial = Math.round((total - full) * 100) / 100;
  const ranked = [...questions].sort(
    (a, b) =>
      b.difficulty * 0.6 +
      unit(`${attemptSalt}:${b.number}`) * 0.8 -
      (a.difficulty * 0.6 + unit(`${attemptSalt}:${a.number}`) * 0.8),
  );
  const missed = n - full - (partial > 0 ? 1 : 0);
  const awarded = new Map<string, number>();
  ranked.forEach((q, i) => {
    if (i < missed) awarded.set(q.id, 0);
    else if (i === missed && partial > 0) awarded.set(q.id, partial);
    else awarded.set(q.id, 1);
  });
  return questions.map((q) => ({
    questionId: q.id,
    questionVersionId: q.versionId,
    categoryId: q.categoryId,
    categoryName: q.categoryName,
    prompt: q.prompt,
    correct: awarded.get(q.id) === 1,
    awardedPoints: awarded.get(q.id) ?? 0,
    possiblePoints: 1,
  }));
}
