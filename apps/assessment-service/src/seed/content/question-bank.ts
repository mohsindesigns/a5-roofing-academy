import type { assessment } from '@a5/contracts';
import { matching, mc, ms, ordering, tf, type Draft } from './drafts.js';

/**
 * The "A5 Sales Core" question bank: categories, competencies and questions written for the A5 New
 * Hire Sales Academy (residential roofing in North and Central Texas). Weekly knowledge checks use
 * fixed questions tagged `week-1/2/3`; the final assessment draws from every category.
 */

export const CATEGORIES = [
  { key: 'company-standards', name: 'Company Standards', description: 'How A5 Roofing works: the customer journey, documentation and the standards every representative is held to.' },
  { key: 'roofing-systems', name: 'Roofing Systems', description: 'Components, materials, measurements and ventilation of residential roof systems.' },
  { key: 'storm-damage', name: 'Storm Damage', description: 'Recognising, separating and documenting hail and wind damage.' },
  { key: 'insurance-process', name: 'Insurance Process', description: 'How homeowner claims, deductibles, depreciation, supplements and payments work.' },
  { key: 'sales-conversation', name: 'Sales Conversation', description: 'Opening at the door, discovery questions and guiding the homeowner to a decision.' },
  { key: 'objection-handling', name: 'Objection Handling', description: 'The A5 Objection Framework applied to the concerns homeowners raise most often.' },
  { key: 'compliance', name: 'Compliance', description: 'Legal and ethical limits: what a representative must never promise, offer or do.' },
] as const;
export type CategoryKey = (typeof CATEGORIES)[number]['key'];

export const COMPETENCIES = [
  { key: 'product-knowledge', name: 'Roofing product knowledge', description: 'Explains roof components, materials and ventilation accurately and in plain language.' },
  { key: 'damage-assessment', name: 'Damage assessment & documentation', description: 'Identifies storm damage correctly and documents it so an adjuster can verify it.' },
  { key: 'claims-guidance', name: 'Insurance claim guidance', description: 'Explains the claim process and payments without overstepping the contractor role.' },
  { key: 'discovery-rapport', name: 'Discovery & rapport', description: 'Earns the conversation and uncovers what matters to the homeowner.' },
  { key: 'objection-handling', name: 'Objection handling', description: 'Responds to concerns with the A5 Objection Framework instead of pressure.' },
  { key: 'ethics-compliance', name: 'Ethics & compliance', description: 'Stays within the law and the A5 Sales Code of Conduct.' },
  { key: 'a5-process', name: 'A5 process & standards', description: 'Follows the A5 customer journey and documentation standards.' },
] as const;
export type CompetencyKey = (typeof COMPETENCIES)[number]['key'];

export interface SeedQuestion {
  key: string;
  category: CategoryKey;
  competencies: CompetencyKey[];
  difficulty: assessment.Difficulty;
  points?: number;
  tags: string[];
  prompt: string;
  explanation: string;
  draft: Draft;
  /** Answers seeded learners give on open questions, with the trainer's feedback. */
  written?: { strong: string; strongFeedback: string; weak: string; weakFeedback: string };
  /** A realistic wrong answer for auto-graded short answers. */
  commonMistake?: string;
}

const W1 = 'week-1';
const W2 = 'week-2';
const W3 = 'week-3';

