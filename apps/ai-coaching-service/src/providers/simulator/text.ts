/**
 * Deterministic text heuristics shared by the scripted homeowner and the heuristic evaluator of
 * the development simulator. They are intentionally simple and explainable.
 */

export function normalize(s: string): string {
  return s
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .toLowerCase();
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
  return [...new Set(normalize(text).match(/[a-z0-9][a-z0-9'-]{3,}/g) ?? [])].filter((w) => !STOPWORDS.has(w));
}

/** Share of `reference` keywords present in `text` (crude stemming by 5-letter prefix). */
export function overlap(text: string, reference: string): { ratio: number; hits: number; total: number } {
  const ref = keywords(reference);
  if (!ref.length) return { ratio: 0, hits: 0, total: 0 };
  const stems = new Set(keywords(text).map((w) => w.slice(0, 5)));
  const hits = ref.filter((w) => stems.has(w.slice(0, 5))).length;
  return { ratio: hits / ref.length, hits, total: ref.length };
}

const LEADING_FILLER = /^(so|and|but|okay|ok|well|now|alright|great|just curious|out of curiosity|if you don't mind me asking|can i ask|may i ask|let me ask you|quick question)[,\s-]+/;
const OPEN_STARTER =
  /^(what|how|why|when|where|who|which|tell me|walk me|help me|talk me|describe|share|could you tell|can you tell|can you walk|would you tell|would you mind telling|would you share|what's|how's|in what way)\b/;
/** Questions that close or pitch rather than discover. */
const CLOSING_QUESTION =
  /\b(what if i|how about (we|i|if)|what time works|which (day|time) works|when (can|could|should) (i|we)|can i (get|put|grab|schedule|book|come)|would you like to (sign|schedule|book)|would (tomorrow|today|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|are you ready)\b/;

export function questions(text: string): string[] {
  return sentences(text).filter((s) => s.includes('?'));
}

export function isOpenQuestion(question: string): boolean {
  let q = normalize(question).trim();
  for (let i = 0; i < 3; i++) q = q.replace(LEADING_FILLER, '');
  return OPEN_STARTER.test(q) || /\b(what would|how would|what's (the|your|most)|what are|what do you|how do you|how did|what made|what happened)\b/.test(q);
}

/** Open question about the homeowner's situation, priorities or concerns (not a closing question). */
export function isDiscoveryQuestion(question: string): boolean {
  const q = normalize(question);
  return isOpenQuestion(question) && !CLOSING_QUESTION.test(q);
}

export const PATTERNS = {
  empathy:
    /\b(i understand|i totally understand|i completely understand|i get (it|that)|i hear you|that makes (total |complete )?sense|makes sense|totally fair|that's fair|completely fair|fair enough|that's a fair|i appreciate (that|you|it)|i respect (that|your)|of course|i'd feel the same|i would too|sorry to hear|that's frustrating|that sounds (frustrating|stressful|tough|hard)|understandable|i can imagine|no pressure|that's smart|smart move|good call)\b/,
  listening:
    /\b(you mentioned|you said|it sounds like|sounds like|so what i'm hearing|if i heard you|if i understand|you're saying|just so i understand|to make sure i understand|let me make sure|so you're|so your)\b/,
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
  forbidden:
    /\b(free roof|roof (is|will be|would be) free|get (you )?a free roof|won't cost you (anything|a dime|a thing|a penny)|will not cost you anything|cost you nothing|insurance (will|is going to|is gonna|always) (pay|cover)|they('ll| will) pay for (the )?(whole|entire|new) roof|guarantee(d)? (approval|your claim|the claim|insurance|they('ll| will) approve)|approval is guaranteed|waive (your|the) deductible|cover (your|the) deductible|pay (your|the) deductible|eat the deductible|no out[- ]of[- ]pocket|rates (won't|will not|never) go up|premiums? (won't|will not|never) (go up|increase|change))\b/,
  negation: /\b(can't|cannot|can not|won't|will not|don't|do not|never|no one can|nobody can|not going to|isn't|is not|wouldn't|couldn't|not promise|no promises|not something i can)\b/,
  hedges: /\b(um+|uh+|i guess|kind of|sort of|i think maybe|sorry to bother|if it's not too much|i'm not sure|probably|hopefully)\b/,
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
  'a5',
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
  const before = s.slice(0, m.index);
  return PATTERNS.negation.test(before);
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

const OBJECT_CONTEXT = /\b(to|for|with|at|about|tell|give|make|let|help|show|ask|call|sell|charge|pressure|push|rush|trust|told|than|from|by|on|bother|convince|send)\s*$/i;

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
    out += replaced.slice(last, m.index) + (OBJECT_CONTEXT.test(before) ? keepCase(m[0], 'me') : 'I');
    last = m.index + m[0].length;
  }
  out += replaced.slice(last);
  return out.replace(/\bI am\b(?=\s+(worried|afraid|scared|nervous))/g, "I'm");
}

function keepCase(original: string, replacement: string): string {
  if (replacement.startsWith('I')) return replacement;
  return original[0] === original[0]!.toUpperCase() ? replacement[0]!.toUpperCase() + replacement.slice(1) : replacement;
}
