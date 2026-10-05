import type { Kysely, Selectable, Transaction } from '@a5/database';
import type {
  AssessmentDatabase,
  AssessmentItemsTable,
  AssessmentsTable,
  AttemptAnswersTable,
  AttemptQuestionsTable,
  AttemptsTable,
  QuestionVersionsTable,
} from './schema.js';

export type Db = Kysely<AssessmentDatabase>;
export type Trx = Transaction<AssessmentDatabase>;
export type DbOrTrx = Db | Trx;

export type AssessmentRow = Selectable<AssessmentsTable>;
export type AssessmentItemRow = Selectable<AssessmentItemsTable>;
export type AttemptRow = Selectable<AttemptsTable>;
export type AttemptQuestionRow = Selectable<AttemptQuestionsTable>;
export type AttemptAnswerRow = Selectable<AttemptAnswersTable>;
export type QuestionVersionRow = Selectable<QuestionVersionsTable>;

export * from './schema.js';
