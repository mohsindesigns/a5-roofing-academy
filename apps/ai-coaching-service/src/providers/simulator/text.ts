/**
 * Deterministic text heuristics shared by the scripted homeowner and the heuristic evaluator of
 * the development simulator. They are intentionally simple and explainable.
 */

export function normalize(s: string): string {
  return s.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').toLowerCase();
}

/** Sentences as exact substrings of the input (so they can be quoted verbatim). */
export function sentences(text: string): string[] {
  const out: string[] = [];
  const re = /[^.!?]+(?:[.!?]+["')\]]*|$)/g;
  for (const m of text.matchAll(re)) {
    const s = m[0].trim();
    if (s) out.push(s);
  }
  return out.length ? out : [text.trim()].filter(Boolean);
}

export function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

const STOPWORDS = new Set(
  `a an the and or but if then so to of in on at for with from by about into over after before up down out off than that this these those it its it's is are was were be been being am i me my mine we our you your yours he she him her his they them their what which who whom when where why how all any both each few more most other some such no nor not only own same too very can will just don't should now do does did have has had having would could also there here get got let let's make made like really well okay ok yes yeah sure going want need one`.split(
    /\s+/,
  ),
);

/** Content words (lowercase, ≥ 4 letters, no stopwords). */
export function keywords(text: string): string[] {
  return [...new Set(normalize(text).match(/[a-z0-9][a-z0-9'-]{3,}/g) ?? [])].filter(
    (w) => !STOPWORDS.has(w),
  );
}

/** Share of `reference` keywords present in `text` (crude stemming by 5-letter prefix). */
export function overlap(
  text: string,
  reference: string,
): { ratio: number; hits: number; total: number } {
  const ref = keywords(reference);
  if (!ref.length) return { ratio: 0, hits: 0, total: 0 };
  const stems = new Set(keywords(text).map((w) => w.slice(0, 5)));
  const hits = ref.filter((w) => stems.has(w.slice(0, 5))).length;
  return { ratio: hits / ref.length, hits, total: ref.length };
}

const LEADING_FILLER =
  /^(so|and|but|okay|ok|well|now|alright|great|just curious|out of curiosity|if you don't mind me asking|can i ask|may i ask|let me ask you|quick question)[,\s-]+/;
const OPEN_STARTER =
  /^(what|how|why|when|where|who|which|tell me|walk me|help me|talk me|describe|share|could you tell|can you tell|can you walk|would you tell|would you mind telling|would you share|what's|how's|in what way)\b/;
/** Questions that close or pitch rather than discover. */
const CLOSING_QUESTION =
  /\b(what if i|how about|what (time|day) (works|would work|is best)|which (day|time) (works|would work|is better)|when (can|could|should) (i|we)|when('s| is) (a )?(good|better|best) time|can i (get|put|grab|schedule|book|come)|would you like to (sign|schedule|book)|would (tomorrow|today|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|are you ready)\b/;

export function questions(text: string): string[] {
  return sentences(text).filter((s) => s.includes('?'));
}

function stripFillers(clause: string): string {
  let q = clause.trim();
  for (let i = 0; i < 3; i++)
    q = q
      .replace(LEADING_FILLER, '')
      .replace(/^(and|but|so|then|since|because|rather than guess)\s+/, '');
  return q.trim();
}

/** An open question (what / how / why ...) in the sentence or in any clause after a preamble. */
export function isOpenQuestion(question: string): boolean {
  const q = normalize(question).trim();
  const clauses = [q, ...q.split(/[,;:]\s+|\s[-\u2013\u2014]\s/)].map(stripFillers);
  return (
    clauses.some((c) => OPEN_STARTER.test(c)) ||
    /\b(what would|how would|what's (the|your|most)|what are|what do you|how do you|how did|what made|what happened|what have you|what has|how has)\b/.test(
      q,
    )
  );
}

/** Open question about the homeowner's situation, priorities or concerns (not a closing question). */
export function isDiscoveryQuestion(question: string): boolean {
  const q = normalize(question);
  return isOpenQuestion(question) && !CLOSING_QUESTION.test(q);
}

export const PATTERNS = {
  empathy:
    /\b(i understand|i totally understand|i completely understand|i get (it|that)|i hear you|that makes (total |complete )?sense|makes sense|totally fair|that's fair|completely fair|fair enough|that's a fair|i appreciate (that|you|it)|i respect (that|your)|of course|i'd feel the same|i would too|sorry to hear|i'm sorry|sorry that|that's frustrating|that sounds (frustrating|stressful|tough|hard)|that's a (hard|terrible|real|tough|rough|common)|that would (worry|bother) me|anyone would|understandable|i can imagine|no pressure|that's smart|smart move|good call|good instinct|right instinct|is smart|i'm glad you (said|told)|thank you for (telling|being|sharing|saying|letting)|i won't argue|i'm not going to (do|push|ask|argue)|i wouldn't want that)\b/,
  listening:
    /\b(you mentioned|you said|it sounds like|sounds like|so what i'm hearing|if i heard you|if i understand|you're saying|just so i understand|to make sure i understand|let me make sure|so you're|so your|it sounds|what matters most|if i'm hearing|you found|you noticed|you told me)\b/,
  isolation:
    /\b(other than|aside from|besides|apart from|is that the only|is there anything else|anything else (that's |that is )?(holding|stopping|on your mind|keeping)|if (that|we|i) (could|can|were|was) (be )?(taken care|solved|handled|addressed|cover)|suppose|let's say|if it weren't for|if it wasn't for)\b/,
  rapport:
    /\b(thank you|thanks|appreciate your time|my name is|i'm [a-z]+ with|nice to meet|good (morning|afternoon|evening)|hope (your|you're)|beautiful|neighbor|how's your|congrat|love (your|the)|great (yard|garden|dog|porch))\b/,
  nextStep:
    /\b(schedule|book|set up|come (back|by|out)|inspection|inspect|appointment|stop by|swing by|meet (you|with)|walk the roof|take a look|get on the roof|calendar|come over|drop by)\b/,
  specificTime:
    /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|tonight|this (morning|afternoon|evening|weekend|week)|next week|\d{1,2}(:\d{2})?\s?(am|pm|a\.m\.|p\.m\.|o'clock)|noon|(at|around) \d{1,2}\b)/,
  pressure:
    /\b(sign (today|now|right now|this today)|today only|only today|limited time|before (it's|its) too late|offer expires|deal expires|you need to decide|act now|last chance|you'd be crazy|everybody (on|in) (the|your) (street|neighborhood)|right now or|this price is only)\b/,
  /** Promises about outcomes that are never acceptable. */
  forbidden:
    /\b(free roof(?! (inspection|estimate|assessment|check|evaluation|review|report|quote))|roof (is|will be|would be) free|get (you )?a free roof|insurance (will|is going to|is gonna|always) (pay|cover)|they('ll| will) pay for (the )?(whole|entire|new) roof|guarantee(d)? (approval|your claim|the claim|insurance|they('ll| will) approve)|approval is guaranteed|waive (your|the) deductible|cover (your|the) deductible|pay (your|the) deductible|eat the deductible|rates (won't|will not|never) go up|premiums? (won't|will not|never) (go up|increase|change))\b/,
  negation:
    /\b(can't|cannot|can not|won't|will not|don't|do not|never|no one can|nobody can|not going to|isn't|is not|wouldn't|couldn't|not promise|no promises|not something i can)\b/,
  hedges:
    /\b(um+|uh+|i guess|kind of|sort of|i think maybe|sorry to bother|if it's not too much|i'm not sure|probably|hopefully)\b/,
  aiProbe:
    /\b(are you (an? )?(ai|a\.i\.|bot|robot|computer|chatbot|real person|human|language model|simulation)|is this (an? )?(ai|simulation|test|training)|chatgpt|claude|language model)\b/,
  farewell: /\b(have a (good|great|nice) (day|one|evening|night)|take care|bye|goodbye)\b/,
} as const;

export const ROOFING_TERMS = [
  'shingle',
  'granule',
  'hail',
  'decking',
  'underlayment',
  'flashing',
  'vent',
  'ridge',
  '3-tab',
  'three-tab',
  'architectural',
  'soft metal',
  'gutter',
  'downspout',
  'drip edge',
  'valley',
  'bruis',
  'impact',
  'class 4',
  'attic',
  'ventilation',
  'leak',
  'wind',
  'lifted',
  'creased',
  'squares',
  'tear-off',
  'ice and water',
];

export const INSURANCE_TERMS = [
  'deductible',
  'adjuster',
  'claim',
  'policy',
  'premium',
  'depreciation',
  'actual cash value',
  'replacement cost',
  'recoverable',
  'supplement',
  'documentation',
  'date of loss',
  'storm date',
  'carrier',
  'coverage',
  'agent',
  'filing window',
  'one year',
];

export const VALUE_TERMS = [
  'warranty',
  'licensed',
  'insured',
  'local',
  'reviews',
  'referral',
  'photos',
  'pictures',
  'documentation',
  'workmanship',
  'certified',
  'manufacturer',
  'written',
  'no obligation',
  'no cost',
  'years',
  'crew',
  'clean',
  'permit',
  'neighbors',
  'itemized',
  'line by line',
  'apples to apples',
  'same scope',
];

export function termsIn(text: string, terms: readonly string[]): string[] {
  const t = normalize(text);
  return terms.filter((term) => t.includes(term));
}

/** True when the match in the sentence is negated ("I can't promise insurance will pay"). */
export function isNegated(sentence: string, pattern: RegExp): boolean {
  const s = normalize(sentence);
  const m = pattern.exec(s);
  if (!m) return false;
  // Only a negation close to the match and in the same clause counts ("Don't worry, insurance will
  // pay" is a promise; "I can't promise insurance will pay" is not).
  const clause =
    s
      .slice(0, m.index)
      .split(/[,;:.!?\u2014\u2013]|\s-\s/)
      .pop() ?? '';
  return PATTERNS.negation.test(clause.split(/\s+/).filter(Boolean).slice(-6).join(' '));
}

/** Matches of `pattern` in non-negated sentences, as exact sentence quotes. */
export function affirmedMatches(text: string, pattern: RegExp): string[] {
  return sentences(text).filter((s) => pattern.test(normalize(s)) && !isNegated(s, pattern));
}

export function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function pick<T>(items: readonly T[], seed: number): T {
  return items[seed % items.length]!;
}

/** Short, exact quote: the sentence itself, or a word-boundary prefix of it. */
export function quoteOf(sentence: string, max = 220): string {
  const s = sentence.trim();
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  return cut.slice(0, Math.max(cut.lastIndexOf(' '), 40)).trim();
}

const OBJECT_CONTEXT =
  /\b(to|for|with|at|about|tell|give|make|let|help|show|ask|call|sell|charge|pressure|push|rush|trust|told|than|from|by|on|bother|convince|send|cost|owe|hurt|leave|bring|take|see|hear|text|email|thank|warn|assure|promise|force)\s*$/i;

/**
 * Turn second-person scenario text ("You're worried your deductible…") into what the homeowner
 * would say ("I'm worried my deductible…").
 */
export function secondToFirstPerson(text: string): string {
  const replaced = text
    .replace(/\byou are not\b/gi, (m) => keepCase(m, 'I am not'))
    .replace(/\byou aren't\b/gi, (m) => keepCase(m, "I'm not"))
    .replace(/\byou're\b/gi, (m) => keepCase(m, "I'm"))
    .replace(/\byou are\b/gi, (m) => keepCase(m, 'I am'))
    .replace(/\byou were\b/gi, (m) => keepCase(m, 'I was'))
    .replace(/\byou've\b/gi, (m) => keepCase(m, "I've"))
    .replace(/\byou'll\b/gi, (m) => keepCase(m, "I'll"))
    .replace(/\byou'd\b/gi, (m) => keepCase(m, "I'd"))
    .replace(/\byourself\b/gi, (m) => keepCase(m, 'myself'))
    .replace(/\byours\b/gi, (m) => keepCase(m, 'mine'))
    .replace(/\byour\b/gi, (m) => keepCase(m, 'my'));
  let out = '';
  let last = 0;
  for (const m of replaced.matchAll(/\byou\b/gi)) {
    const before = replaced.slice(0, m.index);
    out +=
      replaced.slice(last, m.index) + (OBJECT_CONTEXT.test(before) ? keepCase(m[0], 'me') : 'I');
    last = m.index + m[0].length;
  }
  out += replaced.slice(last);
  return out.replace(/\bI am\b(?=\s+(worried|afraid|scared|nervous))/g, "I'm");
}

function keepCase(original: string, replacement: string): string {
  if (replacement.startsWith('I')) return replacement;
  return original[0] === original[0]!.toUpperCase()
    ? replacement[0]!.toUpperCase() + replacement.slice(1)
    : replacement;
}

const OUTCOME_CONTEXT =
  /\b(insurance|insurer|carrier|deductible|replacement|replace|new roof|whole roof|entire roof|full roof|claim|premium|premiums)\b/;
/** "It won't cost you anything" is only a violation when it is about the roof or the claim. */
const COST_PHRASE =
  /\b(won't cost you (anything|a dime|a thing|a penny)|will not cost you anything|cost you nothing|no out[- ]of[- ]pocket)\b/;

/** Sentences that make a forbidden promise (insurance outcome, free roof, deductible waiver, ...). */
export function forbiddenClaimSentences(text: string): string[] {
  return sentences(text).filter((s) => {
    const n = normalize(s);
    if (PATTERNS.forbidden.test(n)) return !isNegated(s, PATTERNS.forbidden);
    return COST_PHRASE.test(n) && OUTCOME_CONTEXT.test(n) && !isNegated(s, COST_PHRASE);
  });
}

const CLAUSE_BREAK = /,\s+(?:and|but|so|because)\s+|\s+because\s+|\s+until\s+/g;

/** Shorten a long sentence at a natural clause boundary so a homeowner reply stays conversational. */
export function compactSentence(sentence: string, maxWords = 28): string {
  const words = sentence.trim().split(/\s+/);
  if (words.length <= maxWords) return sentence.trim();
  let cut = -1;
  for (const m of sentence.matchAll(CLAUSE_BREAK)) {
    const left = sentence.slice(0, m.index).trim().split(/\s+/).length;
    if (left >= 10 && left <= maxWords + 8) cut = m.index;
  }
  const left = cut > 0 ? sentence.slice(0, cut).trim() : words.slice(0, maxWords).join(' ');
  return `${left.replace(/[,;:\s]+$/, '')}.`;
}
