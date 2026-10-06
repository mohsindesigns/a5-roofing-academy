import { assessment } from '@a5/contracts';

type QuestionType = assessment.QuestionType;

export interface ChoiceRow {
  id: string;
  text: string;
  correct: boolean;
}
export interface ItemRow {
  id: string;
  text: string;
}
export interface PairRow {
  leftId: string;
  left: string;
  rightId: string;
  right: string;
}
export interface AcceptedRow {
  value: string;
}

/**
 * The editor's form state. It is flat on purpose: one group of fields per question type, and only
 * the group for the selected type is sent. Numbers are strings while typing and parsed on save.
 */
export interface QuestionFormValues {
  type: QuestionType;
  bankId: string;
  prompt: string;
  explanation: string;
  points: string;
  difficulty: assessment.Difficulty;
  categoryId: string;
  competencyIds: string[];
  /** Comma separated. */
  tags: string;
  changeNote: string;
  // multiple choice, multiple select, scenario (choice follow-up)
  options: ChoiceRow[];
  // multiple select, ordering, matching
  scoring: assessment.ScoringMode;
  // true / false
  trueFalseAnswer: 'true' | 'false';
  // short answer
  grading: 'auto' | 'manual';
  accepted: AcceptedRow[];
  caseSensitive: boolean;
  normalizeWhitespace: boolean;
  reviewGuidance: string;
  // short answer and open scenario answers
  maxLength: string;
  // long answer and open scenario answers
  rubric: string;
  sampleAnswer: string;
  minWords: string;
  maxWords: string;
  // scenario
  scenario: string;
  subKind: 'multiple_choice' | 'open_response';
  subPrompt: string;
  // ordering
  items: ItemRow[];
  // matching
  pairs: PairRow[];
}

/**
 * Identifiers are shown to learners and travel with every attempt, so they must never hint at the
 * answer: random, not sequential.
 */
export function newChoiceId(prefix: string): string {
  const random =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID().replace(/-/g, '').slice(0, 10)
      : Math.random().toString(36).slice(2, 12).padEnd(10, '0');
  return `${prefix}${random}`;
}

const blankOptions = (n: number): ChoiceRow[] =>
  Array.from({ length: n }, () => ({ id: newChoiceId('o'), text: '', correct: false }));
const blankItems = (n: number): ItemRow[] =>
  Array.from({ length: n }, () => ({ id: newChoiceId('i'), text: '' }));
const blankPairs = (n: number): PairRow[] =>
  Array.from({ length: n }, () => ({
    leftId: newChoiceId('l'),
    left: '',
    rightId: newChoiceId('r'),
    right: '',
  }));

export function emptyForm(type: QuestionType, bankId: string): QuestionFormValues {
  const form = withType(
    {
      type,
      bankId,
      prompt: '',
      explanation: '',
      points: '1',
      difficulty: 'medium',
      categoryId: '',
      competencyIds: [],
      tags: '',
      changeNote: '',
      options: [],
      scoring: 'all_or_nothing',
      trueFalseAnswer: 'true',
      grading: 'auto',
      accepted: [{ value: '' }],
      caseSensitive: false,
      normalizeWhitespace: true,
      reviewGuidance: '',
      maxLength: '200',
      rubric: '',
      sampleAnswer: '',
      minWords: '',
      maxWords: '',
      scenario: '',
      subKind: 'multiple_choice',
      subPrompt: '',
      items: [],
      pairs: [],
    },
    type,
  );
  return type === 'scenario' ? { ...form, maxLength: '2000' } : form;
}

/** Switch the question type, giving the new type's fields sensible blank starting rows. */
export function withType(v: QuestionFormValues, type: QuestionType): QuestionFormValues {
  const next: QuestionFormValues = { ...v, type };
  if (
    (type === 'multiple_choice' || type === 'multiple_select' || type === 'scenario') &&
    next.options.length < 2
  )
    next.options = blankOptions(4);
  if (type === 'multiple_choice' || type === 'scenario') {
    // Single answer: keep at most one option marked correct.
    let seen = false;
    next.options = next.options.map((o) => {
      const correct = o.correct && !seen;
      seen = seen || correct;
      return { ...o, correct };
    });
  }
  if (type === 'ordering' && next.items.length < 2) next.items = blankItems(3);
  if (type === 'matching' && next.pairs.length < 2) next.pairs = blankPairs(3);
  if (v.type !== type) {
    // Open responses are longer than short answers, so each type starts from its own default.
    if (type === 'short_answer') next.maxLength = '200';
    if (type === 'scenario') next.maxLength = '2000';
  }
  return next;
}

