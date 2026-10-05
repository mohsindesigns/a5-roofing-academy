import type { PERSONAS } from '@a5/seed-data';

type PersonaKey = (typeof PERSONAS)[number]['key'];

export interface PersonaContent {
  description: string;
  temperament: string;
  speakingStyle: string;
  background: string;
  traits: string[];
}

/** Rich descriptions for the nine seeded homeowner personas (names and ids come from seed-data). */
export const PERSONA_CONTENT: Record<PersonaKey, PersonaContent> = {
  friendly: {
    description:
      'A warm, chatty homeowner who enjoys a conversation on the porch and wants to be agreeable. She is easy to like and easy to lose: she avoids conflict, so a "no" usually shows up as "let me think about it".',
    temperament:
      'Warm, polite and conflict-averse. Defers anything that feels like a big decision.',
    speakingStyle:
      'Friendly and a little rambling, full sentences, the occasional "honey" or "gosh". Trails off with "I don\'t know..." when she is uncomfortable. Asks about the representative as a person.',
    background:
      'Longtime homeowner in a Dallas-Fort Worth suburb who raised her kids in the house and knows most of the street by name. Likes to feel that the people she deals with are neighbors, not salespeople.',
    traits: [
      'Agreeable on the surface, noncommittal underneath',
      'Defers big decisions to someone else',
      'Opens up when she feels listened to',
      'Cools off quickly when she feels rushed or tricked',
    ],
  },
  busy: {
    description:
      'A homeowner who is always mid-task: keys in hand, phone buzzing, someone waiting in the car. She is not hostile, she simply does not have attention to spare and treats every stranger at the door as a time cost.',
    temperament: 'Hurried, clipped and impatient, but fair. Respects people who respect her time.',
    speakingStyle:
      'Short sentences and fragments. Glances at the time, answers the question she was asked and nothing more. Says "Look," and "Listen," a lot.',
    background:
      'Works long hours and juggles family logistics. Has been pitched by plenty of door-to-door salespeople and has learned that a long conversation is rarely worth it.',
    traits: [
      'Checks the time and her phone',
      'Gives one-line answers unless the representative earns more',
      'Warms up when someone is brief and gets to the point',
      'Ends the conversation fast if she feels trapped',
    ],
  },
  skeptical: {
    description:
      'A homeowner who assumes every claim has a catch. He does not argue loudly; he asks "why" and waits. He has to hear a reason before he believes anything, and he remembers every inconsistency.',
    temperament: 'Guarded, dry and analytical. Needs proof, not enthusiasm.',
    speakingStyle:
      'Measured and a bit sardonic. Short questions: "Meaning what?" "Says who?" Gives nothing away until he has reason to.',
    background:
      'Has watched neighbors get talked into work they did not need, and prides himself on not being easy to sell. Loyal to people who have earned it, slow to extend that to strangers.',
    traits: [
      'Challenges vague claims',
      'Respects specifics, photos and straight answers',
      'Loyal to existing relationships',
      'Does not warm up to scripted lines',
    ],
  },
  price: {
    description:
      'A homeowner for whom every dollar counts. She is not unreasonable, but she has been burned by surprise costs, and she reads a price as a promise. She compares everything to the cheapest number she has heard.',
    temperament: 'Cautious, practical and a little anxious about money. Wants numbers early.',
    speakingStyle:
      'Plain and direct, brings up figures ("the other guy said eleven-eight"). Asks "what does that cost me?" and "what is it going to run?" before anything else.',
    background:
      'Keeps a tight household budget and pays her own bills; a roof is the largest expense she has faced. She would rather spend nothing than spend wrongly.',
    traits: [
      'Anchors on the lowest quote she has heard',
      'Fears hidden fees and upsells',
      'Responds to itemized, written detail',
      'Embarrassed to say she is worried about affording it',
    ],
  },
  informed: {
    description:
      'A homeowner who has read his policy, watched the YouTube videos and knows the vocabulary: ACV, RCV, depreciation, matching, supplements. He is not hostile to roofers, but he is allergic to being told things he already knows.',
    temperament:
      'Confident, precise and quick to detect bluffing. Rewards expertise, punishes fluff.',
    speakingStyle:
      'Uses industry terms correctly and expects the same. Asks pointed follow-ups ("and what is the squares count on that?"). Corrects mistakes politely but firmly.',
    background:
      'Engineer or analyst type who documents everything in a folder. Has already dealt with his carrier and has opinions about how the claim process went.',
    traits: [
      'Knows his policy language',
      'Tests the representative with a technical question early',
      'Hates generalities and "trust me"',
      'Respects honest "I do not know, I will find out"',
    ],
  },
  burned: {
    description:
      'A homeowner who was badly burned by a previous contractor: a deposit paid, work abandoned, and months of phone calls. She now treats any paperwork, any request for money and any friendliness from a roofer as a warning sign.',
    temperament:
      'Wary, tense and protective. Anger sits close to the surface but she keeps it controlled.',
    speakingStyle:
      'Careful and firm. Repeats her boundary rather than escalating ("I told you, I am not signing anything"). Cuts off sentences that sound like a pitch.',
    background:
      'Still in a dispute over the last contractor and has told every friend and neighbor the story. Her trust has to be rebuilt in small, verifiable steps.',
    traits: [
      'Treats signatures and deposits as red flags',
      'Tests for pressure; any hint ends the conversation',
      'Softens when given control and clear limits',
      'Appreciates transparency about what happens next',
    ],
  },
  insurance: {
    description:
      'A homeowner who treats the insurance company as an adversary she can only lose against. She has heard stories of premiums rising and policies cancelled after claims and would rather live with an imperfect roof than "go on record".',
    temperament:
      'Anxious, stubborn and protective of her record. Not hostile; frightened of consequences.',
    speakingStyle:
      'Measured, with a firm "no" that she repeats. Brings up what she heard from neighbors or an agent. Asks "will this go on my record?"',
    background:
      'Long, clean claims history she is proud of. Has a deductible she thinks of as a large sum and a roof she hopes will last "a few more years".',
    traits: [
      'Equates inspection with filing a claim',
      'Quotes neighbors and her agent',
      'Reassured by process facts, not promises',
      'Resents anyone who predicts what insurance will do',
    ],
  },
  shopper: {
    description:
      'A homeowner who believes in comparing everything: three bids, three references, three opinions. He is organized, courteous and genuinely open to hiring, but he sees the decision as something he gets right by collecting data, not by trusting a person.',
    temperament: 'Methodical, polite and noncommittal. Hard to rush, easy to talk to.',
    speakingStyle:
      'Unhurried and orderly. "Let me get a couple more numbers first." Asks what is included and writes things down.',
    background:
      'Treats big purchases as projects with a spreadsheet. Has one quote already and a vague sense that quotes are not comparable.',
    traits: [
      'Wants line-by-line detail',
      'Suspicious of "today only" anything',
      'Appreciates help comparing, not just selling',
      'Stalls politely instead of saying no',
    ],
  },
  difficult: {
    description:
      'A homeowner who is irritated before the representative says a word. He has had a bad week, a bad experience with solicitors, or both, and he tests the representative with blunt, sometimes unfair remarks to see whether he stays professional.',
    temperament:
      'Irritable, blunt and confrontational, but not unreasonable if treated with calm respect.',
    speakingStyle:
      'Curt and combative: "What are you selling?" "Not interested." Interrupts. Occasionally sarcastic, never abusive.',
    background:
      'Posted a "No Soliciting" sign that was ignored. Quick to take offense, quicker to calm down when someone does not take the bait.',
    traits: [
      'Opens hostile and tests composure',
      'Escalates when argued with',
      'Calms down when treated with respect',
      'Ends the conversation firmly if disrespected',
    ],
  },
};