export const QUESTIONS: SeedQuestion[] = [
  // ------------------------------------------------------------ Company Standards
  {
    key: 'cs-photo-report',
    category: 'company-standards',
    competencies: ['a5-process'],
    difficulty: 'easy',
    tags: [W1, 'inspection', 'photo-report'],
    prompt: 'After an inspection you walk the homeowner through the A5 photo report. What is the purpose of that report?',
    explanation:
      'The photo report is how A5 earns trust: the homeowner sees exactly what we saw, slope by slope, before deciding anything. It documents conditions. It does not decide coverage (only the insurer does), it does not replace the adjuster, and it is not a price quote.',
    draft: mc(
      ['To show the homeowner what was found on their roof, with dated photos, before any decision is made', true],
      ['To prove to the insurance company that the claim has to be paid'],
      ['To replace the adjuster’s inspection so the claim moves faster'],
      ['To give the homeowner the final price of a replacement'],
    ),
  },
  {
    key: 'cs-customer-journey',
    category: 'company-standards',
    competencies: ['a5-process'],
    difficulty: 'medium',
    tags: [W1, 'customer-journey'],
    prompt: 'Put the stages of the A5 customer journey in order, from first contact to the end of the project.',
    explanation:
      'Every A5 customer moves through the same stages: the first conversation earns permission for a free inspection; the photo report review lets the homeowner decide with evidence; when a claim is filed we attend the adjuster meeting; then build day; and the project ends with a final walkthrough and warranty registration.',
    draft: ordering([
      'First conversation at the door',
      'Free roof inspection',
      'Review the photo report with the homeowner',
      'Adjuster meeting (when a claim is filed)',
      'Build day',
      'Final walkthrough and warranty registration',
    ]),
  },
  {
    key: 'cs-permission',
    category: 'company-standards',
    competencies: ['ethics-compliance', 'a5-process'],
    difficulty: 'easy',
    tags: [W1, 'inspection', 'code-of-conduct'],
    prompt: 'If a homeowner is not home, it is acceptable to put a ladder up and check the roof for damage as long as you leave a door hanger.',
    explanation:
      'False. Never go onto a property or roof without the homeowner’s explicit permission. It is trespassing, it is a safety risk, and it destroys the trust the rest of the process depends on. Leave a door hanger and come back.',
    draft: tf(false),
  },
  {
    key: 'cs-inspection-notes',
    category: 'company-standards',
    competencies: ['a5-process', 'damage-assessment'],
    difficulty: 'medium',
    tags: [W1, 'inspection', 'documentation'],
    prompt: 'Which of these belong in your notes after every inspection? Select all that apply.',
    explanation:
      'A5 inspection notes record facts the team and the adjuster can rely on: when the inspection happened, dated photos of every slope (overview and close-ups), measurements or a measurement order, and what the homeowner told you. A guess at what the insurer will pay is not a fact, and putting it in writing can read as a promise.',
    draft: ms(
      'partial',
      ['Date and time of the inspection', true],
      ['Dated photos of each slope, including overview shots and close-ups', true],
      ['Roof measurements or the measurement order number', true],
      ['The homeowner’s concerns and questions in their own words', true],
      ['Your estimate of how much the insurance company will pay'],
    ),
  },
  {
    key: 'cs-team-roles',
    category: 'company-standards',
    competencies: ['a5-process'],
    difficulty: 'medium',
    tags: [W1, 'team'],
    prompt: 'Match each A5 role with its main responsibility.',
    explanation:
      'Knowing who does what lets you set honest expectations: you inspect and guide the homeowner, the claims coordinator handles paperwork and supplements with the insurer, the project manager runs build day, and customer care closes out warranties and follow-up.',
    draft: matching([
      ['Sales representative', 'Inspects the roof, documents findings and guides the homeowner through each step'],
      ['Claims coordinator', 'Tracks claim paperwork, supplements and correspondence with the insurer'],
      ['Project manager', 'Schedules the crew and supervises the installation on build day'],
      ['Customer care', 'Registers the warranty and handles follow-up after the build'],
    ]),
  },
  {
    key: 'cs-report-turnaround',
    category: 'company-standards',
    competencies: ['a5-process'],
    difficulty: 'easy',
    tags: [W1, 'photo-report'],
    prompt: 'A5 standard: within how many hours of an inspection must the homeowner receive their photo report? Enter a number.',
    explanation: 'A5 sends every homeowner their photo report within 24 hours of the inspection, whether or not damage was found. Fast, consistent follow-through is part of how we earn trust.',
    draft: { type: 'short_answer', accepted: ['24', '24 hours', 'twenty-four', 'twenty four', 'twenty-four hours'], maxLength: 40 },
    commonMistake: '48',
  },
  {
    key: 'cs-explain-inspection',
    category: 'company-standards',
    competencies: ['a5-process', 'discovery-rapport'],
    difficulty: 'medium',
    points: 3,
    tags: ['inspection', 'written-response'],
    prompt:
      'In your own words, explain to a homeowner what happens during the free A5 inspection, what they will receive afterwards, and why you ask permission before going on the roof.',
    explanation:
      'A strong answer sets clear, honest expectations: the inspection is free with no obligation; you check every slope, flashing, vents and soft metals and photograph what you find; the homeowner gets a dated photo report within 24 hours; you ask permission because it is their property and safety and trust come first; and you never predict what insurance will decide.',
    draft: {
      type: 'long_answer',
      rubric:
        'Award 3 points when the answer covers all of: (1) free and no obligation; (2) what is inspected (all slopes, flashing, vents, soft metals) and that findings are photographed; (3) the photo report within 24 hours; (4) permission is asked because it is their property and for safety/trust. Award 2 points when one element is missing, 1 point for a vague answer. Award 0 if it promises an insurance outcome.',
      sampleAnswer:
        'The inspection is free and there is no obligation. With your permission I will check every slope of the roof, the flashing, vents and pipe boots, and the gutters and other soft metals, and photograph anything I find. Within 24 hours you will get a dated photo report so you can see exactly what I saw and decide what to do. I always ask before going up because it is your home and your roof, and it is a safety issue too. I can tell you what I find, but whether anything is covered is always up to your insurance company.',
      minWords: 40,
      maxWords: 300,
    },
    written: {
      strong:
        'It is completely free and you are not committing to anything. If you are okay with it, I will go up and look at every slope, the flashing and vents, and check the gutters and downspouts for hail dents, taking dated photos as I go. You will have a photo report within 24 hours so you can see what I saw. I ask first because it is your property and getting on a roof is a safety issue. I will not guess at what insurance will do; that is their call.',
      strongFeedback: 'Clear and honest. You covered the free inspection, what you check, the 24-hour report and why you ask permission, without predicting coverage.',
      weak: 'I just go up and take a look around for damage and then we can talk about getting you a new roof paid for by insurance.',
      weakFeedback:
        'Too vague, and it implies insurance will pay. Explain that the inspection is free with no obligation, what you check, the 24-hour photo report, and that you ask permission first.',
    },
  },

  // ------------------------------------------------------------ Compliance
  {
    key: 'co-guarantee',
    category: 'compliance',
    competencies: ['ethics-compliance', 'claims-guidance'],
    difficulty: 'easy',
    tags: [W1, 'never-promise'],
    prompt: 'A homeowner asks: "Can you guarantee my insurance will pay for a new roof?" What is the correct response?',
    explanation:
      'Only the insurance company decides coverage. Promising approval misrepresents your role and sets the homeowner up for disappointment. What you can promise is what you control: thorough documentation and being there when the adjuster inspects.',
    draft: mc(
      ['"I can’t guarantee that; only your insurance company decides coverage. What I can do is document everything and be there when the adjuster inspects."', true],
      ['"Yes. With this much hail damage they always pay."'],
      ['"If they don’t pay, A5 will cover the difference."'],
      ['"I know the adjusters around here, so I’ll make sure it gets approved."'],
    ),
  },
  {
    key: 'co-never-promise',
    category: 'compliance',
    competencies: ['ethics-compliance'],
    difficulty: 'medium',
    tags: ['never-promise', 'deductible'],
    prompt: 'Which of the following must an A5 representative never promise or offer? Select all that apply.',
    explanation:
      'Paying, waiving or rebating a deductible is illegal for contractors in Texas. Promising claim approval misrepresents who decides coverage. Negotiating the claim on the homeowner’s behalf is acting as a public adjuster, which a contractor working on the property may not do. Offering a free inspection and attending the adjuster meeting at the homeowner’s request are normal parts of the A5 process.',
    draft: ms(
      'all_or_nothing',
      ['To pay, waive or rebate any part of the homeowner’s deductible', true],
      ['That the insurance company will approve the claim', true],
      ['To negotiate the claim settlement on the homeowner’s behalf', true],
      ['A free, no-obligation roof inspection'],
      ['To be present at the adjuster’s inspection if the homeowner asks'],
    ),
  },
  {
    key: 'co-deductible-law',
    category: 'compliance',
    competencies: ['ethics-compliance', 'claims-guidance'],
    difficulty: 'medium',
    tags: [W1, 'deductible', 'texas-law'],
    prompt: 'Texas law allows a roofing contractor to waive or rebate a homeowner’s insurance deductible as long as it is disclosed in writing.',
    explanation:
      'False. Texas Insurance Code Chapter 707 prohibits contractors from paying, waiving, rebating or promising to absorb an insured’s deductible, however it is disclosed or advertised. Doing so can expose the homeowner’s claim to a fraud investigation and the contractor to penalties.',
    draft: tf(false),
  },
  {
    key: 'co-neighbor-deductible',
    category: 'compliance',
    competencies: ['ethics-compliance', 'objection-handling'],
    difficulty: 'medium',
    tags: ['deductible', 'texas-law'],
    prompt: 'A homeowner says their neighbor’s roofer offered to "take care of" the deductible. How should you respond?',
    explanation:
      'Stay calm and factual: covering a deductible is illegal for contractors in Texas and puts the homeowner’s claim at risk. Then turn to what you can do, which is to make the real out-of-pocket cost clear up front so there are no surprises.',
    draft: mc(
      ['Explain that A5 can’t do that because covering a deductible is illegal in Texas and can put their claim at risk, then show them their real out-of-pocket cost up front', true],
      ['Offer to match the neighbor’s deal so you don’t lose the job'],
      ['Tell them it’s fine as long as it isn’t written in the contract'],
      ['Suggest asking the insurer to raise the estimate so it covers the deductible'],
    ),
  },
  {
    key: 'co-sign-for-me',
    category: 'compliance',
    competencies: ['ethics-compliance', 'claims-guidance'],
    difficulty: 'hard',
    tags: ['scenario', 'public-adjuster'],
    prompt: 'Read the scenario and choose the best action.',
    explanation:
      'The homeowner owns the claim. A contractor may not act as the homeowner’s public adjuster, negotiate the settlement or sign documents for them. You can support them: share the photo report, attend the adjuster meeting if they ask, and make sure they understand each document before they sign it.',
    draft: {
      type: 'scenario',
      scenario:
        'You are reviewing your photo report with Mrs. Patel at her kitchen table. You found clear hail bruising on three slopes and dents in the gutters. She works long shifts and says: "Honestly, can you just call my insurance company for me, handle the whole thing and sign whatever they need? You know how this works better than I do."',
      sub: {
        kind: 'multiple_choice',
        prompt: 'What do you do?',
        options: [
          ['Explain that she needs to file and manage the claim herself, offer to attend the adjuster’s inspection and share your photo report, and make sure she understands each document before she signs it', true],
          ['Call the insurer as her representative and negotiate the settlement for her'],
          ['Sign the claim form for her using her policy number so she doesn’t lose time'],
          ['Tell her to wait for the next storm so more damage can be included in one claim'],
        ],
      },
    },
  },
  {
    key: 'co-what-never-say',
    category: 'compliance',
    competencies: ['ethics-compliance'],
    difficulty: 'medium',
    tags: ['never-promise', 'written-response'],
    prompt: 'Name one thing a representative must never say about the outcome of an insurance claim, and explain in one sentence why.',
    explanation:
      'Examples: "Your insurance will pay for a new roof", "You won’t pay anything out of pocket", "Your premium won’t go up". Each one promises something only the insurer (or the homeowner’s policy and agent) controls, so it misleads the homeowner.',
    draft: {
      type: 'short_answer',
      grading: 'manual',
      accepted: [],
      maxLength: 300,
      guidance:
        'Full credit when the learner names a claim-outcome promise (approval, a new roof paid for, no out-of-pocket cost, premiums unaffected, deductible covered) AND explains that the insurer or policy decides it, so promising it misleads the homeowner.',
    },
    written: {
      strong: 'Never say "your insurance will pay for a new roof", because only the insurance company decides coverage and promising it misleads the homeowner.',
      strongFeedback: 'Exactly right: a clear example and the reason behind it.',
      weak: 'Don’t talk about insurance at all.',
      weakFeedback: 'We do talk about insurance; we just never promise outcomes. Name a specific promise (for example claim approval) and why it is off limits.',
    },
  },
  {
    key: 'co-canvassing',
    category: 'compliance',
    competencies: ['ethics-compliance', 'a5-process'],
    difficulty: 'easy',
    tags: ['canvassing', 'code-of-conduct'],
    prompt: 'Which statement reflects the A5 Sales Code of Conduct for door-to-door canvassing?',
    explanation:
      'Many cities in our service area require a solicitor permit and limit canvassing hours. A5 representatives carry their permit and badge, respect "No Soliciting" signs, leave when asked, and never imply they were sent by an insurance company or the city.',
    draft: mc(
      ['Respect "No Soliciting" signs and leave right away when a homeowner asks you to', true],
      ['Knock after 9 p.m. if the lights are still on, because people are home'],
      ['Say A5 was sent by the homeowner’s insurance company to inspect the neighborhood'],
      ['Park in the homeowner’s driveway so the A5 truck is visible'],
    ),
  },

  // ------------------------------------------------------------ Roofing Systems
  {
    key: 'rs-underlayment',
    category: 'roofing-systems',
    competencies: ['product-knowledge'],
    difficulty: 'easy',
    tags: [W2, 'components'],
    prompt: 'What is the main job of the underlayment installed beneath the shingles?',
    explanation:
      'Underlayment (synthetic or felt) is a secondary water-resistant barrier over the roof deck. If wind-driven rain or a damaged shingle lets water past the shingles, the underlayment protects the decking. It does not insulate, fasten the shingles or ventilate the attic.',
    draft: mc(
      ['It is a secondary water-resistant barrier that protects the deck if water gets past the shingles', true],
      ['It insulates the attic and lowers cooling costs'],
      ['It holds the shingles to the deck'],
      ['It lets warm air escape from the attic'],
    ),
  },
  {
    key: 'rs-components',
    category: 'roofing-systems',
    competencies: ['product-knowledge'],
    difficulty: 'medium',
    tags: [W2, 'components'],
    prompt: 'Match each roof component with what it does.',
    explanation:
      'Being able to name and explain each component is what makes your photo report credible. Drip edge protects the deck edge and guides water into the gutter; ridge vents exhaust warm, moist air; ice and water shield seals valleys and penetrations; step flashing seals roof-to-wall joints; the starter strip seals the eave edge under the first course.',
    draft: matching([
      ['Drip edge', 'Guides water off the roof edge into the gutter and protects the edge of the deck'],
      ['Ridge vent', 'Lets warm, moist air escape at the peak of the roof'],
      ['Ice and water shield', 'Self-adhering membrane that seals valleys, eaves and penetrations'],
      ['Step flashing', 'Overlapping metal pieces that seal where a roof slope meets a sidewall'],
      ['Starter strip', 'Sealed first course at the eave that backs up the first row of shingles'],
    ]),
  },
  {
    key: 'rs-square',
    category: 'roofing-systems',
    competencies: ['product-knowledge'],
    difficulty: 'easy',
    tags: [W2, 'measurement'],
    prompt: 'Roofs are measured and priced in "squares". How many square feet are in one roofing square? Enter a number.',
    explanation: 'One roofing square is 100 square feet of roof surface. A 2,400 sq ft roof is 24 squares, before waste is added for hips, valleys and starter.',
    draft: { type: 'short_answer', accepted: ['100', '100 sq ft', '100 square feet', 'one hundred', 'one hundred square feet'], maxLength: 40 },
    commonMistake: '10',
  },
  {
    key: 'rs-shingle-types',
    category: 'roofing-systems',
    competencies: ['product-knowledge'],
    difficulty: 'easy',
    tags: ['shingles'],
    prompt: 'Architectural (dimensional) shingles are made in a single flat layer, while three-tab shingles are laminated from two layers.',
    explanation:
      'False; it is the other way around. Three-tab shingles are a single flat layer with cut-outs. Architectural shingles laminate two or more layers, which gives them their dimensional look, more weight and usually higher wind ratings and longer warranties.',
    draft: tf(false),
  },
  {
    key: 'rs-ventilation',
    category: 'roofing-systems',
    competencies: ['product-knowledge'],
    difficulty: 'medium',
    tags: ['ventilation'],
    prompt: 'Why does attic ventilation matter for the life of a shingle roof?',
    explanation:
      'Balanced ventilation (intake at the soffits, exhaust near the ridge) moves heat and moisture out of the attic. Without it, shingles bake from below and age faster, and moisture condenses on the decking and rots it. More exhaust is not automatically better: exhaust without matching intake, or mixing exhaust types, can short-circuit the airflow.',
    draft: mc(
      ['Balanced intake and exhaust remove heat and moisture that would otherwise age the shingles faster and rot the decking', true],
      ['Ventilation keeps hail from damaging the shingles'],
      ['It only matters in cold climates, not in Texas'],
      ['Adding more exhaust vents always extends roof life, whatever the intake'],
    ),
  },
  {
    key: 'rs-poor-ventilation',
    category: 'roofing-systems',
    competencies: ['product-knowledge', 'damage-assessment'],
    difficulty: 'medium',
    tags: ['ventilation', 'inspection'],
    prompt: 'Which of these are signs of poor attic ventilation? Select all that apply.',
    explanation:
      'Trapped heat and moisture show up inside the attic: extreme heat on a sunny day, condensation or frost on the underside of the decking, rusted nail tips and stained or delaminating decking. Granules in the gutters after a storm point to hail or age, and algae streaks come from shade and moisture on the surface, not from attic airflow.',
    draft: ms(
      'partial',
      ['Extreme heat in the attic on a sunny afternoon', true],
      ['Condensation or frost on the underside of the decking', true],
      ['Rusted nail tips and stained or delaminating decking', true],
      ['Granules in the gutters after a hailstorm'],
      ['Black algae streaks on the north slope'],
    ),
  },
  {
    key: 'rs-layers',
    category: 'roofing-systems',
    competencies: ['product-knowledge'],
    difficulty: 'medium',
    tags: ['components'],
    prompt: 'Put these layers of a typical asphalt shingle roof in order, starting from the attic side.',
    explanation: 'From the inside out: rafters or trusses carry the roof; the deck (plywood or OSB sheathing) is fastened to them; underlayment covers the deck; shingles are the outer layer.',
    draft: ordering(['Rafters or trusses', 'Roof deck (plywood or OSB sheathing)', 'Underlayment', 'Asphalt shingles']),
  },
  {
    key: 'rs-pitch',
    category: 'roofing-systems',
    competencies: ['product-knowledge'],
    difficulty: 'medium',
    tags: ['measurement'],
    prompt: 'The homeowner’s roof has a 4/12 pitch. What does that mean?',
    explanation:
      'Pitch is rise over run: a 4/12 roof rises 4 inches for every 12 inches of horizontal distance. Pitch affects which materials are allowed, how much the roof costs to install, and whether steep-slope safety equipment is needed.',
    draft: mc(
      ['The roof rises 4 inches for every 12 inches of horizontal run', true],
      ['The roof rises 12 inches for every 4 inches of horizontal run'],
      ['The roof has 4 layers of shingles across 12 slopes'],
      ['The roof is 4 years into a 12-year warranty'],
    ),
  },
  {
    key: 'rs-tear-off',
    category: 'roofing-systems',
    competencies: ['product-knowledge'],
    difficulty: 'hard',
    tags: ['installation'],
    prompt: 'Why does A5 always tear the old roof off down to the deck instead of laying new shingles over the existing layer?',
    explanation:
      'A full tear-off lets the crew inspect and replace damaged decking, install new underlayment, drip edge and flashing correctly, and keep the manufacturer’s warranty valid. Overlays add weight and trap heat. Building codes can allow a second layer in some cases, so "it is illegal" is not the reason.',
    draft: mc(
      ['It lets the crew find and replace damaged decking, install underlayment and flashing correctly and keep the manufacturer warranty valid', true],
      ['Building codes in Texas prohibit overlays in every case'],
      ['Overlays always cost more than a tear-off'],
      ['Insurance companies never pay for overlays'],
    ),
  },

  // ------------------------------------------------------------ Storm Damage
  {
    key: 'sd-hail-bruise',
    category: 'storm-damage',
    competencies: ['damage-assessment'],
    difficulty: 'easy',
    tags: [W2, 'hail'],
    prompt: 'During an inspection you find dark, roughly circular spots where granules are missing, and the shingle feels soft when you press it. What does this most likely indicate?',
    explanation:
      'That is a hail bruise: the impact displaced the granules and fractured the mat underneath, so it feels soft, like a bruised apple. Normal aging wears evenly, algae shows as streaks, and blisters are raised bubbles rather than soft impact marks.',
    draft: mc(
      ['Hail impact that fractured the shingle mat (a bruise)', true],
      ['Normal aging from sun exposure'],
      ['Algae growth'],
      ['Blistering from trapped moisture'],
    ),
  },
  {
    key: 'sd-granules',
    category: 'storm-damage',
    competencies: ['damage-assessment', 'product-knowledge'],
    difficulty: 'medium',
    tags: [W2, 'granule-loss'],
    prompt: 'After a storm you find shingle granules in the gutters and at the downspout outlets. What do granules actually do for an asphalt shingle?',
    explanation:
      'Granules shield the asphalt from UV light and add fire resistance and color. Once they are gone the exposed asphalt dries out, cracks and ages quickly. That is why granule loss matters: it shortens the roof’s life even before it leaks.',
    draft: mc(
      ['They shield the asphalt from UV light and add fire resistance; without them the asphalt dries out and ages quickly', true],
      ['They are decorative and do not affect performance'],
      ['They bond the shingle to the roof deck'],
      ['They make the underlayment waterproof'],
    ),
  },
  {
    key: 'sd-granule-pattern',
    category: 'storm-damage',
    competencies: ['damage-assessment'],
    difficulty: 'hard',
    tags: ['granule-loss', 'hail'],
    prompt: 'Which pattern of granule loss points to hail rather than normal aging?',
    explanation:
      'Hail leaves random, concentrated impact marks with exposed mat and a soft or fractured shingle underneath, and usually matching dents in soft metals on the same side of the house. Even loss across every slope of an older roof is wear. Loss along the drip edge or under branches has a mechanical cause.',
    draft: mc(
      ['Random, concentrated spots of exposed mat with a soft or fractured shingle underneath, matching dents in soft metals on the same side', true],
      ['Even, gradual loss across every slope of a 20-year-old roof'],
      ['Loss only along the drip edge where the gutters overflow'],
      ['Loss under tree branches that rub against the roof'],
    ),
  },
  {
    key: 'sd-wind',
    category: 'storm-damage',
    competencies: ['damage-assessment'],
    difficulty: 'medium',
    tags: [W2, 'wind'],
    prompt: 'Wind damage typically shows up as creased, lifted or missing shingles, often on the windward side and along edges and ridges.',
    explanation:
      'True. Wind gets under the shingle edge, breaks the seal strip and lifts the tab, leaving a crease line, or tears the tab off. Edges, rakes and ridges on the side facing the storm see the highest uplift.',
    draft: tf(true),
  },
  {
    key: 'sd-soft-metals',
    category: 'storm-damage',
    competencies: ['damage-assessment'],
    difficulty: 'medium',
    tags: [W2, 'collateral'],
    prompt: 'Collateral damage helps confirm hail size and direction. Which of these should you check for hail dents? Select all that apply.',
    explanation:
      'Soft metals and thin fins dent easily and keep a record of the storm: gutters and downspouts, box vents and ridge vent caps, and air-conditioner condenser fins. Granules are not metal, and brick mortar does not dent.',
    draft: ms(
      'partial',
      ['Gutters and downspouts', true],
      ['Box vents and ridge vent caps', true],
      ['Air-conditioner condenser fins', true],
      ['Asphalt shingle granules'],
      ['Brick chimney mortar'],
    ),
  },
  {
    key: 'sd-documentation-order',
    category: 'storm-damage',
    competencies: ['damage-assessment', 'a5-process'],
    difficulty: 'medium',
    tags: ['documentation', 'inspection'],
    prompt: 'Put the steps of documenting storm damage in the order A5 trains.',
    explanation:
      'Start with context (the home and its address), check collateral damage on the ground before you climb, then photograph each slope from a distance, mark and count a test square on each slope, and finish with close-ups of individual hits marked with chalk and a scale reference.',
    draft: ordering([
      'Photograph the front of the home with the address visible',
      'Check and photograph collateral damage at ground level (gutters, downspouts, AC fins)',
      'Photograph each roof slope from a distance',
      'Mark a 10-by-10-foot test square on each slope and count the hits',
      'Take close-ups of individual hits with chalk circles and a measuring reference',
    ]),
  },
  {
    key: 'sd-test-square',
    category: 'storm-damage',
    competencies: ['damage-assessment'],
    difficulty: 'medium',
    tags: ['hail', 'documentation'],
    prompt: 'Adjusters commonly evaluate hail damage by marking a 10-by-10-foot section of each slope and counting the hits inside it. What is that section called?',
    explanation: 'It is a test square: one roofing square (100 sq ft) marked on each slope so hits can be counted consistently. Carriers use the count per test square when deciding what to approve.',
    draft: { type: 'short_answer', accepted: ['test square', 'a test square', 'test squares', '10x10 test square', '10 by 10 test square'], maxLength: 60 },
    commonMistake: 'hail grid',
  },
  {
    key: 'sd-signs',
    category: 'storm-damage',
    competencies: ['damage-assessment'],
    difficulty: 'hard',
    tags: ['hail', 'wind'],
    prompt: 'Match each sign with its most likely cause.',
    explanation:
      'Telling storm damage from wear and defects is what keeps your reports credible with adjusters. Random soft bruises are hail; creased or missing tabs at edges are wind; long black streaks are algae; small popped bubbles are blisters; cracking and curling evenly across the roof is age.',
    draft: matching([
      ['Random circular bruises with soft spots and displaced granules', 'Hail impact'],
      ['Creased tabs and shingles lifted or missing along the edges', 'Wind uplift'],
      ['Long black streaks running down the slope', 'Algae growth'],
      ['Small raised bubbles that pop and leave pits', 'Blistering'],
      ['Cracked, curling shingle edges evenly across the roof', 'Age and weathering'],
    ]),
  },
  {
    key: 'sd-partial-damage',
    category: 'storm-damage',
    competencies: ['damage-assessment', 'claims-guidance'],
    difficulty: 'hard',
    tags: ['scenario', 'hail'],
    prompt: 'Read the scenario and choose the best response.',
    explanation:
      'Report what you found, slope by slope, with photos, and be clear about who decides what. Whether an insurer approves individual slopes or a full replacement depends on the damage, the policy and the carrier. Promising a full replacement, or talking the homeowner out of a claim, both overstep your role.',
    draft: {
      type: 'scenario',
      scenario:
        'After last Tuesday’s hailstorm you inspect the Nguyen family’s roof. The two west-facing slopes have 10 to 14 hits per test square; the two east-facing slopes have 2 or 3. Mr. Nguyen looks at your photos and asks: "So I need a whole new roof, right?"',
      sub: {
        kind: 'multiple_choice',
        prompt: 'What is the best response?',
        options: [
          ['Walk him through what you found on each slope with the photos, and explain that the adjuster decides what is covered; some carriers approve individual slopes, others a full replacement', true],
          ['"Yes, definitely. The insurance company will replace the whole roof."'],
          ['"Only two slopes are damaged, so it is not worth filing a claim."'],
          ['"Let’s wait a year and see whether it starts leaking."'],
        ],
      },
    },
  },

  // ------------------------------------------------------------ Insurance Process
  {
    key: 'ip-deductible',
    category: 'insurance-process',
    competencies: ['claims-guidance'],
    difficulty: 'easy',
    tags: [W2, 'deductible'],
    prompt: 'How does a homeowner’s deductible work on a roof claim?',
    explanation:
      'The deductible is the share of a covered loss the homeowner pays; the insurer pays the covered amount above it. It is not a fee to the adjuster, it is not refunded at the end, and by law the contractor may not pay or waive it.',
    draft: mc(
      ['It is the part of the covered loss the homeowner pays; the insurer pays the covered amount above it', true],
      ['It is a fee the homeowner pays the adjuster for the inspection'],
      ['It is refunded to the homeowner when the job is finished'],
      ['The contractor pays it when the homeowner cannot'],
    ),
  },
  {
    key: 'ip-recoverable-depreciation',
    category: 'insurance-process',
    competencies: ['claims-guidance'],
    difficulty: 'medium',
    tags: [W2, 'depreciation'],
    prompt: 'On a replacement cost policy, what does "recoverable depreciation" mean?',
    explanation:
      'The insurer first pays the actual cash value (replacement cost minus depreciation, less the deductible). The depreciation it held back is "recoverable": it is released after the work is completed and the final invoice is submitted. On an actual cash value policy the depreciation is not recoverable.',
    draft: mc(
      ['Depreciation the insurer holds back from the first check and releases once the work is completed and the final invoice is submitted', true],
      ['Money the homeowner loses permanently because the roof is old'],
      ['A discount the contractor gives for paying in cash'],
      ['The deductible, which the insurer returns at the end of the job'],
    ),
  },
  {
    key: 'ip-rcv',
    category: 'insurance-process',
    competencies: ['claims-guidance'],
    difficulty: 'easy',
    tags: ['depreciation'],
    prompt: 'What do the letters RCV stand for on an insurance estimate?',
    explanation: 'RCV is replacement cost value: what it costs to replace the damaged items with new materials of like kind and quality, before depreciation is subtracted.',
    draft: { type: 'short_answer', accepted: ['replacement cost value', 'replacement cost', 'replacement cost valuation'], maxLength: 80 },
    commonMistake: 'roof coverage value',
  },
  {
    key: 'ip-terms',
    category: 'insurance-process',
    competencies: ['claims-guidance'],
    difficulty: 'medium',
    tags: ['depreciation', 'supplement'],
    prompt: 'Match each insurance term with its meaning.',
    explanation:
      'These five terms come up in every claim conversation. If you can explain them simply, homeowners understand their paperwork and trust your guidance.',
    draft: matching([
      ['ACV', 'Replacement cost minus depreciation; usually the basis of the first check'],
      ['RCV', 'Full cost to replace damaged items with new materials of like kind and quality'],
      ['Deductible', 'The share of a covered loss the homeowner pays'],
      ['Supplement', 'A request to add items the original estimate missed'],
      ['Scope of loss', 'The adjuster’s itemized list of damaged items and covered repairs'],
    ]),
  },
  {
    key: 'ip-claim-steps',
    category: 'insurance-process',
    competencies: ['claims-guidance', 'a5-process'],
    difficulty: 'medium',
    tags: [W2, 'claim-process'],
    prompt: 'Put the typical steps of a homeowner roof claim in order.',
    explanation:
      'The homeowner files the claim, the adjuster inspects, the insurer issues the scope of loss with the first (actual cash value) payment, the roof is replaced, and the final invoice releases the recoverable depreciation.',
    draft: ordering([
      'Homeowner reports the claim to their insurance company',
      'Adjuster inspects the property',
      'Insurer issues the scope of loss and the first (ACV) payment',
      'The roof is replaced',
      'Final invoice is submitted and recoverable depreciation is released',
    ]),
  },
  {
    key: 'ip-supplement',
    category: 'insurance-process',
    competencies: ['claims-guidance'],
    difficulty: 'medium',
    tags: ['supplement'],
    prompt:
      'If the adjuster’s estimate leaves out items required to do the job correctly, such as drip edge required by code, the homeowner can request a supplement and A5 provides the supporting documentation.',
    explanation:
      'True. Supplements are a normal part of the process. A5 supplies the evidence (photos, measurements, code requirements, manufacturer instructions); the insurer decides. Representatives never inflate a supplement or add items that were not damaged or required.',
    draft: tf(true),
  },
  {
    key: 'ip-first-check',
    category: 'insurance-process',
    competencies: ['claims-guidance'],
    difficulty: 'hard',
    tags: ['depreciation', 'deductible', 'math'],
    prompt:
      'A homeowner with a $2,000 deductible receives an estimate with a replacement cost value of $18,000 and $5,000 of recoverable depreciation. Assuming no mortgage company is named, how much is the first check?',
    explanation:
      'ACV = RCV − depreciation = $18,000 − $5,000 = $13,000. The first check is ACV minus the deductible: $13,000 − $2,000 = $11,000. The $5,000 of recoverable depreciation is released after the work is completed and invoiced.',
    draft: mc(['$11,000', true], ['$13,000'], ['$16,000'], ['$18,000']),
  },
  {
    key: 'ip-mortgage',
    category: 'insurance-process',
    competencies: ['claims-guidance'],
    difficulty: 'medium',
    tags: ['payments'],
    prompt: 'Why is the mortgage company often named on the insurance check?',
    explanation:
      'The lender has a financial interest in the property and is listed on the policy as a loss payee, so it must endorse the check. Mortgage companies often hold the funds and release them in stages, which affects project timing. That is why we ask about the mortgage early.',
    draft: mc(
      ['The lender has a financial interest in the home and is listed on the policy, so it must endorse the check', true],
      ['The mortgage company pays the deductible'],
      ['The roofing contractor asks the insurer to add it'],
      ['A claim automatically raises the mortgage rate'],
    ),
  },
  {
    key: 'ip-explain-payments',
    category: 'insurance-process',
    competencies: ['claims-guidance', 'discovery-rapport'],
    difficulty: 'hard',
    points: 3,
    tags: ['depreciation', 'deductible', 'written-response'],
    prompt:
      'A homeowner asks: "Why did my insurance company only send me part of the money?" Write the explanation you would give. Cover actual cash value, recoverable depreciation, the deductible and what happens after the roof is replaced.',
    explanation:
      'A strong answer explains, in plain language, that the first check is the actual cash value (replacement cost minus depreciation) minus the deductible; that the held-back depreciation is recoverable on a replacement cost policy and is released after the work is completed and invoiced; and that the deductible is the homeowner’s share, which A5 cannot cover.',
    draft: {
      type: 'long_answer',
      rubric:
        'Award 3 points when the answer correctly explains: (1) the first check is ACV (replacement cost minus depreciation) minus the deductible; (2) recoverable depreciation is released after the work is completed and the final invoice is submitted; (3) the deductible is the homeowner’s share and the contractor cannot cover it. Plain language matters. Award 2 points if one element is missing or slightly inaccurate, 1 point if only one element is right. Award 0 for any promise about the final payout.',
      sampleAnswer:
        'Your policy pays in two parts. The first check is the actual cash value: the cost to replace the roof minus depreciation for its age, and minus your deductible, which is your share of the claim. The depreciation they held back is recoverable on your policy, so once the roof is replaced we send the final invoice and the insurer releases that money. The deductible is the one part you pay, and by law we cannot cover it for you.',
      minWords: 40,
      maxWords: 300,
    },
    written: {
      strong:
        'The insurance company pays in two steps. The first check is the actual cash value, which is the full replacement cost minus depreciation for the roof’s age, and then minus your deductible. Because you have a replacement cost policy, the depreciation they held back is recoverable: once the new roof is installed we send them the final invoice and they release the rest. Your deductible is your share of the claim, and we are not allowed to cover it.',
      strongFeedback: 'Accurate and easy to follow: ACV, deductible, recoverable depreciation and the final invoice are all explained in plain language.',
      weak: 'They always hold some money back but you will get it all at the end, so don’t worry about it.',
      weakFeedback:
        'This promises a payout and skips the explanation. Walk through actual cash value, the deductible and how recoverable depreciation is released after the final invoice.',
    },
  },
  {
    key: 'ip-depreciation-release',
    category: 'insurance-process',
    competencies: ['claims-guidance'],
    difficulty: 'hard',
    tags: ['depreciation'],
    prompt: 'Which items are typically needed to release recoverable depreciation? Select all that apply.',
    explanation:
      'Insurers release recoverable depreciation when they can see the work was done: the contractor’s final invoice and proof of completion such as completion photos or a certificate of completion. A second roofer’s report and the mortgage statement are not part of it, and a receipt showing the contractor paid the deductible would be evidence of an illegal practice.',
    draft: ms(
      'all_or_nothing',
      ['The contractor’s final invoice', true],
      ['Proof the work is completed, such as completion photos or a certificate of completion', true],
      ['An inspection report from a second roofing company'],
      ['The homeowner’s mortgage statement'],
      ['A receipt showing the contractor paid the deductible'],
    ),
  },

  // ------------------------------------------------------------ Sales Conversation
  {
    key: 'sc-first-30',
    category: 'sales-conversation',
    competencies: ['discovery-rapport'],
    difficulty: 'easy',
    tags: [W3, 'opening'],
    prompt: 'What is the goal of the first 30 seconds at the door?',
    explanation:
      'The opening has one job: earn the next few minutes. Introduce yourself and A5, give an honest, specific reason for stopping by (for example, last week’s hail in the neighborhood), and ask permission to continue. Pitching products, pushing a signature or promising insurance money loses trust immediately.',
    draft: mc(
      ['Introduce yourself and A5, give an honest reason for stopping by and earn permission to continue the conversation', true],
      ['Get an inspection agreement signed before the homeowner starts asking questions'],
      ['Explain every roofing product A5 installs'],
      ['Mention that their insurance will pay for a new roof'],
    ),
  },
  {
    key: 'sc-open-questions',
    category: 'sales-conversation',
    competencies: ['discovery-rapport'],
    difficulty: 'medium',
    tags: [W3, 'discovery'],
    prompt: 'Which of these are open-ended discovery questions? Select all that apply.',
    explanation:
      'Open-ended questions invite the homeowner to talk and reveal what matters to them: what they have noticed, their plans for the home, what a good experience looks like. Yes/no questions ("Do you want…", "Is your roof…") end the conversation instead of opening it.',
    draft: ms(
      'partial',
      ['"What have you noticed about your roof since the storm last week?"', true],
      ['"How long are you planning to stay in this home?"', true],
      ['"What would a good roofing experience look like for you?"', true],
      ['"Do you want a free inspection?"'],
      ['"Is your roof more than ten years old?"'],
    ),
  },
  {
    key: 'sc-talk-ratio',
    category: 'sales-conversation',
    competencies: ['discovery-rapport'],
    difficulty: 'easy',
    tags: [W3, 'discovery'],
    prompt: 'Talking more than the homeowner during discovery is a sign the conversation is going well.',
    explanation:
      'False. In discovery the homeowner should do most of the talking. Ask open questions, listen, and follow up on what they say. If you are talking more, you are pitching, and you are not learning what matters to them.',
    draft: tf(false),
  },
  {
    key: 'sc-conversation-flow',
    category: 'sales-conversation',
    competencies: ['discovery-rapport', 'a5-process'],
    difficulty: 'medium',
    tags: [W3, 'conversation-flow'],
    prompt: 'Put the parts of the A5 sales conversation in order.',
    explanation:
      'Each step earns the next: introduce yourself and why you are there, ask discovery questions, inspect and document, review the findings with photos, explain the options and next steps, and only then confirm a commitment and schedule.',
    draft: ordering([
      'Introduction and reason for the visit',
      'Discovery questions',
      'Inspection and documentation',
      'Review the findings with photos',
      'Explain the options and next steps',
      'Confirm the commitment and schedule',
    ]),
  },
  {
    key: 'sc-selling-home',
    category: 'sales-conversation',
    competencies: ['discovery-rapport'],
    difficulty: 'medium',
    tags: [W3, 'discovery'],
    prompt: 'During discovery a homeowner mentions they plan to sell the house next spring. What is the best follow-up?',
    explanation:
      'A comment like this is a motivation you should explore, not skip. Ask how the roof’s condition might affect the sale and what matters most to them, then tailor the inspection review around it. Claiming a new roof "always pays for itself" is a promise you cannot back up.',
    draft: mc(
      ['Ask how the roof’s condition might affect the sale and what matters most to them, then tailor what you show around that', true],
      ['Tell them a new roof always pays for itself when the house sells'],
      ['Skip the inspection, since they are moving anyway'],
      ['Offer the cheapest option straight away'],
    ),
  },
  {
    key: 'sc-check-understanding',
    category: 'sales-conversation',
    competencies: ['discovery-rapport'],
    difficulty: 'easy',
    tags: ['closing'],
    prompt: 'Which question best confirms the homeowner’s understanding before you move to next steps?',
    explanation:
      'Inviting questions ("what questions do you have…") checks understanding without pressure and surfaces concerns early. Leading questions and asking for a signature first do the opposite, and "Does that make sense?" followed by moving on rarely gets an honest answer.',
    draft: mc(
      ['"Before we talk about next steps, what questions do you have about what we found?"', true],
      ['"You want to get this taken care of, right?"'],
      ['"Can you sign here so we can get started?"'],
      ['"Does that make sense?" and moving straight on'],
    ),
  },
  {
    key: 'sc-discovery-written',
    category: 'sales-conversation',
    competencies: ['discovery-rapport'],
    difficulty: 'medium',
    points: 3,
    tags: ['discovery', 'written-response'],
    prompt: 'Write three discovery questions you would ask a homeowner after a hailstorm. For each one, explain what you are trying to learn.',
    explanation:
      'Good discovery questions are open-ended and purposeful: what the homeowner has noticed (damage and urgency), their history with the roof and insurance (age, past claims, previous contractors) and their plans and priorities (how long they will stay, budget, what a good experience looks like).',
    draft: {
      type: 'long_answer',
      rubric:
        'Award 1 point per question that is open-ended AND comes with a clear purpose (up to 3). Deduct nothing for wording; deduct a point for any question that pressures, promises an insurance outcome or is a yes/no question.',
      sampleAnswer:
        '1. "What have you noticed around the house since the storm?" to learn what damage they have seen and how urgent it feels to them. 2. "How long have you had this roof, and have you ever had work done on it or filed a claim?" to understand its age and history before I inspect. 3. "What matters most to you in choosing a roofer?" to learn their priorities (price, timing, warranty, trust) so I focus on what they care about.',
      minWords: 40,
      maxWords: 350,
    },
    written: {
      strong:
        'First: "What have you noticed around the house since Tuesday’s storm?" to find out what damage they have seen and how worried they are. Second: "How old is the roof, and has anyone worked on it before?" to learn its history and whether there were past claims or repairs. Third: "If you do need work, what would make it a good experience for you?" so I understand their priorities, like timing, cost or the warranty.',
      strongFeedback: 'Three open questions, each with a clear purpose. Strong discovery.',
      weak: 'Do you want a new roof? Do you have insurance? Can I get on the roof?',
      weakFeedback: 'These are all yes/no questions without a purpose. Rewrite them as open questions and say what each one helps you learn.',
    },
  },
  {
    key: 'sc-busy-opening',
    category: 'sales-conversation',
    competencies: ['discovery-rapport', 'objection-handling'],
    difficulty: 'hard',
    points: 2,
    tags: ['opening', 'scenario', 'written-response'],
    prompt: 'Read the scenario and write your response.',
    explanation:
      'A strong opening respects the homeowner’s time, gives a specific and honest reason for the visit, and offers a low-pressure next step, such as a scheduled inspection at a better time or leaving a door hanger with photos of neighborhood damage.',
    draft: {
      type: 'scenario',
      scenario:
        'It is 5:40 p.m. on a weekday, three days after a hailstorm moved through the neighborhood. A homeowner opens the door holding a toddler, with dinner cooking behind her. Before you finish your name she says: "I’ve only got a minute."',
      sub: {
        kind: 'open_response',
        prompt: 'Write exactly what you would say in the next 30 seconds.',
        rubric:
          'Award 2 points when the response acknowledges her time, gives a specific honest reason (the recent hailstorm), and offers a low-pressure next step (schedule a time, leave information). Award 1 point when one element is missing. Award 0 for pressure, a pitch, or any promise about insurance.',
        sampleAnswer:
          'Totally understand, I’ll be quick. I’m with A5 Roofing; we’ve been checking homes on this street after Tuesday’s hail, and a few neighbors had dented gutters and roof damage. I don’t want to keep you from dinner. Could I come back for a free 20-minute inspection at a better time, maybe Saturday morning? I’ll leave my card with a photo of what we’re seeing on the street.',
        maxLength: 1200,
      },
    },
    written: {
      strong:
        'No problem, I will keep it short. I’m with A5 Roofing, and we have been helping neighbors on this street check their roofs after Tuesday’s hail. I don’t want to hold you up, so could I come back Saturday for a free inspection? I’ll leave my card so you know who I am.',
      strongFeedback: 'Respectful of her time, specific about the hail, and an easy next step. Well done.',
      weak: 'This will only take a minute. Your roof probably has hail damage and insurance will pay for a new one, so let me go up there now.',
      weakFeedback: 'This pressures her and promises an insurance outcome. Acknowledge her time, mention the storm honestly and offer to come back.',
    },
  },

  // ------------------------------------------------------------ Objection Handling
  {
    key: 'oh-framework',
    category: 'objection-handling',
    competencies: ['objection-handling'],
    difficulty: 'easy',
    tags: [W3, 'framework'],
    prompt: 'Put the steps of the A5 Objection Framework in order.',
    explanation:
      'Listen fully without interrupting, acknowledge the concern, ask a clarifying question to find the real issue, respond with facts that address that issue, then confirm and agree on a next step. Skipping straight to the response is the most common mistake.',
    draft: ordering([
      'Listen fully without interrupting',
      'Acknowledge the concern',
      'Ask a clarifying question',
      'Respond with facts that address the real concern',
      'Confirm and agree on a next step',
    ]),
  },
  {
    key: 'oh-three-estimates',
    category: 'objection-handling',
    competencies: ['objection-handling'],
    difficulty: 'medium',
    tags: [W3, 'estimates'],
    prompt: 'A homeowner says: "I want to get three estimates." Which response best follows the A5 Objection Framework?',
    explanation:
      'Comparing estimates is reasonable. Acknowledge it, ask what they will compare, and make the comparison easy with an itemized scope. Running down competitors, discount pressure or giving up without a next step all break the framework.',
    draft: mc(
      ['"That makes sense; it’s a big decision. What will you be comparing between the estimates?" then offer an itemized scope that makes comparing easy', true],
      ['"Other roofers will just cut corners; you don’t need other estimates."'],
      ['"If you sign today I can give you a discount."'],
      ['"Okay, here’s my card," and leave'],
    ),
  },
  {
    key: 'oh-spouse',
    category: 'objection-handling',
    competencies: ['objection-handling'],
    difficulty: 'medium',
    tags: [W3, 'decision-maker'],
    prompt: 'A homeowner says: "I need to talk to my spouse." What is the best response?',
    explanation:
      'It is a shared decision, so treat it as one: agree, ask what questions their spouse is likely to have, and offer a time to walk both of them through the photos. "Sign now and cancel later" and false deadlines are pressure tactics.',
    draft: mc(
      ['Agree it’s a joint decision, ask what questions their spouse is likely to have, and offer a time to walk both of them through the photos', true],
      ['Ask them to sign now and cancel later if their spouse disagrees'],
      ['Say the price is only good today'],
      ['Leave without scheduling anything'],
    ),
  },
  {
    key: 'oh-first-step',
    category: 'objection-handling',
    competencies: ['objection-handling'],
    difficulty: 'easy',
    tags: [W3, 'framework'],
    prompt: 'When a homeowner raises an objection, the first step in the A5 framework is to respond immediately with facts that prove them wrong.',
    explanation:
      'False. The first step is to listen fully, then acknowledge the concern. Jumping to facts before you understand the real concern feels like an argument, and the homeowner stops listening.',
    draft: tf(false),
  },
  {
    key: 'oh-cheaper',
    category: 'objection-handling',
    competencies: ['objection-handling'],
    difficulty: 'hard',
    tags: ['price'],
    prompt: 'A homeowner says: "Another roofer is cheaper." Which clarifying question best uncovers the real concern?',
    explanation:
      'Price differences usually come from scope: tear-off versus overlay, underlayment, flashing, ventilation, warranty. Asking what was included turns a price objection into a comparison of value. Attacking the competitor or instantly matching the price does not address the concern.',
    draft: mc(
      ['"When you compared the two, what did theirs include: tear-off, underlayment, flashing, ventilation and warranty?"', true],
      ['"Did they tell you they’re not even a real roofing company?"'],
      ['"How much cheaper? I’ll beat it."'],
      ['"Do you really want the cheapest roof on your house?"'],
    ),
  },
  {
    key: 'oh-hidden-concerns',
    category: 'objection-handling',
    competencies: ['objection-handling', 'discovery-rapport'],
    difficulty: 'medium',
    tags: [W3, 'framework'],
    prompt: 'Match each objection with the concern it most often hides.',
    explanation:
      'Objections are rarely about what they say on the surface. Clarifying questions help you find the concern underneath, and that is what your response needs to address.',
    draft: matching([
      ['"I don’t have time."', 'Not yet convinced the conversation is worth their time'],
      ['"I want three estimates."', 'Wants confidence they are getting fair value'],
      ['"I need to talk to my spouse."', 'It is a shared decision and they want their partner’s input'],
      ['"I don’t want to file a claim."', 'Worried about premiums, the policy or the hassle'],
      ['"My roof looks fine."', 'Cannot see damage from the ground, so sees no need'],
    ]),
  },
  {
    key: 'oh-no-claim',
    category: 'objection-handling',
    competencies: ['objection-handling', 'claims-guidance', 'ethics-compliance'],
    difficulty: 'hard',
    tags: ['scenario', 'insurance'],
    prompt: 'Read the scenario and choose the best response.',
    explanation:
      'Acknowledge the worry, clarify what he has heard, and give accurate information within your role: how a weather claim affects his rates depends on his insurer and policy, so his agent is the right person to ask. Leave the decision with him. Promising that premiums will not rise, offering a "deductible-only" repair, or claiming a legal duty to file are all misleading.',
    draft: {
      type: 'scenario',
      scenario:
        'Mr. and Mrs. Alvarez had hail three weeks ago. Your inspection found bruising on all four slopes and dented gutters, and you have just shown them the photo report. Mr. Alvarez crosses his arms: "I don’t want to file a claim. My premium will go up and they’ll drop us."',
      sub: {
        kind: 'multiple_choice',
        prompt: 'Which response best follows the A5 Objection Framework?',
        options: [
          ['Acknowledge the worry, ask what he has heard, explain that how a weather claim affects his rates depends on his insurer and policy so his agent can answer that, and leave the photo report so they can decide', true],
          ['Tell him his premium definitely will not go up after a hail claim'],
          ['Offer to repair the roof for the cost of the deductible so he doesn’t need to file'],
          ['Tell him he is legally required to file a claim for storm damage'],
        ],
      },
    },
  },
  {
    key: 'oh-acknowledge',
    category: 'objection-handling',
    competencies: ['objection-handling'],
    difficulty: 'easy',
    tags: ['framework'],
    prompt: 'Which of these is an example of acknowledging an objection?',
    explanation:
      'Acknowledging shows you heard the concern and take it seriously; it is not agreeing or arguing. Dismissing it ("that’s not a good reason", "everyone says that") or contradicting it shuts the conversation down.',
    draft: mc(
      ['"I hear you; your time matters, and I’ll keep this short."', true],
      ['"That’s not really a good reason."'],
      ['"Everyone says that."'],
      ['"Let me tell you why you’re wrong."'],
    ),
  },
];