export function fromVersion(
  version: assessment.QuestionVersion,
  bankId: string,
): QuestionFormValues {
  const base = emptyForm(version.type, bankId);
  const common = {
    prompt: version.prompt,
    explanation: version.explanation ?? '',
    points: String(version.points),
    difficulty: version.difficulty,
    categoryId: version.category?.id ?? '',
    competencyIds: version.competencies.map((c) => c.id),
    tags: version.tags.join(', '),
  };
  const out: QuestionFormValues = { ...base, ...common };
  switch (version.type) {
    case 'multiple_choice':
      out.options = version.config.options.map((o) => ({ ...o }));
      break;
    case 'multiple_select':
      out.options = version.config.options.map((o) => ({ ...o }));
      out.scoring = version.config.scoring;
      break;
    case 'true_false':
      out.trueFalseAnswer = version.config.correctAnswer ? 'true' : 'false';
      break;
    case 'short_answer':
      out.grading = version.config.grading;
      out.accepted = version.config.acceptedAnswers.length
        ? version.config.acceptedAnswers.map((value) => ({ value }))
        : [{ value: '' }];
      out.caseSensitive = version.config.caseSensitive;
      out.normalizeWhitespace = version.config.normalizeWhitespace;
      out.maxLength = String(version.config.maxLength);
      out.reviewGuidance = version.config.reviewGuidance ?? '';
      break;
    case 'long_answer':
      out.rubric = version.config.rubric;
      out.sampleAnswer = version.config.sampleAnswer ?? '';
      out.minWords = version.config.minWords === null ? '' : String(version.config.minWords);
      out.maxWords = version.config.maxWords === null ? '' : String(version.config.maxWords);
      break;
    case 'scenario': {
      out.scenario = version.config.scenario;
      const sub = version.config.subQuestion;
      out.subKind = sub.kind;
      out.subPrompt = sub.prompt;
      if (sub.kind === 'multiple_choice') out.options = sub.options.map((o) => ({ ...o }));
      else {
        out.rubric = sub.rubric;
        out.sampleAnswer = sub.sampleAnswer ?? '';
        out.maxLength = String(sub.maxLength);
      }
      break;
    }
    case 'ordering':
      out.items = version.config.items.map((i) => ({ ...i }));
      out.scoring = version.config.scoring;
      break;
    case 'matching':
      out.pairs = version.config.pairs.map((p) => ({ ...p }));
      out.scoring = version.config.scoring;
      break;
  }
  return withType(out, version.type);
}

export interface PreIssue {
  /** Path in the form, e.g. `points` or `options.1.text`. */
  path: string;
  message: string;
}

