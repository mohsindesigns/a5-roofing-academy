import type { RubricCategoryRecord } from '../../database/schema.js';
import type { EvaluationOutput } from '../../evaluation/output-schema.js';
import type { PersonaSnapshot, ScenarioSnapshot, TranscriptLine } from '../types.js';
import {
  INSURANCE_TERMS,
  forbiddenClaimSentences,
  PATTERNS,
  ROOFING_TERMS,
  VALUE_TERMS,
  isDiscoveryQuestion,
  isNegated,
  isOpenQuestion,
  normalize,
  overlap,
  quoteOf,
  sentences,
  termsIn,
  wordCount,
} from './text.js';

export interface HeuristicEvaluationInput {
  persona: PersonaSnapshot;
  scenario: ScenarioSnapshot;
  categories: readonly RubricCategoryRecord[];
  transcript: readonly TranscriptLine[];
  endReason: string | null;
}

interface Evidence {
  seq: number;
  quote: string;
}

interface Coverage {
  text: string;
  evidence: Evidence | null;
}

interface Risk extends Evidence {
  issue: string;
  saferAlternative: string;
}

export interface TranscriptAnalysis {
  input: HeuristicEvaluationInput;
  reps: TranscriptLine[];
  homeowners: TranscriptLine[];
  questions: Evidence[];
  openQuestions: Evidence[];
  discoveryQuestions: Evidence[];
  empathy: Evidence[];
  listening: Evidence[];
  isolation: Evidence[];
  rapport: Evidence[];
  hedges: Evidence[];
  nextStepAsks: Evidence[];
  specificNextSteps: Evidence[];
  risks: Risk[];
  pressureCount: number;
  forbiddenCount: number;
  roofingTerms: Map<string, Evidence>;
  insuranceTerms: Map<string, Evidence>;
  valueTerms: Map<string, Evidence>;
  talkingPoints: Coverage[];
  behaviors: Coverage[];
  concernRevealedSeq: number | null;
  concernAddressed: Evidence | null;
  /** Rep line that answered the first objection. */
  firstResponse: TranscriptLine | null;
  longMessages: TranscriptLine[];
  avgWords: number;
  insuranceScenario: boolean;
  objectiveReached: boolean;
}

function ev(line: TranscriptLine, sentence: string): Evidence {
  return { seq: line.seq, quote: quoteOf(sentence) };
}

function collect(reps: readonly TranscriptLine[], test: (sentence: string) => boolean): Evidence[] {
  const out: Evidence[] = [];
  for (const line of reps) {
    for (const s of sentences(line.content)) if (test(s)) out.push(ev(line, s));
  }
  return out;
}

function termMap(reps: readonly TranscriptLine[], terms: readonly string[]): Map<string, Evidence> {
  const map = new Map<string, Evidence>();
  for (const line of reps) {
    for (const s of sentences(line.content)) {
      for (const t of termsIn(s, terms)) if (!map.has(t)) map.set(t, ev(line, s));
    }
  }
  return map;
}

/**
 * The rep sentence that best covers a reference point. A point can be spread over several sentences
 * of one message, so a message that covers it overall counts, quoting its most relevant sentence.
 */
function bestSentence(
  reps: readonly TranscriptLine[],
  reference: string,
  minRatio: number,
  minHits: number,
): Evidence | null {
  let best: { e: Evidence; ratio: number } | null = null;
  for (const line of reps) {
    const whole = overlap(line.content, reference);
    const needed = Math.max(1, Math.min(minHits, whole.total));
    if (whole.hits < needed || whole.ratio < minRatio) continue;
    let top: { sentence: string; hits: number } | null = null;
    for (const s of sentences(line.content)) {
      const { hits } = overlap(s, reference);
      if (hits > 0 && (!top || hits > top.hits)) top = { sentence: s, hits };
    }
    if (top && (!best || whole.ratio > best.ratio))
      best = { e: ev(line, top.sentence), ratio: whole.ratio };
  }
  return best?.e ?? null;
}

const SAFER = {
  insurance:
    "I can't tell you what your insurance company will decide. What I can do is document the damage so your adjuster sees the full picture.",
  cost: 'Your out-of-pocket cost on an approved claim is your deductible. I can walk you through exactly how that works before you decide anything.',
  deductible:
    'By law your deductible is yours to pay, and we will never offer to cover or waive it. I can show you how the claim payment works so there are no surprises.',
  premium:
    "I can't speak to your premium; your agent can. I'd ask them how a weather claim is treated on your policy.",
  pressure:
    'Take the time you need. Would it help if I left the inspection photos with you so you can look them over together?',
  generic:
    'Stick to what you can verify today: what you saw, what the inspection would show and what the next step would be.',
};

function saferFor(sentence: string): string {
  const s = normalize(sentence);
  if (/deductible/.test(s)) return SAFER.deductible;
  if (/premium|rates/.test(s)) return SAFER.premium;
  if (/free|cost|penny|dime|pocket/.test(s)) return SAFER.cost;
  if (/insurance|claim|approv/.test(s)) return SAFER.insurance;
  return SAFER.generic;
}

