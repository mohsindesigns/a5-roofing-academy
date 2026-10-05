import type { assessment } from '@a5/contracts';
import type { SeedAssessment } from '@a5/seed-data';
import type { CategoryKey } from './question-bank.js';

/**
 * Definitions of the four seeded assessments (ids, titles, kinds and pass marks come from
 * @a5/seed-data). Weekly quizzes use fixed questions; the final mixes fixed scenario and written
 * questions with pools drawn per attempt.
 */

export type SeedItem =
  | { kind: 'question'; question: string }
  | {
      kind: 'pool';
      category: CategoryKey;
      count: number;
      difficulty?: assessment.Difficulty;
      tags?: string[];
    };

export interface SeedAssessmentDefinition {
  description: string;
  config: assessment.AssessmentConfig;
  items: SeedItem[];
}

const fixed = (...keys: string[]): SeedItem[] => keys.map((question) => ({ kind: 'question', question }));

export const ASSESSMENT_DEFINITIONS: Partial<Record<SeedAssessment['key'], SeedAssessmentDefinition>> = {
  'quiz-w1': {
    description:
      'Checks that you know how A5 earns trust: the customer journey, the photo report, the permission rule and the two promises you must never make. You need 80% to pass; you can take it up to three times.',
    config: {
      passingPercent: 80,
      maxAttempts: 3,
      timeLimitSeconds: 20 * 60,
      randomizeQuestions: false,
      randomizeOptions: true,
      revealCorrectAnswers: 'after_submit',
      revealScore: true,
      retryCooldownMinutes: 10,
      notifyManagerOn: ['failed'],
      allowStandalone: false,
    },
    items: fixed(
      'cs-photo-report',
      'cs-permission',
      'cs-customer-journey',
      'cs-team-roles',
      'cs-inspection-notes',
      'cs-report-turnaround',
      'co-guarantee',
      'co-deductible-law',
    ),
  },
  'quiz-w2': {
    description:
      'Roof components, hail and wind damage, and the basics of how a homeowner claim pays out. You need 80% to pass; you can take it up to three times.',
    config: {
      passingPercent: 80,
      maxAttempts: 3,
      timeLimitSeconds: 25 * 60,
      randomizeQuestions: false,
      randomizeOptions: true,
      revealCorrectAnswers: 'after_submit',
      revealScore: true,
      retryCooldownMinutes: 10,
      notifyManagerOn: ['failed'],
      allowStandalone: false,
    },
    items: fixed(
      'rs-underlayment',
      'rs-components',
      'rs-square',
      'sd-hail-bruise',
      'sd-granules',
      'sd-wind',
      'sd-soft-metals',
      'ip-deductible',
      'ip-recoverable-depreciation',
      'ip-claim-steps',
    ),
  },
  'quiz-w3': {
    description:
      'The first 30 seconds at the door, discovery questions and the A5 Objection Framework. You need 80% to pass; you can take it up to three times.',
    config: {
      passingPercent: 80,
      maxAttempts: 3,
      timeLimitSeconds: 25 * 60,
      randomizeQuestions: false,
      randomizeOptions: true,
      revealCorrectAnswers: 'after_submit',
      revealScore: true,
      retryCooldownMinutes: 10,
      notifyManagerOn: ['failed'],
      allowStandalone: false,
    },
    items: fixed(
      'sc-first-30',
      'sc-open-questions',
      'sc-talk-ratio',
      'sc-conversation-flow',
      'sc-selling-home',
      'oh-framework',
      'oh-three-estimates',
      'oh-spouse',
      'oh-first-step',
      'oh-hidden-concerns',
    ),
  },
  final: {
    description:
      'The Final Sales Readiness Assessment covers all four weeks: company standards, roofing and storm damage, the insurance process, the sales conversation, objection handling and compliance. It includes written answers that a trainer reviews, so your result may take a day to appear. You need 85% to pass and have two attempts, 24 hours apart.',
    config: {
      passingPercent: 85,
      maxAttempts: 2,
      timeLimitSeconds: 45 * 60,
      randomizeQuestions: true,
      randomizeOptions: true,
      revealCorrectAnswers: 'after_pass',
      revealScore: true,
      retryCooldownMinutes: 24 * 60,
      notifyManagerOn: ['failed', 'passed'],
      allowStandalone: false,
    },
    items: [
      { kind: 'pool', category: 'company-standards', count: 2 },
      { kind: 'pool', category: 'roofing-systems', count: 2, difficulty: 'medium' },
      { kind: 'pool', category: 'storm-damage', count: 2, tags: ['hail'] },
      { kind: 'question', question: 'ip-first-check' },
      { kind: 'pool', category: 'insurance-process', count: 3 },
      { kind: 'question', question: 'ip-explain-payments' },
      { kind: 'pool', category: 'sales-conversation', count: 2 },
      { kind: 'question', question: 'sc-busy-opening' },
      { kind: 'pool', category: 'objection-handling', count: 2 },
      { kind: 'question', question: 'oh-no-claim' },
      { kind: 'question', question: 'co-sign-for-me' },
      { kind: 'question', question: 'co-never-promise' },
      { kind: 'pool', category: 'compliance', count: 1 },
    ],
  },
};
