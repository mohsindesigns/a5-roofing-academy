import type { SCENARIOS } from '@a5/seed-data';
import type { EndReason } from '../../database/schema.js';

type ScenarioKey = (typeof SCENARIOS)[number]['key'];

export interface TranscriptVariant {
  key: string;
  scenario: ScenarioKey;
  /** Inclusive range of journey scores this conversation represents. */
  band: readonly [number, number];
  endReason: EndReason;
  /**
   * Alternating lines starting with the representative and ending with the homeowner's last reply
   * (the homeowner's opening line comes from the scenario). `{rep}` is the learner's first name.
   */
  lines: readonly string[];
}

/**
 * Realistic practice conversations, written by hand so each scenario reads differently and the
 * quality of the conversation matches the score it receives. Seeded sessions are scored by the
 * development simulator's evaluator (quotes in the scorecards are real lines from these texts).
 */
export const TRANSCRIPTS: readonly TranscriptVariant[] = [
  // ------------------------------------------------------------------ no-time
  {
    key: 'no-time-strong',
    scenario: 'no-time',
    band: [87, 100],
    endReason: 'objective_reached',
    lines: [
      "Hi, I'm {rep} with A5 Roofing. I can see you're on your way out, so I'll be quick. Is it okay if I take thirty seconds?",
      'Thirty seconds. Go ahead.',
      "Thank you. We're checking roofs on this street after the April 14th hailstorm, and rather than guess, what have you noticed on your roof or ceilings since that storm?",
      "Honestly? There's a brown stain in my hall closet and I keep finding gritty granules in the gutter. But the last roofing salesman sat at my kitchen table for two hours and wouldn't leave until I agreed to think about signing. I swore I'd never do that again.",
      "That makes sense, and I'm not going to do that to you. It sounds like the stain and the granules are worth a quick look, though. Other than the time, is there anything else that would keep you from letting someone check?",
      "No, it's really just the time. And I'm not signing anything.",
      "Understood, there's nothing to sign. The exterior inspection takes about fifteen minutes, you don't need to be home for the roof walk, and I photograph everything so you keep the pictures whether or not you ever call us again. Would Thursday at 6 p.m. work, after your son's practice?",
      'Thursday at 6? What happens if you find something?',
      "Then I show you the photos and explain what they mean in plain English. You decide what happens next, and you never owe us anything for the inspection. I can text you when I'm ten minutes out so you're not waiting around.",
      'Okay. Thursday at 6 works for me. Text me first, and keep it short.',
    ],
  },
  {
    key: 'no-time-solid-a',
    scenario: 'no-time',
    band: [80, 81],
    endReason: 'objective_reached',
    lines: [
      "Hi there, I'm {rep} with A5 Roofing. I know you're busy, so I'll only take a minute.",
      'A minute. What is it?',
      "We're talking to homeowners on this street about the hail from April. What have you noticed on the roof since the storm?",
      "Nothing, really. I haven't had time to look. I've noticed some gritty stuff in the gutter, but that's it.",
      "I appreciate you telling me that. It sounds like the gutter is the one thing you've noticed, and granules can mean the shingles took some hail. We offer a free exterior inspection, about fifteen minutes, and you keep the photos. Other than the time, is there anything else that would keep you from letting someone look?",
      "No, just the time. I'm not up for a long thing. The last guy sat at my table for hours.",
      "That makes sense, and I won't do that. No paperwork, no pitch. I'd walk the roof, take pictures and leave. Could I come by Thursday around 6?",
      "Thursday at 6 could work. I'm back from practice by then. Okay, fine, Thursday at 6.",
    ],
  },
  {
    key: 'no-time-solid-b',
    scenario: 'no-time',
    band: [82, 86],
    endReason: 'objective_reached',
    lines: [
      "Good evening, I'm {rep} with A5 Roofing. I just finished with your neighbors at the end of the block and saw you heading out. Can I leave you with one quick question?",
      'One. I really am leaving.',
      "Thank you. Since the April hailstorm, what's the one thing you've noticed about your roof or ceiling that you haven't had time to deal with?",
      "Ha. The hall closet ceiling has a stain I keep ignoring. And I've been finding granules in the gutter. But I don't want anyone sitting at my table for two hours trying to get me to sign something.",
      "Fair enough, I wouldn't want that either. It sounds like you want the stain checked without the sales pressure. We can do an exterior-only inspection in about fifteen minutes, with photos you keep and nothing to sign. If it looks fine, you've lost nothing.",
      'That sounds okay. But when? My evenings are baseball.',
      'Would Thursday at 6 work, or would Saturday morning be easier with practice?',
      'Saturday morning is better. Maybe 9:30? Will it be a sales pitch?',
      "Saturday at 9:30, then. No pitch: I walk the roof, photograph it and leave. Other than the pitch, is there anything else that worries you about it? I'll text you the day before so it's no surprise.",
      'Okay. Saturday at 9:30. And no speeches.',
    ],
  },
  {
    key: 'no-time-weak',
    scenario: 'no-time',
    band: [70, 79],
    endReason: 'objective_reached',
    lines: [
      "Hi! I'm {rep} with A5 Roofing. We're one of the biggest roofers in the Dallas area and we've helped thousands of homeowners with storm damage for years. There was a big hailstorm in April and a lot of roofs on this street were damaged, so I wanted to stop by and let you know about our free inspections and what we can do for you.",
      "I really don't have time. I have to go.",
      "I totally understand, um, it only takes a minute. We do the whole thing for you, and I think you'd be surprised what we find up there. Do you have any damage on your roof?",
      "I don't know. I haven't looked. There's a stain in the closet, maybe, but I'm in a hurry.",
      'A stain could be a leak, which is worth checking. We offer a free exterior inspection, about fifteen minutes, with photos you keep and nothing to sign. Maybe I could come back this week?',
      'Thursday around 6, I guess. But it has to be quick.',
      "Great, Thursday at 6 it is! I'll bring everything we need, and I'll explain all of our services and what the insurance process looks like when I get there.",
      'Fine. Just text me first.',
    ],
  },

  // ------------------------------------------------------------------ spouse
  {
    key: 'spouse-strong',
    scenario: 'spouse',
    band: [87, 100],
    endReason: 'objective_reached',
    lines: [
      "Hi, I'm {rep} with A5 Roofing, and thank you for coming to the door. Talking it over with your husband is exactly the right instinct for something like a roof. How do the two of you usually handle decisions about the house?",
      "Oh, we always decide together. Mike did the last roof, actually, and it didn't go well. The roofer he hired took a deposit and then never came back, so Mike is particular about who we let near the house now. I wouldn't want to decide anything without him.",
      "I'm sorry that happened to you both. That's a hard way to lose money and trust. It sounds like what matters most to Mike is that anyone who does work is legitimate and actually shows up. Is that fair?",
      "That's exactly it. And I did find some pieces of shingle in the flower bed after that storm, but I haven't said anything because I didn't want Mike to feel like I was going behind his back.",
      "Thank you for telling me, that helps. Here's what I'd suggest: no deposit, no paperwork and nothing decided tonight. A free twenty-minute inspection when you're both home, so Mike can see the photos with you and ask me anything about our license, insurance, references and warranty. Is there anything else that would make him more comfortable?",
      'I think seeing it in person would help. Can he ask for references?',
      "Absolutely, and I'd encourage it. I'll bring our license and insurance information and two references from this area. Would Thursday at 6:30 work for the two of you?",
      'Let me check with him. Mike! ... He says Thursday at 6:30 is fine. Thank you for not pushing us.',
      "That's the way it should be. I'll text you a reminder Wednesday evening, and I'll see you both Thursday.",
      "Perfect. We'll see you Thursday at 6:30. Mike will have his questions ready.",
    ],
  },
  {
    key: 'spouse-solid-a',
    scenario: 'spouse',
    band: [80, 81],
    endReason: 'objective_reached',
    lines: [
      "Hi, I'm {rep} with A5 Roofing. Totally understand wanting to include your husband. What does he usually want to know before anyone works on the house?",
      "Oh, he's very careful with money. The last roofer we had was a mess. He took a deposit and we never saw him again, so Mike doesn't trust contractors now.",
      "I understand, that would make anyone careful. It sounds like what matters to Mike is knowing a contractor is legitimate before anyone touches the house. We don't ask for any money for the inspection and nothing needs to be signed. It's about twenty minutes, with photos. Other than that, is there anything else Mike would want to know first?",
      "I think he'd want to see everything himself, honestly. And be there when you do it.",
      "Then let's do it when you're both home. Could I come by Thursday around 6:30?",
      "Thursday at 6:30 is fine. I'll tell him you're coming. Thank you for not being pushy.",
      "I appreciate that. I'll bring our license and insurance information so he can look at it before we start.",
      "He'll like that. See you Thursday!",
    ],
  },
  {
    key: 'spouse-solid-b',
    scenario: 'spouse',
    band: [82, 86],
    endReason: 'objective_reached',
    lines: [
      "Hi, I'm {rep} with A5 Roofing, and I'm glad you said that. A roof is a decision for both of you. Can I ask what questions Mike would have if I were standing here?",
      "Oh gosh. He'd ask who you are and if you're licensed. And he'd ask what it costs. We had a bad experience with a roofer who took our deposit and disappeared.",
      "I'm sorry to hear that. It sounds like Mike wants to be sure a company is real and will finish the job. We're licensed and insured, and I'm happy to show you both. The inspection itself is free, about twenty minutes, and you keep the photos.",
      "That's good. But I'd really want him here.",
      "Of course. You mentioned you found something in the flower bed after the storm. Would you be more comfortable if we looked at the roof together when Mike's home?",
      "Yes, I would. He's usually home by 6.",
      'Other than timing, is there anything else that would keep you two from looking at it together? Would Thursday at 6:30 work?',
      "Thursday works. I'll put it on the calendar, and I'll have Mike write his questions down.",
      "Wonderful. I'll bring our license, insurance and a couple of references so he has what he needs.",
      "He'll appreciate that. See you Thursday!",
    ],
  },
  {
    key: 'spouse-weak',
    scenario: 'spouse',
    band: [60, 74],
    endReason: 'objective_reached',
    lines: [
      "Hi, I'm {rep} with A5 Roofing, and thank you for coming to the door. It's smart to include your husband. How do you two usually decide things about the house?",
      "Oh, together, always. Mike did our last roof, actually, and it didn't go well. The roofer he hired took a deposit and then never came back, so he's particular about who we let near the house. I wouldn't want to decide anything without him.",
      "I'm sorry that happened to you both. It sounds like what matters most to Mike is that a company is legitimate and actually shows up. Don't worry about the cost, honestly. Most of the time insurance will pay for the whole roof, so it won't be a big deal for either of you.",
      "Hold on, I don't know about that. That's exactly the kind of promise the last roofer made.",
      "You're right, and I shouldn't have said that. Nobody can promise what an insurance company will do. What I can offer is a free twenty-minute inspection with photos, nothing to sign and no money up front. Other than the cost, is there anything else that would worry Mike?",
      "No, I think that's it. He'd want to see you in person first.",
      'Would Thursday at 6:30 work for the two of you?',
      "Thursday at 6:30 works. I'll tell Mike. Please don't promise him the insurance thing either.",
    ],
  },

  // ------------------------------------------------------------------ three estimates
  {
    key: 'three-estimates-strong',
    scenario: 'three-estimates',
    band: [85, 100],
    endReason: 'objective_reached',
    lines: [
      "Morning, I'm {rep} with A5 Roofing, and thank you for giving me a minute. Getting three estimates is smart, I'd do the same. What matters most to you as you compare them?",
      "Mostly I want to know I'm not being upsold. I already have one quote for $18,400, but it's two pages of line items and I honestly can't tell whether it's high, low or padded.",
      "That's a common problem, and it's why the price alone doesn't tell you much. It sounds like you want a way to compare the quotes on the same scope. Would it help if I explained what to look for in an estimate, like the shingle line, underlayment, flashing, ventilation, permits and warranty?",
      'That would help. Nobody has explained what half of those lines mean.',
      'Happy to. We start with an inspection and document the roof with photos, so every company is bidding on the same facts. Then we give you a written, itemized estimate you can lay next to the first one. Other than the scope, is there anything else making it hard to decide?',
      "Not really, except I don't want to feel pressured. I'll compare everything in my spreadsheet.",
      "Spreadsheet is perfect, I'll make it easy to fill in. No pressure and no deadline on our side. If your quote is the better one, you should take it. Could I do the inspection Monday at 5:30, after you're home from work?",
      "Monday at 5:30 works. Bring the estimate and I'll show you the first one too.",
      "I will. I'll also include warranty terms so you can compare that, not just the number.",
      'Great. Monday at 5:30 it is.',
    ],
  },
  {
    key: 'three-estimates-solid',
    scenario: 'three-estimates',
    band: [80, 84],
    endReason: 'objective_reached',
    lines: [
      "Good morning, I'm {rep} with A5 Roofing. Getting a few estimates is a smart move. What did you like or dislike about the first one you got?",
      "It's $18,400 and the scope is hard to follow. I can't tell if I'm comparing the same things.",
      'That makes sense. It sounds like what you need is a way to compare the quotes on the same scope: materials, underlayment, flashing, ventilation and warranty. We can inspect the roof, take photos, and give you a written itemized estimate to lay next to the other one. Other than the scope, is there anything else making it hard to decide?',
      "Not really, that's it. How long does the inspection take?",
      'About twenty minutes, and you keep the photos either way. Could I come by Monday at 5:30?',
      'Monday at 5:30 works.',
      "Great. I'll bring a written itemized estimate form, so you can fill in the same lines from the first quote.",
      'Good. That would actually help.',
    ],
  },
  {
    key: 'three-estimates-weak',
    scenario: 'three-estimates',
    band: [70, 79],
    endReason: 'objective_reached',
    lines: [
      "Hey, I'm {rep} with A5 Roofing. We're the best price in the area and we can usually beat any other estimate you get. Do you want to see what we can do?",
      "I already said I'll get three estimates. I have one already.",
      'Sure, no problem. Who was it from, and what did they include? I bet we can beat it. Our quality is a lot better than most of these storm chasers and we use the best materials.',
      "It's $18,400. It's hard to tell what's in it, honestly.",
      "That sounds like a lot. We'll probably be cheaper. We could come out, inspect the roof and give you a written itemized estimate with the materials and warranty so you can compare, it takes about twenty minutes.",
      "Okay, I guess. Monday around 5:30 might work, but I'm still getting other quotes.",
      'Sounds good. See you Monday.',
      'Okay, thanks. Bring a written estimate.',
    ],
  },

  // ------------------------------------------------------------------ no claim
  {
    key: 'no-claim-strong',
    scenario: 'no-claim',
    band: [85, 100],
    endReason: 'objective_reached',
    lines: [
      "Hi, I'm {rep} with A5 Roofing, and thank you for being straight with me. A clean record is worth protecting. What have you heard about filing a claim that worries you?",
      "My neighbor two streets over filed a hail claim last year and then got a non-renewal notice. I can't afford that, and I'd have a $2,500 deductible on top of it.",
      "That would worry me too. It sounds like the fear is that a claim could cost you your coverage and the deductible on top. Here's the honest part: I can't tell you what your insurance company will do, and anyone who promises you that is guessing. Your agent is the right person to ask how your policy treats weather claims.",
      'I appreciate that. Nobody has said that to me.',
      'An inspection is not a claim. We look at the roof, document any damage with photos, and you keep the pictures. Whether to file is entirely your decision, and A5 never waives or covers a deductible. Other than the premium, is there anything else holding you back from knowing what condition the roof is in?',
      "No, that's really it. I just don't want to be pushed into filing.",
      "You won't be. One practical point: most policies limit how long you have to file a storm claim, so waiting has a risk too, and knowing the facts lets you decide. Could I come by Thursday at 5:30 for a no-commitment inspection?",
      "Thursday at 5:30 works for me. And you'll show me the photos before anyone says the word claim?",
      'Photos first, your questions second, and any decision is yours.',
      'All right. Thursday at 5:30. Thank you for being honest about it.',
    ],
  },
  {
    key: 'no-claim-solid',
    scenario: 'no-claim',
    band: [80, 84],
    endReason: 'objective_reached',
    lines: [
      "Hi, I'm {rep} with A5 Roofing. I completely understand, a lot of people feel that way. What worries you most about filing a claim?",
      "My neighbor's policy was non-renewed after a hail claim. I can't take that risk, and my deductible is $2,500.",
      "That makes sense. I can't predict what your insurance company would do, and your agent can tell you how your policy handles weather claims. An inspection isn't a claim, though. We document the roof with photos, it's free, and the decision to file is yours.",
      "Okay. And you wouldn't cover the deductible or anything like that?",
      "No, A5 never waives or pays a deductible, that's yours as the homeowner. Our job is to show you the condition of the roof, and most policies limit how long you have to file a storm claim, so knowing the facts helps you decide. Other than the premium, is there anything else holding you back? Could I do the inspection Thursday at 5:30?",
      'Thursday at 5:30 is fine. No commitment.',
      "None at all. I'll show you the photos first and answer anything you want to ask your agent.",
      'Okay. Thank you for being straight with me.',
    ],
  },

  // ------------------------------------------------------------------ cheaper
  {
    key: 'cheaper-strong',
    scenario: 'cheaper',
    band: [87, 100],
    endReason: 'objective_reached',
    lines: [
      "Hi, I'm {rep} with A5 Roofing, and thank you for being upfront. A roof is a big expense and checking prices is smart. What's in the quote you got from the other company?",
      "Eleven-eight for the whole roof. They want a $5,000 cash deposit up front, and they didn't give me anything written about what's included. But it's the only number I can really afford.",
      "That's a real pressure, and I appreciate you telling me. It sounds like the price is the deciding factor, and the part that nags you is the missing written scope and the deposit. I won't criticize them, I don't know them. But two prices are only comparable if the scope, materials and warranty match. Would it help to see what each one includes?",
      "Yes. I don't know what I'd even ask them.",
      "Then let's make that easy. I can inspect the roof, document it with photos and give you a written, itemized scope, so you can lay it beside theirs line by line: shingle, underlayment, flashing, ventilation, permits, cleanup and warranty. Other than price, is there anything else you'd want to know before deciding?",
      "I'm worried that yours will cost thousands more and I won't be able to afford it.",
      "Thank you for saying that. You won't be pressured, and there's no cost for the inspection or the estimate. If their scope matches ours at a better price, you should take it. If it doesn't, you'll see why. Could I come by Saturday at 10 to inspect and review both quotes together?",
      "Saturday at 10 works. I'll have their quote ready.",
      "Perfect. I'll bring the written scope and our warranty terms so you can compare apples to apples.",
      'Okay. Saturday at 10. Thank you for not trying to beat their number.',
    ],
  },
  {
    key: 'cheaper-solid',
    scenario: 'cheaper',
    band: [80, 86],
    endReason: 'objective_reached',
    lines: [
      "Hi, I'm {rep} with A5 Roofing. Price matters, and I won't argue with that. What's included in the other quote?",
      "Eleven-eight for a full replacement. They want $5,000 in cash up front, and it's not written down anywhere.",
      "I understand, that's a lot to put down without a written scope. It sounds like the price is what matters, and the missing paperwork is what nags you. Two prices are only comparable if the materials, underlayment, flashing and warranty are the same. We'll inspect, document the roof with photos and give you an itemized written estimate so you can compare line by line.",
      "That would help. I just don't know if I can afford yours.",
      "That's fair, and there's no cost or pressure for the inspection or the estimate. Other than the price, is there anything else you want to understand before deciding? Could I come by Saturday at 10 to review both quotes with you?",
      "Saturday at 10 works. I'll have their paper ready.",
      "Perfect. I'll bring the written scope so we can go through it together.",
      'Sounds good. See you then.',
    ],
  },

  // ------------------------------------------------------------------ not signing
  {
    key: 'not-signing-solid',
    scenario: 'not-signing',
    band: [0, 100],
    endReason: 'objective_reached',
    lines: [
      "Understood. I'm {rep} with A5 Roofing, and I'm not going to ask you to sign anything today. May I ask what happened that made you feel that strongly?",
      "Two years ago I paid a roofer a $6,000 deposit and he never finished the job. I'm still fighting him over it. So any form, any contract, I just can't.",
      "I'm sorry, that's a terrible thing to go through, and it makes complete sense that you'd be careful. It sounds like what you need is control: to see everything before anything is agreed. Is that fair?",
      "That's it. I don't want to be handed a pen and told it's routine.",
      'Then here is exactly how it works, in order. I look at the roof and take photos. You keep them. Nothing is signed and no money is requested. If you ever want work done, every scope and price is in writing first, and nothing is agreed on a doorstep. You can also ask for our license, insurance and references before any decision. Other than the paperwork, is there anything else that would worry you about someone being on your roof?',
      "I'm worried about whoever started the repair on the back slope. I don't know if it was done right.",
      "A fresh set of photos would show exactly what's up there and what shape the back slope is in. That's yours to keep and show anyone. Could I come by Tuesday at 4 for an inspection that requires no signature and no payment?",
      'Tuesday at 4. No signature, no money.',
      "Correct. And if anything at any point feels like pressure, tell me and I'll stop.",
      'Okay. Tuesday at 4. Thank you for not arguing with me about it.',
    ],
  },

  // ------------------------------------------------------------------ roof looks fine
  {
    key: 'roof-fine-weak',
    scenario: 'roof-fine',
    band: [0, 100],
    endReason: 'rep_ended',
    lines: [
      "Hi, I'm {rep} with A5 Roofing. Actually, your roof is probably not fine. Most roofs in this area took hail damage in April and you can't see it from the ground. If you don't get it checked, you could have leaks and mold soon.",
      "I haven't had any leaks. It looks fine from here, and I've been up there.",
      "Well, hail damage isn't always visible. We do free inspections. Do you want to schedule one?",
      "Not really. I'm just raking leaves. I don't want to spend money on a roof I don't need to.",
      "I understand, um, it doesn't cost anything for the inspection. It could save you a lot later. Maybe I could stop back some other time?",
      "Maybe. I'll think about it. Thanks, but I've got to get back to the yard.",
      "Okay, well, here's my card. It really is worth checking before it gets worse.",
      'Mm-hm. Have a good one.',
    ],
  },
];