function behaviorEvidence(
  behavior: string,
  a: Omit<TranscriptAnalysis, 'behaviors'>,
): Evidence | null {
  const b = normalize(behavior);
  const special: Array<[RegExp, Evidence | undefined]> = [
    [/acknowledg|empath|validat|respect/, a.empathy[0]],
    [/listen|paraphras|summari|repeat back|reflect/, a.listening[0]],
    [/isolat/, a.isolation[0]],
    [
      /next step|schedul|appointment|commit|close|book/,
      a.specificNextSteps[0] ?? a.nextStepAsks[0],
    ],
    [/question|ask|discover|uncover|curious|explore/, a.discoveryQuestions[0]],
    [/introduc|name|rapport|friendly/, a.rapport[0]],
  ];
  for (const [re, evidence] of special) if (re.test(b) && evidence) return evidence;
  return bestSentence(a.reps, behavior, 0.4, 2);
}

export function analyzeTranscript(input: HeuristicEvaluationInput): TranscriptAnalysis {
  const { scenario, transcript } = input;
  const reps = transcript.filter((m) => m.role === 'rep');
  const homeowners = transcript.filter((m) => m.role === 'homeowner');
  const allQuestions = collect(reps, (s) => s.includes('?'));
  const openQuestions = allQuestions.filter((q) => isOpenQuestion(q.quote));
  const discoveryQuestions = allQuestions.filter(
    (q) => isDiscoveryQuestion(q.quote) || PATTERNS.isolation.test(normalize(q.quote)),
  );
  const test = (re: RegExp) => (s: string) => re.test(normalize(s));

  const risks: Risk[] = [];
  let pressureCount = 0;
  let forbiddenCount = 0;
  for (const line of reps) {
    for (const s of sentences(line.content)) {
      const norm = normalize(s);
      if (forbiddenClaimSentences(s).length) {
        forbiddenCount++;
        const claim =
          scenario.forbiddenClaims.find((c) => overlap(s, c).ratio >= 0.3) ??
          'A promise about the outcome or cost that A5 cannot make';
        risks.push({
          ...ev(line, s),
          issue: `Compliance: ${claim.replace(/\.$/, '')}.`,
          saferAlternative: saferFor(s),
        });
        continue;
      }
      const scenarioClaim = scenario.forbiddenClaims.find((c) => {
        const o = overlap(s, c);
        return o.total >= 3 && o.hits >= 3 && o.ratio >= 0.6 && !PATTERNS.negation.test(norm);
      });
      if (scenarioClaim) {
        forbiddenCount++;
        risks.push({
          ...ev(line, s),
          issue: `Compliance: ${scenarioClaim.replace(/\.$/, '')}.`,
          saferAlternative: saferFor(s),
        });
        continue;
      }
      if (PATTERNS.pressure.test(norm) && !isNegated(s, PATTERNS.pressure)) {
        pressureCount++;
        risks.push({
          ...ev(line, s),
          issue: 'Pressure: pushes for a decision the homeowner has not reached and erodes trust.',
          saferAlternative: SAFER.pressure,
        });
      }
    }
  }

  const nextStepAsks = collect(reps, (s) => {
    const n = normalize(s);
    const proposal =
      PATTERNS.nextStep.test(n) &&
      (s.includes('?') || /\b(let me|i can|i could|we can|how about|why don't)\b/.test(n));
    const timeAsk =
      PATTERNS.specificTime.test(n) &&
      s.includes('?') &&
      /\b(work|works|suit|suits|available|good for you)\b/.test(n);
    return proposal || timeAsk;
  });
  const revealLine = homeowners.find((h) => {
    const o = overlap(h.content, scenario.hiddenConcern);
    return o.ratio >= 0.3 || o.hits >= 6;
  });
  const concernRevealedSeq = revealLine?.seq ?? null;
  const after = concernRevealedSeq === null ? [] : reps.filter((r) => r.seq > concernRevealedSeq);
  let concernAddressed: Evidence | null = null;
  for (const line of after) {
    for (const s of sentences(line.content)) {
      if (overlap(s, scenario.hiddenConcern).hits >= 2 || PATTERNS.empathy.test(normalize(s))) {
        concernAddressed = ev(line, s);
        break;
      }
    }
    if (concernAddressed) break;
  }
  const objectionLine =
    homeowners.find((h) => overlap(h.content, scenario.objection).ratio >= 0.5) ??
    homeowners[0] ??
    null;
  const firstResponse = objectionLine
    ? (reps.find((r) => r.seq > objectionLine.seq) ?? null)
    : (reps[0] ?? null);
  const words = reps.map((r) => wordCount(r.content));

  const base = {
    input,
    reps,
    homeowners,
    questions: allQuestions,
    openQuestions,
    discoveryQuestions,
    empathy: collect(reps, test(PATTERNS.empathy)),
    listening: collect(reps, test(PATTERNS.listening)),
    isolation: collect(reps, test(PATTERNS.isolation)),
    rapport: collect(reps, test(PATTERNS.rapport)),
    hedges: collect(reps, test(PATTERNS.hedges)),
    nextStepAsks,
    specificNextSteps: nextStepAsks.filter((e) => PATTERNS.specificTime.test(normalize(e.quote))),
    risks,
    pressureCount,
    forbiddenCount,
    roofingTerms: termMap(reps, ROOFING_TERMS),
    insuranceTerms: termMap(reps, INSURANCE_TERMS),
    valueTerms: termMap(reps, VALUE_TERMS),
    talkingPoints: scenario.requiredTalkingPoints.map((text) => ({
      text,
      evidence: bestSentence(reps, text, 0.34, 2),
    })),
    concernRevealedSeq,
    concernAddressed,
    firstResponse,
    longMessages: reps.filter((r) => wordCount(r.content) > 75),
    avgWords: words.length ? words.reduce((x, y) => x + y, 0) / words.length : 0,
    insuranceScenario: /insur|claim|adjuster|deductible/.test(
      normalize(`${scenario.category} ${scenario.objection}`),
    ),
    objectiveReached: input.endReason === 'objective_reached',
  };
  return {
    ...base,
    behaviors: scenario.expectedBehaviors.map((text) => ({
      text,
      evidence: behaviorEvidence(text, base),
    })),
  };
}

interface CategoryResult {
  score: number;
  rationale: string;
  evidence: Evidence[];
}

const clamp = (n: number, lo = 5, hi = 98) => Math.max(lo, Math.min(hi, Math.round(n)));
const first = <T>(...lists: Array<readonly T[]>): T[] =>
  lists.flatMap((l) => l.slice(0, 1)).slice(0, 2);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

function coverageRatio(list: readonly Coverage[]): number {
  return list.length ? list.filter((c) => c.evidence).length / list.length : 0.5;
}

function scoreCategory(key: string, a: TranscriptAnalysis): CategoryResult {
  const pressure = a.pressureCount + a.forbiddenCount;
  const revealed = a.concernRevealedSeq !== null;
  const talking = coverageRatio(a.talkingPoints);
  switch (key) {
    case 'discovery': {
      const n = a.discoveryQuestions.length;
      const late = n > 0 && a.discoveryQuestions[0]!.seq > (a.firstResponse?.seq ?? 0) + 4;
      return {
        score: clamp(38 + 14 * Math.min(n, 3) + (revealed ? 14 : 0) - (late ? 6 : 0)),
        rationale: n
          ? `Asked ${plural(n, 'discovery question')}${late ? ', but only later in the conversation' : ''}; the homeowner's real concern ${revealed ? `surfaced at turn ${a.concernRevealedSeq}` : 'never surfaced'}.`
          : "Asked no open discovery questions, so the homeowner's real concern never surfaced.",
        evidence: a.discoveryQuestions.slice(0, 2),
      };
    }
    case 'listening': {
      const n = a.listening.length;
      return {
        score: clamp(
          46 +
            11 * Math.min(n, 3) +
            (a.concernAddressed ? 16 : 0) -
            (a.longMessages.length ? 6 : 0),
        ),
        rationale: a.concernAddressed
          ? `Picked up on what the homeowner said and responded to it directly${n ? `, reflecting it back ${plural(n, 'time')}` : ''}.`
          : n
            ? `Reflected the homeowner's words ${plural(n, 'time')}, but did not respond to the concern once it came up.`
            : 'Responses did not reflect back or build on what the homeowner said.',
        evidence: first(a.listening, a.concernAddressed ? [a.concernAddressed] : []),
      };
    }
    case 'rapport': {
      const n = a.rapport.length;
      return {
        score: clamp(52 + 10 * Math.min(n, 3) + (a.empathy.length ? 6 : 0) - 12 * pressure),
        rationale: n
          ? `Built rapport with ${plural(n, 'personal touch')} (introductions, thanks, neighbourly remarks)${pressure ? ', undercut by pressure later on' : ''}.`
          : 'Went straight to business without building any personal connection.',
        evidence: a.rapport.slice(0, 2),
      };
    }
    case 'empathy': {
      const n = a.empathy.length;
      return {
        score: clamp(40 + 15 * Math.min(n, 3) + (a.concernAddressed ? 8 : 0) - 12 * pressure),
        rationale: n
          ? `Acknowledged the homeowner's position ${plural(n, 'time')} before responding.`
          : 'Did not acknowledge or validate the objection before responding to it.',
        evidence: a.empathy.slice(0, 2),
      };
    }
    case 'communication': {
      const ideal = a.avgWords >= 8 && a.avgWords <= 50;
      return {
        score: clamp(
          68 +
            (ideal ? 12 : 0) -
            10 * a.longMessages.length -
            (a.hedges.length > 2 ? 6 : 0) +
            (a.questions.length ? 6 : 0),
        ),
        rationale: a.longMessages.length
          ? `Average message of ${Math.round(a.avgWords)} words with ${plural(a.longMessages.length, 'long monologue')} that a homeowner at the door is unlikely to follow.`
          : `Kept messages short and clear (about ${Math.round(a.avgWords)} words on average).`,
        evidence: a.longMessages.length
          ? [
              {
                seq: a.longMessages[0]!.seq,
                quote: quoteOf(sentences(a.longMessages[0]!.content)[0]!),
              },
            ]
          : [],
      };
    }
    case 'confidence': {
      return {
        score: clamp(
          66 -
            7 * a.hedges.length +
            (a.nextStepAsks.length ? 10 : 0) +
            (a.isolation.length ? 6 : 0) +
            (a.specificNextSteps.length ? 6 : 0) -
            (pressure ? 8 : 0),
        ),
        rationale: a.hedges.length
          ? `Hedged ${plural(a.hedges.length, 'time')}, which weakened otherwise reasonable points.`
          : `Spoke with steady confidence${a.nextStepAsks.length ? ' and asked for a next step directly' : ''}.`,
        evidence: a.hedges.length ? a.hedges.slice(0, 2) : a.nextStepAsks.slice(0, 1),
      };
    }
    case 'roofing_knowledge': {
      const n = a.roofingTerms.size;
      return {
        score: clamp(56 + 9 * Math.min(n, 4)),
        rationale: n
          ? `Used accurate roofing language (${[...a.roofingTerms.keys()].slice(0, 4).join(', ')}).`
          : 'Did not explain anything about the roof itself or what storm damage looks like.',
        evidence: [...a.roofingTerms.values()].slice(0, 2),
      };
    }
    case 'insurance_knowledge': {
      const n = a.insuranceTerms.size;
      const base = a.insuranceScenario ? 40 + 10 * Math.min(n, 5) : 74 + 5 * Math.min(n, 4);
      return {
        score: clamp(a.forbiddenCount ? Math.min(base - 25 * a.forbiddenCount, 39) : base),
        rationale: a.forbiddenCount
          ? 'Made promises about the insurance outcome that A5 cannot make.'
          : n
            ? `Explained the claim process accurately (${[...a.insuranceTerms.keys()].slice(0, 4).join(', ')}).`
            : a.insuranceScenario
              ? 'Did not explain how the claim process actually works, which this homeowner needed.'
              : 'Insurance did not come up; no inaccurate statements were made.',
        evidence: a.forbiddenCount
          ? a.risks.slice(0, 1)
          : [...a.insuranceTerms.values()].slice(0, 2),
      };
    }
    case 'value_presentation': {
      const n = a.valueTerms.size;
      return {
        score: clamp(44 + 9 * Math.min(n, 5) + 16 * talking),
        rationale: n
          ? `Presented A5's value (${[...a.valueTerms.keys()].slice(0, 4).join(', ')}).`
          : 'Did not give the homeowner a reason to choose A5 over doing nothing.',
        evidence: [...a.valueTerms.values()].slice(0, 2),
      };
    }
    case 'objection_isolation': {
      const n = a.isolation.length;
      return {
        score: clamp(42 + 26 * Math.min(n, 2) + (revealed ? 12 : 0)),
        rationale: n
          ? 'Checked whether the stated objection was the only thing holding the homeowner back.'
          : 'Never isolated the objection, so it stayed unclear whether it was the real issue.',
        evidence: a.isolation.slice(0, 2),
      };
    }
    case 'objection_handling': {
      return {
        score: clamp(
          42 +
            28 * talking +
            (a.concernAddressed ? 16 : 0) +
            (a.empathy.length ? 6 : 0) -
            12 * pressure,
        ),
        rationale: `${a.concernAddressed ? 'Addressed the real concern once it surfaced' : 'Responded to the surface objection only'} and covered ${a.talkingPoints.filter((t) => t.evidence).length} of ${a.talkingPoints.length} required talking points.`,
        evidence: first(
          a.concernAddressed ? [a.concernAddressed] : [],
          a.talkingPoints.flatMap((t) => (t.evidence ? [t.evidence] : [])),
        ),
      };
    }
    case 'question_quality': {
      const total = a.questions.length;
      if (!total) return { score: 28, rationale: 'Asked no questions at all.', evidence: [] };
      const openShare = a.openQuestions.length / total;
      return {
        score: clamp(44 + 36 * openShare + 6 * Math.min(a.discoveryQuestions.length, 3)),
        rationale: `${a.openQuestions.length} of ${total} questions were open-ended.`,
        evidence: a.openQuestions.slice(0, 2),
      };
    }
    case 'next_step_closing': {
      const specific = a.specificNextSteps.length > 0;
      let score = a.objectiveReached
        ? 86 + (specific ? 8 : 0)
        : specific
          ? 66
          : a.nextStepAsks.length
            ? 54
            : 28;
      if (a.input.endReason === 'homeowner_ended') score -= 12;
      return {
        score: clamp(score),
        rationale: a.objectiveReached
          ? `Secured a committed next step${specific ? ' with a specific day and time' : ''}.`
          : a.nextStepAsks.length
            ? `Asked for a next step${specific ? ' with a specific time' : ''}, but the homeowner did not commit.`
            : 'Never proposed a clear next step.',
        evidence: (a.specificNextSteps.length ? a.specificNextSteps : a.nextStepAsks).slice(-1),
      };
    }
    case 'compliance': {
      const score = a.forbiddenCount
        ? Math.min(40, 70 - 30 * a.forbiddenCount) - 5 * a.pressureCount
        : 96 - 12 * a.pressureCount;
      return {
        score: clamp(score),
        rationale: a.forbiddenCount
          ? `Made ${plural(a.forbiddenCount, 'forbidden claim')} about outcomes or cost.`
          : a.pressureCount
            ? `No forbidden claims, but used ${plural(a.pressureCount, 'pressure tactic')}.`
            : 'No forbidden claims or pressure tactics.',
        evidence: a.risks.slice(0, 2),
      };
    }
    default:
      return {
        score: -1,
        rationale: 'Scored from the overall quality of the conversation.',
        evidence: [],
      };
  }
}

export type CategoryScores = Record<string, number>;

/** Heuristic score per rubric category (custom categories get the mean of the known ones). */
export function scoreCategories(a: TranscriptAnalysis): CategoryScores {
  const scores: CategoryScores = {};
  const known: number[] = [];
  for (const c of a.input.categories) {
    const r = scoreCategory(c.key, a);
    if (r.score >= 0) {
      scores[c.key] = r.score;
      known.push(r.score);
    }
  }
  const mean = known.length ? Math.round(known.reduce((x, y) => x + y, 0) / known.length) : 60;
  for (const c of a.input.categories) if (scores[c.key] === undefined) scores[c.key] = mean;
  return scores;
}

export function weightedOverall(
  scores: CategoryScores,
  categories: readonly RubricCategoryRecord[],
): number {
  const total = categories.reduce((s, c) => s + c.weight, 0);
  if (total <= 0) return 0;
  return categories.reduce((s, c) => s + (scores[c.key] ?? 0) * c.weight, 0) / total;
}

/** Shift category scores so the weighted overall rounds exactly to `target` (used by the seed). */
export function calibrateScores(
  scores: CategoryScores,
  categories: readonly RubricCategoryRecord[],
  target: number,
  /** Rubric caps (for example compliance at 40 after a forbidden claim) that calibration must respect. */
  caps: Record<string, number> = {},
): CategoryScores {
  const limit = (key: string) => caps[key] ?? 100;
  const out: CategoryScores = Object.fromEntries(
    categories.map((c) => [c.key, Math.min(scores[c.key] ?? 0, limit(c.key))]),
  );
  const free = categories.filter((c) => c.weight > 0 && limit(c.key) > 0);
  for (let i = 0; i < 40 && Math.round(weightedOverall(out, categories)) !== target; i++) {
    const diff = target - weightedOverall(out, categories);
    const step = Math.abs(diff) >= 1 ? Math.round(diff) : Math.sign(diff);
    for (const c of free) {
      // Capped categories stay where the rubric puts them; the others absorb the difference.
      if (limit(c.key) < 100) continue;
      out[c.key] = Math.max(0, Math.min(100, (out[c.key] ?? 0) + step));
    }
  }
  // Fine-tune one point at a time on the heaviest uncapped categories that can still move.
  const ordered = free.filter((c) => limit(c.key) === 100).sort((x, y) => y.weight - x.weight);
  for (
    let i = 0;
    i < 200 && ordered.length && Math.round(weightedOverall(out, categories)) !== target;
    i++
  ) {
    const up = weightedOverall(out, categories) < target;
    const c = ordered[i % ordered.length]!;
    const v = out[c.key]!;
    if ((up && v < 100) || (!up && v > 0)) out[c.key] = v + (up ? 1 : -1);
  }
  return out;
}

const STRENGTH_TEXT: Record<string, string> = {
  discovery: 'Used an open question to get the homeowner talking about what really matters to them',
  listening: "Built on the homeowner's own words instead of a script",
  rapport: 'Opened warmly and treated the homeowner like a neighbour',
  empathy: 'Acknowledged the objection before responding to it',
  communication: 'Kept explanations short and easy to follow at the door',
  confidence: 'Asked for the next step directly and without apologising',
  roofing_knowledge: 'Explained the roof condition in concrete, accurate terms',
  insurance_knowledge: 'Explained the claim process accurately without overpromising',
  value_presentation: 'Gave concrete reasons to trust A5 with the work',
  objection_isolation: 'Checked whether the stated objection was the real one',
  objection_handling: 'Answered the real concern with specifics',
  question_quality: 'Asked open questions that invited real answers',
  next_step_closing: 'Proposed a specific, low-pressure next step',
  compliance: 'Stayed fully compliant: no promises about insurance outcomes or cost',
};

const GOALS: Record<string, (title: string) => string> = {
  discovery: (t) =>
    `In your next "${t}" attempt, ask two open-ended questions before presenting anything, and keep asking until the homeowner tells you what is really holding them back.`,
  listening: (t) =>
    `In your next "${t}" attempt, paraphrase the homeowner's concern back to them ("It sounds like…") before you answer it.`,
  rapport: (t) =>
    `Open your next "${t}" attempt with your name, A5 and one genuine, specific comment before you mention the roof.`,
  empathy: (t) =>
    `In your next "${t}" attempt, acknowledge the objection out loud ("That's completely fair…") before you respond to it every time it comes up.`,
  communication: (t) =>
    `Keep every message in your next "${t}" attempt under 40 words and end most of them with a question.`,
  confidence: (t) =>
    `Remove hedges ("I guess", "maybe", "sorry to bother you") from your next "${t}" attempt and ask for the next step directly.`,
  roofing_knowledge: (t) =>
    `In your next "${t}" attempt, describe one specific thing about this roof (age, shingle type or what hail does to it) in plain words.`,
  insurance_knowledge: (t) =>
    `In your next "${t}" attempt, explain the claim process step by step (inspection, documentation, adjuster, deductible) without predicting the outcome.`,
  value_presentation: (t) =>
    `In your next "${t}" attempt, give two concrete reasons to choose A5 (for example photo documentation and the written workmanship warranty).`,
  objection_isolation: (t) =>
    `In your next "${t}" attempt, isolate the objection with "Other than that, is there anything else holding you back?" before you answer it.`,
  objection_handling: (t) =>
    `In your next "${t}" attempt, answer the homeowner's real concern with specifics and cover every required talking point.`,
  question_quality: (t) =>
    `Make at least three of your questions in your next "${t}" attempt open-ended (what, how, why) rather than yes/no.`,
  next_step_closing: (t) =>
    `Close your next "${t}" attempt by proposing one specific next step with a day and time, such as "Could I come by Thursday at 4 to walk the roof with you?"`,
  compliance: (t) =>
    `Run your next "${t}" attempt without a single promise about what insurance will pay or what the roof will cost; describe the process, not the outcome.`,
};

interface QuestionIdea {
  match: RegExp;
  question: string;
  why: string;
}

const QUESTION_BANK: QuestionIdea[] = [
  {
    match: /./,
    question: 'What would need to be true for you to feel comfortable having someone take a look?',
    why: 'It invites the homeowner to name the real condition instead of repeating the objection.',
  },
  {
    match: /./,
    question: "What's your biggest concern about getting the roof looked at right now?",
    why: 'It surfaces the hidden concern directly without pressure.',
  },
  {
    match: /./,
    question:
      'How long have you been in the home, and has anyone been up on the roof since the storm?',
    why: 'It shows interest in their situation and tells you what they already know.',
  },
  {
    match: /insur|claim|adjuster|deductible|inspect/,
    question: 'What has your insurance agent told you about storm claims on your policy?',
    why: 'It reveals the fear behind the insurance objection so you can address it accurately.',
  },
  {
    match: /insur|claim|deductible/,
    question: 'Do you know what your deductible is, and is that part of what worries you?',
    why: "Deductible anxiety is the most common hidden concern behind 'I don't want to file a claim'.",
  },
  {
    match: /spouse|wife|husband|partner|decision/,
    question: 'What do you think will matter most to your spouse when you two talk about it?',
    why: 'It turns the absent decision maker into something you can plan for together.',
  },
  {
    match: /spouse|wife|husband|partner|decision/,
    question:
      'Would it help if I came back when you are both home so you can see the photos together?',
    why: 'It offers a next step that includes the other decision maker instead of competing with them.',
  },
  {
    match: /price|cheap|estimate|quote|compar/,
    question: 'Besides price, what would make you confident you picked the right roofer?',
    why: 'It moves the comparison from price to scope, materials and warranty.',
  },
  {
    match: /price|cheap|estimate|quote|compar/,
    question: 'What exactly is included in the other estimate you received?',
    why: 'Comparing scope line by line is the honest way to explain a price difference.',
  },
  {
    match: /time|busy|card/,
    question: 'When is a better time this week for a ten-minute look?',
    why: "It respects the homeowner's time while keeping the conversation alive.",
  },
  {
    match: /roofer|contractor|loyal|already|burned|sign/,
    question: 'What happened with the last contractor you worked with?',
    why: 'Past experiences explain present resistance and tell you what not to do.',
  },
  {
    match: /fine|look|need/,
    question: 'When you look at the roof from the yard, what would tell you something was wrong?',
    why: 'Hail damage is rarely visible from the ground; the question opens that conversation without contradicting them.',
  },
];

function topicOf(scenario: ScenarioSnapshot): string {
  const s = normalize(`${scenario.category} ${scenario.objection}`);
  if (/spouse|wife|husband|partner/.test(s)) return 'making the decision together';
  if (/insur|claim|adjuster/.test(s)) return 'the insurance side of this';
  if (/cheap|price|cost/.test(s)) return 'the price difference';
  if (/estimate|quote|compar/.test(s)) return 'comparing estimates';
  if (/sign/.test(s)) return 'signing anything';
  if (/roofer|contractor/.test(s)) return 'working with someone new';
  if (/fine|need/.test(s)) return 'the roof right now';
  return 'getting the roof looked at';
}

/** Compose the scorecard text from the analysis and (possibly calibrated) category scores. */
export function buildEvaluation(a: TranscriptAnalysis, scores: CategoryScores): EvaluationOutput {
  const { scenario, categories } = a.input;
  const results = new Map(categories.map((c) => [c.key, scoreCategory(c.key, a)]));
  const turn = (e: Evidence) => ({ turn: e.seq, quote: e.quote });

  const categoryScores = categories.map((c) => {
    const r = results.get(c.key)!;
    return {
      key: c.key,
      score: scores[c.key] ?? 0,
      rationale: r.rationale,
      evidence: r.evidence.slice(0, 2).map(turn),
    };
  });

  const ranked = [...categories].sort((x, y) => (scores[y.key] ?? 0) - (scores[x.key] ?? 0));
  const strengths: EvaluationOutput['strengths'] = [];
  for (const c of ranked) {
    const r = results.get(c.key)!;
    if (strengths.length >= 3 || (scores[c.key] ?? 0) < 65) break;
    if (r.evidence.length && STRENGTH_TEXT[c.key] && c.key !== 'compliance')
      strengths.push({ point: STRENGTH_TEXT[c.key]!, evidence: r.evidence.slice(0, 2).map(turn) });
  }
  for (const tp of a.talkingPoints) {
    if (strengths.length >= 2) break;
    if (tp.evidence)
      strengths.push({
        point: `Covered a required talking point: ${tp.text.replace(/\.$/, '')}`,
        evidence: [turn(tp.evidence)],
      });
  }

  const missed: EvaluationOutput['missedOpportunities'] = [];
  const firstResp = a.firstResponse;
  const firstQuote = firstResp ? quoteOf(sentences(firstResp.content)[0]!) : null;
  if (a.concernRevealedSeq === null) {
    missed.push({
      point:
        "Never uncovered the homeowner's real concern, so the conversation stayed on the surface objection.",
      turn: firstResp?.seq ?? null,
      quote: firstQuote,
      betterApproach: `Acknowledge the objection, then ask an open question about ${topicOf(scenario)} before presenting anything.`,
    });
  } else if (!a.concernAddressed) {
    missed.push({
      point: 'The real concern came out but was not answered directly.',
      turn: null,
      quote: null,
      betterApproach:
        'Repeat the concern back in your own words and answer it with specifics before asking for anything.',
    });
  }
  if (!a.isolation.length && firstResp) {
    missed.push({
      point: 'Did not isolate the objection before responding to it.',
      turn: firstResp.seq,
      quote: firstQuote,
      betterApproach:
        'Ask "Other than that, is there anything else holding you back?" so you answer the real objection, not just the first one.',
    });
  }
  for (const tp of a.talkingPoints.filter((t) => !t.evidence).slice(0, 2)) {
    missed.push({
      point: `Did not cover a required talking point: ${tp.text.replace(/\.$/, '')}.`,
      turn: null,
      quote: null,
      betterApproach: `Work it in once the homeowner's concern is on the table: ${tp.text}`,
    });
  }
  for (const b of a.behaviors.filter((x) => !x.evidence).slice(0, 2)) {
    if (missed.length >= 5) break;
    missed.push({
      point: `Expected behaviour not shown: ${b.text.replace(/\.$/, '')}.`,
      turn: null,
      quote: null,
      betterApproach: b.text,
    });
  }
  if (!a.objectiveReached && !a.specificNextSteps.length && missed.length < 5) {
    const last = a.reps[a.reps.length - 1];
    missed.push({
      point: 'Ended without proposing a specific next step.',
      turn: last?.seq ?? null,
      quote: last ? quoteOf(sentences(last.content).slice(-1)[0]!) : null,
      betterApproach:
        'Offer one specific, low-pressure step with a day and time (for example a 20-minute inspection Thursday at 4).',
    });
  }
  if (missed.length < 2) {
    const weakest = [...categories].sort((x, y) => (scores[x.key] ?? 0) - (scores[y.key] ?? 0))[0];
    if (weakest)
      missed.push({
        point: `${weakest.label} was the weakest area of this conversation.`,
        turn: null,
        quote: null,
        betterApproach: GOALS[weakest.key]?.(scenario.title) ?? weakest.guidance,
      });
  }

  const asked = a.questions.map((q) => q.quote);
  const context = normalize(`${scenario.category} ${scenario.objection} ${scenario.title}`);
  const questionsToAsk = QUESTION_BANK.filter((q) => q.match.test(context))
    .filter((q) => !asked.some((x) => overlap(x, q.question).ratio >= 0.5))
    .sort((x, y) => Number(y.match.source !== '.') - Number(x.match.source !== '.'))
    .slice(0, 4)
    .map(({ question, why }) => ({ question, why }));

  const riskyStatements = a.risks.map((r) => ({
    turn: r.seq,
    quote: r.quote,
    issue: r.issue,
    saferAlternative: r.saferAlternative,
  }));

  const recommended: EvaluationOutput['recommendedResponses'] = [];
  if (
    firstResp &&
    !PATTERNS.empathy.test(normalize(firstResp.content)) &&
    !questions(firstResp.content).some(isDiscoveryQuestion)
  ) {
    recommended.push({
      turn: firstResp.seq,
      repSaid: firstQuote,
      betterResponse: `That's completely fair. Before I go, can I ask what's on your mind about ${topicOf(scenario)}?`,
      why: 'Acknowledging the objection and asking an open question keeps the door open and lets the real concern surface.',
    });
  }
  for (const r of a.risks.slice(0, 2))
    recommended.push({
      turn: r.seq,
      repSaid: r.quote,
      betterResponse: r.saferAlternative,
      why: 'It stays accurate and compliant while still moving the conversation forward.',
    });
  const vagueAsk = a.nextStepAsks.find((e) => !PATTERNS.specificTime.test(normalize(e.quote)));
  if (vagueAsk && recommended.length < 4 && !a.objectiveReached) {
    recommended.push({
      turn: vagueAsk.seq,
      repSaid: vagueAsk.quote,
      betterResponse:
        'Would Thursday at 4 or Saturday morning work better for a 20-minute look at the roof?',
      why: 'A specific choice of times is easier to say yes to than an open-ended request.',
    });
  }
  if (a.longMessages.length && recommended.length < 4) {
    const long = a.longMessages[0]!;
    recommended.push({
      turn: long.seq,
      repSaid: quoteOf(sentences(long.content)[0]!),
      betterResponse:
        'Say one point in a sentence or two, then ask a question and let the homeowner talk.',
      why: 'Long explanations at the door lose the homeowner; short points with a question keep them engaged.',
    });
  }
  if (!recommended.length && a.reps.length) {
    const last = a.reps[a.reps.length - 1]!;
    recommended.push({
      turn: last.seq,
      repSaid: quoteOf(sentences(last.content).slice(-1)[0]!),
      betterResponse:
        'Summarise what you agreed on and confirm the exact day, time and who will be home.',
      why: 'Confirming the details makes the commitment concrete and reduces no-shows.',
    });
  }

  const weakest = [...categories]
    .filter((c) => c.weight > 0)
    .sort((x, y) => (scores[x.key] ?? 0) - (scores[y.key] ?? 0))[0];
  const strongest =
    ranked.find((c) => c.key !== 'compliance' && results.get(c.key)!.evidence.length) ?? ranked[0];
  const nextGoal = weakest
    ? (GOALS[weakest.key]?.(scenario.title) ??
      `Focus on ${weakest.label.toLowerCase()}: ${weakest.guidance}`)
    : 'Repeat the scenario and propose a specific next step.';

  const lastSeq = a.reps[a.reps.length - 1]?.seq ?? a.homeowners[a.homeowners.length - 1]?.seq ?? 0;
  const outcome =
    a.input.endReason === 'objective_reached'
      ? `The homeowner agreed to a next step at turn ${a.homeowners[a.homeowners.length - 1]?.seq ?? lastSeq}${a.concernRevealedSeq ? ` after the real concern surfaced at turn ${a.concernRevealedSeq}` : ''}.`
      : a.input.endReason === 'homeowner_ended'
        ? `The homeowner ended the conversation at turn ${a.homeowners[a.homeowners.length - 1]?.seq ?? lastSeq} without agreeing to anything.`
        : a.input.endReason === 'max_turns'
          ? 'The conversation reached the turn limit without a committed next step.'
          : `The conversation ended after ${plural(a.reps.length, 'representative turn')} without a committed next step.`;
  const strongEvidence = strongest ? results.get(strongest.key)!.evidence[0] : undefined;
  const strongSentence = strongest
    ? `${strongest.label} was the strongest area${strongEvidence ? ` ("${strongEvidence.quote}", turn ${strongEvidence.seq})` : ''}.`
    : '';
  const weakSentence = weakest
    ? `${weakest.label} held the score back: ${lowerFirst(results.get(weakest.key)!.rationale)}`
    : '';

  return {
    categoryScores,
    strengths,
    missedOpportunities: missed.slice(0, 5),
    questionsToAsk,
    riskyStatements,
    recommendedResponses: recommended.slice(0, 4),
    nextGoal,
    summary: [outcome, strongSentence, weakSentence].filter(Boolean).join(' '),
  };
}

function lowerFirst(s: string): string {
  return s ? s[0]!.toLowerCase() + s.slice(1) : s;
}

function questions(text: string): string[] {
  return sentences(text).filter((s) => s.includes('?'));
}

/** Heuristic evaluation used by the development simulator. */
export function simulateEvaluation(input: HeuristicEvaluationInput): EvaluationOutput {
  const analysis = analyzeTranscript(input);
  return buildEvaluation(analysis, scoreCategories(analysis));
}
