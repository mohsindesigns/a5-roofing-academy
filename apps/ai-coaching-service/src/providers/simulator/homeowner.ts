import { END_MARKERS, SCENE_CUE } from '../../prompts/compiler.js';
import type { ChatMessage, PersonaSnapshot, ScenarioSnapshot } from '../types.js';
import {
  PATTERNS,
  affirmedMatches,
  hash,
  isDiscoveryQuestion,
  normalize,
  overlap,
  pick,
  questions,
  secondToFirstPerson,
  sentences,
  termsIn,
  INSURANCE_TERMS,
  ROOFING_TERMS,
} from './text.js';

interface Voice {
  prefix: readonly string[];
  agreeClosing: readonly string[];
}

/** Light persona colouring derived from temperament and traits. */
function voiceOf(persona: PersonaSnapshot): Voice {
  const t = normalize(`${persona.name} ${persona.temperament} ${persona.traits.join(' ')}`);
  if (/(busy|impatient|rushed|short on time|hurried)/.test(t)) {
    return { prefix: ['Look, ', '', 'Listen, '], agreeClosing: ['Just keep it quick.', "Text me before you come, I'm usually running behind."] };
  }
  if (/(burned|distrust|suspicious|guarded)/.test(t)) {
    return { prefix: ['', 'Mm. ', 'See, '], agreeClosing: ["But I'm not signing anything that day.", 'And I want everything in writing.'] };
  }
  if (/(skeptic|doubt)/.test(t)) {
    return { prefix: ['', 'Mm-hm. ', 'Okay, but '], agreeClosing: ["I'll want to see the photos myself.", "Don't make me regret it."] };
  }
  if (/(price|budget|frugal|cost)/.test(t)) {
    return { prefix: ['', 'Well, ', 'See, '], agreeClosing: ['As long as it costs me nothing to look.', 'I still want to compare numbers, though.'] };
  }
  if (/(difficult|irritable|confrontational|blunt)/.test(t)) {
    return { prefix: ['', 'Yeah, ', 'Listen, '], agreeClosing: ['Be on time.', "And if you're late, don't bother."] };
  }
  if (/(informed|research|analytical|detail)/.test(t)) {
    return { prefix: ['', 'Right, but ', 'Okay. '], agreeClosing: ['Bring the measurements and photos with you.', "I'll have my policy pulled up."] };
  }
  return { prefix: ['', 'Oh, ', 'Well, '], agreeClosing: ['Thanks for actually listening.', 'I appreciate you not being pushy about it.'] };
}

function lowerFirst(s: string): string {
  return s ? s[0]!.toLowerCase() + s.slice(1) : s;
}

function upperFirst(s: string): string {
  return s ? s[0]!.toUpperCase() + s.slice(1) : s;
}

