import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { learningEvents } from '@a5/events';
import { QueueFactory } from '@a5/messaging';
import { EventBus, InjectDb, LOGGER, runsWorkers } from '@a5/nest-kit';
import type { Logger } from '@a5/observability';
import { LEARNING_CONFIG, type LearningConfig } from '../config.js';
import type { Db } from '../database/index.js';
import { TreeService } from '../engine/tree.service.js';

export const OVERDUE_QUEUE = 'learning.overdue';
const SCHEDULER_ID = 'learning.overdue.daily';

/**
 * Daily sweep that emits enrollment.overdue for active enrollments past their due date. A notice
 * row per enrollment and calendar day makes repeated or concurrent runs harmless.
 */
@Injectable()
export class OverdueService implements OnModuleInit {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly events: EventBus,
    private readonly trees: TreeService,
    private readonly queues: QueueFactory,
    @Inject(LEARNING_CONFIG) private readonly config: LearningConfig,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!runsWorkers(this.config)) return;
    this.queues.worker(OVERDUE_QUEUE, async () => this.sweep(new Date()), { concurrency: 1 });
    await this.queues
      .queue(OVERDUE_QUEUE)
      .upsertJobScheduler(
        SCHEDULER_ID,
        { pattern: this.config.learning.overdueCron, tz: this.config.learning.overdueTimezone },
        { name: 'sweep', data: {} },
      );
  }

  /** Calendar day in the organization's operating time zone. */
  private noticeDate(now: Date): string {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: this.config.learning.overdueTimezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(now);
  }

  async sweep(now: Date = new Date()): Promise<{ overdue: number; notified: number }> {
    const day = this.noticeDate(now);
    const rows = await this.db
      .selectFrom('enrollments as e')
      .innerJoin('programs as p', 'p.id', 'e.program_id')
      .select([
        'e.id',
        'e.organization_id',
        'e.program_id',
        'e.user_id',
        'e.due_at',
        'e.progress_percent',
        'p.title',
      ])
      .where('e.status', '=', 'active')
      .where('e.due_at', '<', now)
      .where('p.status', '=', 'published')
      .orderBy('e.due_at')
      .execute();
    const titles = new Map<string, string>();
    let notified = 0;
    for (let i = 0; i < rows.length; i += 100) {
      const chunk = rows.slice(i, i + 100);
      for (const programId of new Set(chunk.map((r) => r.program_id))) {
        if (!titles.has(programId))
          titles.set(
            programId,
            (await this.trees.published(programId))?.title ??
              chunk.find((r) => r.program_id === programId)!.title,
          );
      }
      notified += await this.db.transaction().execute(async (trx) => {
        let count = 0;
        for (const e of chunk) {
          const inserted = await trx
            .insertInto('enrollment_overdue_notices')
            .values({ enrollment_id: e.id, notice_date: day })
            .onConflict((oc) => oc.columns(['enrollment_id', 'notice_date']).doNothing())
            .executeTakeFirst();
          if ((inserted.numInsertedOrUpdatedRows ?? 0n) === 0n) continue;
          await this.events.emit(
            trx,
            learningEvents.enrollmentOverdue,
            {
              enrollmentId: e.id,
              programId: e.program_id,
              userId: e.user_id,
              programTitle: titles.get(e.program_id)!,
              dueAt: e.due_at!.toISOString(),
              progressPercent: Number(e.progress_percent),
            },
            { organizationId: e.organization_id, subject: { type: 'enrollment', id: e.id } },
          );
          count++;
        }
        return count;
      });
    }
    if (notified)
      this.logger.info(
        { overdue: rows.length, notified, day },
        'overdue enrollment notices emitted',
      );
    return { overdue: rows.length, notified };
  }
}
