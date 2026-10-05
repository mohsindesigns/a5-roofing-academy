import { Injectable } from '@nestjs/common';
import type { ai } from '@a5/contracts';
import type { Selectable } from '@a5/database';
import { InjectDb } from '@a5/nest-kit';
import { People, iso, isoOrNull } from '../common/people.js';
import type {
  AiEvaluationsTable,
  AiMessagesTable,
  AiSessionsTable,
  Db,
} from '../database/index.js';
import { readScenarioSnapshot } from '../prompts/snapshots.js';
import { providerInfo } from '../providers/registry.js';

export type SessionRow = Selectable<AiSessionsTable>;
type MessageRow = Pick<
  Selectable<AiMessagesTable>,
  'id' | 'seq' | 'role' | 'content' | 'modality' | 'audio_ref' | 'created_at'
>;

export function messageDto(m: MessageRow): ai.Message {
  return {
    id: m.id,
    seq: m.seq,
    role: m.role,
    content: m.content,
    modality: m.modality,
    audioRef: m.audio_ref,
    createdAt: iso(m.created_at),
  };
}

export function scorecardDto(e: Selectable<AiEvaluationsTable>): ai.Scorecard {
  return {
    id: e.id,
    overallScore: e.overall_score,
    passed: e.passed,
    passingScore: e.passing_score,
    categoryScores: e.category_scores,
    strengths: e.strengths,
    missedOpportunities: e.missed_opportunities,
    questionsToAsk: e.questions_to_ask,
    riskyStatements: e.risky_statements,
    recommendedResponses: e.recommended_responses,
    nextGoal: e.next_goal,
    summary: e.summary,
    provider: providerInfo(e.provider, e.model),
    promptVersionId: e.prompt_version_id,
    rubricVersionId: e.rubric_version_id,
    evaluatedAt: iso(e.created_at),
  };
}

export function turnsRemaining(s: Pick<SessionRow, 'max_turns' | 'turn_count' | 'status'>): number {
  return s.status === 'active' ? Math.max(0, s.max_turns - s.turn_count) : 0;
}

/** Assembles the session payload (transcript, status, scorecard, coaching reviews). */
@Injectable()
export class SessionView {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly people: People,
  ) {}

  async build(s: SessionRow): Promise<ai.Session> {
    const [pv, messages, evaluation, reviews] = await Promise.all([
      this.db
        .selectFrom('ai_prompt_versions')
        .select(['id', 'version', 'scenario_snapshot'])
        .where('id', '=', s.prompt_version_id)
        .executeTakeFirstOrThrow(),
      this.db
        .selectFrom('ai_messages')
        .select(['id', 'seq', 'role', 'content', 'modality', 'audio_ref', 'created_at'])
        .where('session_id', '=', s.id)
        .orderBy('seq')
        .execute(),
      this.db
        .selectFrom('ai_evaluations')
        .selectAll()
        .where('session_id', '=', s.id)
        .executeTakeFirst(),
      this.db
        .selectFrom('ai_session_reviews')
        .selectAll()
        .where('session_id', '=', s.id)
        .orderBy('created_at')
        .execute(),
    ]);
    const snapshot = readScenarioSnapshot(pv.scenario_snapshot);
    const reviewers = await this.people.refs(reviews.map((r) => r.reviewer_id));
    const last = messages[messages.length - 1];
    return {
      id: s.id,
      scenario: {
        id: s.scenario_id,
        title: snapshot.title,
        category: snapshot.category,
        difficulty: snapshot.difficulty,
        objection: snapshot.objection,
      },
      promptVersion: { id: pv.id, version: pv.version },
      mode: s.mode,
      isTest: s.is_test,
      modality: s.modality,
      status: s.status,
      endReason: s.end_reason,
      context: s.context,
      turnCount: s.turn_count,
      maxTurns: s.max_turns,
      turnsRemaining: turnsRemaining(s),
      awaitingReply: s.status === 'active' && last?.role === 'rep',
      provider: providerInfo(s.provider, s.model),
      startedAt: iso(s.started_at),
      endedAt: isoOrNull(s.ended_at),
      messages: messages.map(messageDto),
      transcriptPurged: s.transcript_purged_at !== null,
      evaluation: evaluation ? scorecardDto(evaluation) : null,
      evaluationError:
        s.status === 'evaluation_failed'
          ? (s.evaluation_error ?? 'Scoring failed. Retry the evaluation.')
          : null,
      reviews: reviews.map((r) => ({
        id: r.id,
        reviewer: reviewers.get(r.reviewer_id) ?? {
          id: r.reviewer_id,
          displayName: 'Former team member',
        },
        comment: r.comment,
        recommendation: r.recommendation,
        createdAt: iso(r.created_at),
      })),
    };
  }
}