export function parseTags(text: string): string[] {
  return [
    ...new Set(
      text
        .split(',')
        .map((t) => t.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
}

const blankToNull = (s: string) => (s.trim() === '' ? null : s.trim());

/** Form state to the API payload for one question version (without bank or change note). */
export function buildPayload(v: QuestionFormValues): {
  payload: Record<string, unknown>;
  issues: PreIssue[];
} {
  const issues: PreIssue[] = [];
  const number = (text: string, path: string, optional = false): number | null => {
    if (text.trim() === '') {
      if (!optional) issues.push({ path, message: 'Enter a number' });
      return null;
    }
    const n = Number(text);
    if (!Number.isFinite(n)) {
      issues.push({ path, message: 'Enter a number' });
      return null;
    }
    return n;
  };
  const choices = v.options.map((o) => ({ id: o.id, text: o.text, correct: o.correct }));
  let config: unknown;
  switch (v.type) {
    case 'multiple_choice':
      config = { options: choices };
      break;
    case 'multiple_select':
      config = { options: choices, scoring: v.scoring };
      break;
    case 'true_false':
      config = { correctAnswer: v.trueFalseAnswer === 'true' };
      break;
    case 'short_answer':
      config = {
        grading: v.grading,
        acceptedAnswers: v.accepted.map((a) => a.value.trim()).filter(Boolean),
        caseSensitive: v.caseSensitive,
        normalizeWhitespace: v.normalizeWhitespace,
        maxLength: number(v.maxLength, 'maxLength'),
        reviewGuidance: blankToNull(v.reviewGuidance),
      };
      break;
    case 'long_answer':
      config = {
        rubric: v.rubric,
        sampleAnswer: blankToNull(v.sampleAnswer),
        minWords: number(v.minWords, 'minWords', true),
        maxWords: number(v.maxWords, 'maxWords', true),
      };
      break;
    case 'scenario':
      config = {
        scenario: v.scenario,
        subQuestion:
          v.subKind === 'multiple_choice'
            ? { kind: 'multiple_choice', prompt: v.subPrompt, options: choices }
            : {
                kind: 'open_response',
                prompt: v.subPrompt,
                rubric: v.rubric,
                sampleAnswer: blankToNull(v.sampleAnswer),
                maxLength: number(v.maxLength, 'maxLength'),
              },
      };
      break;
    case 'ordering':
      config = { items: v.items.map((i) => ({ id: i.id, text: i.text })), scoring: v.scoring };
      break;
    case 'matching':
      config = { pairs: v.pairs.map((p) => ({ ...p })), scoring: v.scoring };
      break;
  }
  return {
    payload: {
      type: v.type,
      config,
      prompt: v.prompt,
      explanation: blankToNull(v.explanation),
      points: number(v.points, 'points'),
      difficulty: v.difficulty,
      categoryId: v.categoryId || null,
      competencyIds: v.competencyIds,
      tags: parseTags(v.tags),
    },
    issues,
  };
}

/**
 * Translate a contract issue path (`config.options.1.text`) to the form's field path
 * (`options.1.text`). Messages about a whole list use a separate `...Error` key so they do not
 * collide with the per-row errors.
 */
export function formPath(path: ReadonlyArray<PropertyKey>): string {
  const parts = path.map(String);
  if (parts[0] !== 'config')
    return parts[0] === 'tags' || parts[0] === 'competencyIds' ? parts[0]! : parts.join('.');
  const rest = parts.slice(1);
  if (rest[0] === 'subQuestion') {
    const sub = rest.slice(1);
    if (sub[0] === 'prompt') return 'subPrompt';
    if (sub[0] === 'options') return sub.length === 1 ? 'optionsError' : sub.join('.');
    return sub[0] ?? 'subPrompt'; // rubric, sampleAnswer, maxLength
  }
  switch (rest[0]) {
    case 'options':
      return rest.length === 1 ? 'optionsError' : rest.join('.');
    case 'items':
      return rest.length === 1 ? 'itemsError' : rest.join('.');
    case 'pairs':
      return rest.length === 1 ? 'pairsError' : rest.join('.');
    case 'acceptedAnswers':
      return rest.length === 1 ? 'acceptedError' : `accepted.${rest[1]}.value`;
    case 'correctAnswer':
      return 'trueFalseAnswer';
    default:
      return rest[0] ?? 'prompt';
  }
}

export interface ValidationResult {
  payload: Record<string, unknown>;
  issues: PreIssue[];
}

/** Validate the form with the same contract schemas the service uses. */
export function validateForm(
  v: QuestionFormValues,
  { creating }: { creating: boolean },
): ValidationResult {
  const built = buildPayload(v);
  const issues = [...built.issues];
  const parsed = assessment.questionVersionInputSchema.safeParse(built.payload);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const path = formPath(issue.path);
      // A number the user never typed is reported once, by the field itself.
      if (issues.some((i) => i.path === path)) continue;
      issues.push({ path, message: friendlyMessage(path, issue.message) });
    }
  }
  if (creating && !v.bankId)
    issues.push({ path: 'bankId', message: 'Choose the question bank this belongs to' });
  return { payload: built.payload, issues };
}

function friendlyMessage(path: string, message: string): string {
  if (path === 'points') return 'Points must be greater than zero, up to 100';
  if (path === 'maxLength')
    return 'Enter a length between 1 and 500 for short answers, 50 and 5000 for scenario responses';
  if ((path === 'minWords' || path === 'maxWords') && !message.startsWith('Maximum words')) {
    return 'Enter a whole number of words, or leave empty';
  }
  if (path.startsWith('options.') || path.startsWith('items.') || path.startsWith('pairs.'))
    return message === 'Required' ? 'Fill this in or remove the row' : message;
  return message;
}

/** Set a value at a dotted path, creating arrays for numeric segments. */
export function setIn(target: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');
  let node: Record<string, unknown> | unknown[] = target;
  parts.forEach((part, i) => {
    const key = /^\d+$/.test(part) ? Number(part) : part;
    if (i === parts.length - 1) {
      (node as Record<string | number, unknown>)[key] = value;
      return;
    }
    const nextIsIndex = /^\d+$/.test(parts[i + 1]!);
    const container = node as Record<string | number, unknown>;
    if (container[key] === undefined) container[key] = nextIsIndex ? [] : {};
    node = container[key] as Record<string, unknown> | unknown[];
  });
}

/** Whether a question type is graded by a person (mirrors the service). */
export function needsManualReview(v: QuestionFormValues): boolean {
  return (
    v.type === 'long_answer' ||
    (v.type === 'short_answer' && v.grading === 'manual') ||
    (v.type === 'scenario' && v.subKind === 'open_response')
  );
}
