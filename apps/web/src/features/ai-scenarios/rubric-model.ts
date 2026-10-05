import { ai } from '@a5/contracts';
import { friendlyIssue } from './scenario-model';

/** One criterion while editing. Numbers stay text so typing is never fought by the input. */
export interface Criterion {
  uid: string;
  key: string;
  label: string;
  description: string;
  weight: string;
  guidance: string;
  /** Saved in an earlier version: its key is how past scorecards refer to it, so it is locked. */
  existing: boolean;
  keyEdited: boolean;
}

export type CriterionField = 'key' | 'label' | 'description' | 'weight' | 'guidance';

export interface RubricIssues {
  criteria: Record<string, Partial<Record<CriterionField, string>>>;
  passingScore?: string;
  /** Messages about the rubric as a whole. */
  general: string[];
}

let counter = 0;
export const newUid = () => `c${++counter}`;

export function toCriteria(
  categories: ai.RubricCategory[],
  options: { existing: boolean },
): Criterion[] {
  return categories.map((c) => ({
    uid: newUid(),
    key: c.key,
    label: c.label,
    description: c.description,
    weight: String(c.weight),
    guidance: c.guidance,
    existing: options.existing,
    keyEdited: true,
  }));
}

export function blankCriterion(): Criterion {
  return {
    uid: newUid(),
    key: '',
    label: '',
    description: '',
    weight: '5',
    guidance: '',
    existing: false,
    keyEdited: false,
  };
}

/** `Value presentation` becomes `value_presentation`, within the 40 characters the API allows. */
export function slugKey(label: string): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40)
    .replace(/_+$/g, '');
  return /^[a-z]/.test(slug) ? slug : slug ? `c_${slug}`.slice(0, 40) : '';
}

export function toCategories(criteria: Criterion[]) {
  return criteria.map((c) => ({
    key: c.key.trim(),
    label: c.label,
    description: c.description,
    weight: c.weight.trim() === '' ? Number.NaN : Number(c.weight),
    guidance: c.guidance,
  }));
}

/** Each criterion's share of the overall score, as a percentage. */
export function weightShares(criteria: Criterion[]): number[] {
  const weights = criteria.map((c) => {
    const n = Number(c.weight);
    return Number.isFinite(n) && n > 0 ? n : 0;
  });
  const total = weights.reduce((a, b) => a + b, 0);
  return weights.map((w) => (total > 0 ? (w / total) * 100 : 0));
}

export function validateRubricVersion(
  criteria: Criterion[],
  passingScore: string,
  changeNote: string,
): { ok: true; request: ai.CreateRubricVersionRequest } | { ok: false; issues: RubricIssues } {
  const parsed = ai.createRubricVersionRequestSchema.safeParse({
    categories: toCategories(criteria),
    passingScore: passingScore.trim() === '' ? undefined : Number(passingScore),
    ...(changeNote.trim() && { changeNote: changeNote.trim() }),
  });
  if (parsed.success) return { ok: true, request: parsed.data };
  const issues: RubricIssues = { criteria: {}, general: [] };
  for (const issue of parsed.error.issues) {
    const [head, index, field] = issue.path;
    if (head === 'categories' && typeof index === 'number' && criteria[index]) {
      const uid = criteria[index]!.uid;
      const name = (typeof field === 'string' ? field : 'label') as CriterionField;
      issues.criteria[uid] ??= {};
      issues.criteria[uid]![name] ??=
        issue.code === 'invalid_type' ? 'Enter a number' : friendlyIssue(issue);
    } else if (head === 'passingScore') {
      issues.passingScore ??= friendlyIssue(issue);
    } else {
      // Rubric-wide rules, such as unique keys or a total weight above zero.
      const message = friendlyIssue(issue);
      if (!issues.general.includes(message)) issues.general.push(message);
    }
  }
  return { ok: false, issues };
}

/** Whether the editor differs from a saved version (used to show the unsaved bar). */
export function isChanged(
  criteria: Criterion[],
  passingScore: string,
  saved: { categories: ai.RubricCategory[]; passingScore: number },
): boolean {
  if (String(saved.passingScore) !== passingScore.trim()) return true;
  // Field by field: the API returns JSON whose key order differs from the editor's.
  const flat = (c: ai.RubricCategory) =>
    [c.key, c.label, c.description, String(c.weight), c.guidance].join('\u0000');
  const a = toCategories(criteria).map(flat);
  const b = saved.categories.map(flat);
  return a.length !== b.length || a.some((row, i) => row !== b[i]);
}