/** The time the rep proposed, echoed back ("Thursday at 4"). */
function proposedTime(text: string): string | null {
  const m =
    /\b((?:this |next )?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|tonight)(?:\s+(?:morning|afternoon|evening|night))?(?:\s+(?:at|around)\s+\d{1,2}(?::\d{2})?\s?(?:am|pm|a\.m\.|p\.m\.|o'clock)?)?)/i.exec(
      text,
    ) ?? /\b((?:at|around)\s+\d{1,2}(?::\d{2})?\s?(?:am|pm|a\.m\.|p\.m\.|o'clock)?)/i.exec(text);
  return m ? m[1]!.trim() : null;
}

function bestFact(scenario: ScenarioSnapshot, query: string): string | null {
  const facts = [...sentences(scenario.propertyContext), ...sentences(scenario.background)];
  let best: { fact: string; score: number } | null = null;
  for (const fact of facts) {
    const { hits } = overlap(query, fact);
    if (hits > 0 && (!best || hits > best.score)) best = { fact, score: hits };
  }
  return best ? secondToFirstPerson(best.fact) : null;
}

function concernText(scenario: ScenarioSnapshot): string {
  return secondToFirstPerson(sentences(scenario.hiddenConcern).slice(0, 2).join(' '));
}

/**
 * Scripted, deterministic homeowner. It stays in character, reacts to keywords and discovery
 * questions, reveals the hidden concern only after a discovery question, and ends with an end
 * marker when the rep proposes a clear next step after addressing the concern (or after repeated
 * pressure).
 */
export function simulateHomeownerReply(persona: PersonaSnapshot, scenario: ScenarioSnapshot, messages: readonly ChatMessage[]): string {
  const turns = messages[0]?.role === 'user' && messages[0].content === SCENE_CUE ? messages.slice(1) : [...messages];
  // Consecutive trailing rep messages (e.g. resent after an error) are answered together.
  let tail = turns.length;
  while (tail > 0 && turns[tail - 1]!.role === 'user') tail--;
  const latest = turns
    .slice(tail)
    .map((m) => m.content)
    .join(' ')
    .trim();
  const history = turns.slice(0, tail);
  const earlierRep = history.filter((m) => m.role === 'user').map((m) => m.content);
  const homeownerLines = history.filter((m) => m.role === 'assistant').map((m) => m.content);
  const voice = voiceOf(persona);
  const seed = hash(`${scenario.id}:${earlierRep.length}`);
  const prefix = pick(voice.prefix, seed);
  const latestNorm = normalize(latest);

  if (!latest) return `${prefix}${scenario.objection}`;

  const concernRevealed = homeownerLines.some((line) => overlap(line, scenario.hiddenConcern).ratio >= 0.35);
  const revealIndex = homeownerLines.findIndex((line) => overlap(line, scenario.hiddenConcern).ratio >= 0.35);
  const latestQuestions = questions(latest);
  const isolationQuestion = latestQuestions.some((q) => PATTERNS.isolation.test(normalize(q)));
  const latestDiscovery = latestQuestions.some(isDiscoveryQuestion) || isolationQuestion;
  const forbidden = affirmedMatches(latest, PATTERNS.forbidden);
  const pressure = affirmedMatches(latest, PATTERNS.pressure);
  const earlierPushes = earlierRep.reduce(
    (n, line) => n + affirmedMatches(line, PATTERNS.forbidden).length + affirmedMatches(line, PATTERNS.pressure).length,
    0,
  );
  const empathy = PATTERNS.empathy.test(latestNorm);
  const nextStepAsk =
    PATTERNS.nextStep.test(latestNorm) && (latest.includes('?') || /\b(let me|i can|i could|we can|we could|how about|why don't|i'd like to)\b/.test(latestNorm));
  const earlierNextStepAsks = earlierRep.filter((l) => PATTERNS.nextStep.test(normalize(l)) && l.includes('?')).length;
  const repAfterReveal = revealIndex >= 0 ? [...earlierRep.slice(revealIndex), latest] : [];
  const concernAddressed =
    concernRevealed &&
    repAfterReveal.some((l) => PATTERNS.empathy.test(normalize(l)) || overlap(l, scenario.hiddenConcern).hits >= 2);

  // 1. Never break character, even when asked directly.
  if (PATTERNS.aiProbe.test(latestNorm)) {
    return pick(
      [
        "What? I'm just trying to get through my day here. What is it you need?",
        "That's an odd thing to ask somebody at their own front door. What did you want?",
        "I don't follow. You're the one who knocked on my door, so what's this about?",
      ],
      seed,
    );
  }

  // 2. Pressure or too-good-to-be-true claims cool the homeowner down.
  if (forbidden.length || pressure.length) {
    const pushback = forbidden.length
      ? "Hold on. Nobody can promise that before anyone has even looked at it, and that's exactly the kind of thing that makes me nervous."
      : "I'm not making any decisions on the spot, and pushing me isn't going to help.";
    if (earlierPushes >= 1) return `${pushback} I think we're done here. Have a good day. ${END_MARKERS.homeowner_ended}`;
    return pushback;
  }

  // 3. A next-step ask is accepted only once the real concern is out and addressed.
  if (nextStepAsk && !(latestDiscovery && !concernRevealed)) {
    if (concernRevealed && (concernAddressed || scenario.difficulty === 'beginner')) {
      const time = proposedTime(latest);
      const agree = time ? `Okay. ${upperFirst(time)} works for me.` : "Okay, that's fair. Let's set it up.";
      return `${agree} ${pick(voice.agreeClosing, seed)} ${END_MARKERS.objective_reached}`;
    }
    if (earlierNextStepAsks >= 2) {
      return `I've told you, I'm not ready to set anything up. I'm going to head back inside now. ${END_MARKERS.homeowner_ended}`;
    }
    return `${prefix}${lowerFirstIfPrefixed(prefix, scenario.objection)} I'm not ready to put anything on the calendar yet.`;
  }

  // 4. The first genuine discovery question earns the hidden concern.
  if (latestDiscovery && !concernRevealed) {
    return `${pick(['Honestly?', "Well, if I'm being honest,", "Okay, here's the thing."], seed)} ${concernText(scenario)}`;
  }

  // 5. Later discovery questions get honest answers from the facts of the situation.
  if (latestDiscovery) {
    const fact = bestFact(scenario, latest);
    if (fact) return `${prefix}${lowerFirstIfPrefixed(prefix, fact)}`;
    return pick(
      [
        "Mostly I just want it done right without feeling like I'm getting taken for a ride.",
        "I'd want to understand exactly what I'm agreeing to before anybody touches the roof.",
        "Like I said, that's really what's on my mind.",
      ],
      seed,
    );
  }

  // 6. Empathy warms the homeowner up.
  if (empathy) {
    if (concernRevealed) {
      return pick(["I appreciate that. So what are you suggesting?", "Thank you. So what would the next step even look like?", "Okay. I appreciate you hearing me out."], seed);
    }
    return `I appreciate that. ${prefix ? upperFirst(prefix.trim().replace(/,$/, '')) + ', ' : ''}${prefix ? lowerFirst(scenario.objection) : scenario.objection}`;
  }

  // 7. Roofing or insurance talk gets a reaction grounded in the property facts.
  if (termsIn(latest, ROOFING_TERMS).length || termsIn(latest, INSURANCE_TERMS).length) {
    const fact = bestFact(scenario, latest);
    if (fact) return `Yeah, ${lowerFirst(fact)}`;
    return "I wouldn't know what to look for up there, honestly.";
  }

  // 8. Otherwise the objection stands.
  return pick(
    [
      `${prefix}${lowerFirstIfPrefixed(prefix, scenario.objection)}`,
      `Like I said, ${lowerFirst(scenario.objection)}`,
      `${scenario.objection} I don't know what else to tell you.`,
    ],
    seed,
  );
}

function lowerFirstIfPrefixed(prefix: string, text: string): string {
  return prefix && !/^(I|I'm|I've|I'd|I'll)\b/.test(text) ? lowerFirst(text) : text;
}
