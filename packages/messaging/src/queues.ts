import { Queue, Worker, type ConnectionOptions, type Job, type JobsOptions, type Processor } from 'bullmq';
import { getContext, runWithContext, uuidv7, type Logger } from '@a5/observability';

export type { Job, Queue, Worker } from 'bullmq';

export interface QueueFactoryOptions {
  /** Redis URL; BullMQ manages its own connections. */
  redisUrl: string;
  /** Environment namespace, used as the BullMQ key prefix. */
  prefix: string;
  logger: Logger;
}

export interface JobMeta {
  correlationId: string;
  requestId: string;
}

export type JobData<T> = T & { _meta?: JobMeta };

export const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 2_000 },
  removeOnComplete: { age: 24 * 3600, count: 5_000 },
  removeOnFail: { age: 14 * 24 * 3600 },
};

function connection(redisUrl: string): ConnectionOptions {
  const url = new URL(redisUrl);
  return {
    host: url.hostname,
    port: Number(url.port || 6379),
    username: url.username || undefined,
    password: url.password ? decodeURIComponent(url.password) : undefined,
    db: url.pathname.length > 1 ? Number(url.pathname.slice(1)) : 0,
    tls: url.protocol === 'rediss:' ? {} : undefined,
    maxRetriesPerRequest: null,
  };
}

/**
 * Creates queues and workers with consistent retry, retention and dead-letter policy.
 * Jobs that exhaust their attempts are copied to `<queue>.dlq` with the failure reason.
 */
export class QueueFactory {
  private readonly queues = new Map<string, Queue>();
  private readonly workers: Worker[] = [];

  constructor(private readonly options: QueueFactoryOptions) {}

  queue<T = unknown>(name: string, defaultJobOptions: JobsOptions = {}): Queue<JobData<T>> {
    const existing = this.queues.get(name);
    if (existing) return existing as unknown as Queue<JobData<T>>;
    const queue = new Queue<JobData<T>>(name, {
      connection: connection(this.options.redisUrl),
      prefix: this.options.prefix,
      defaultJobOptions: { ...DEFAULT_JOB_OPTIONS, ...defaultJobOptions },
    });
    this.queues.set(name, queue as unknown as Queue);
    return queue;
  }

  /** Enqueue with the current request context attached for log correlation. */
  async add<T>(name: string, jobName: string, data: T, opts: JobsOptions = {}): Promise<Job<JobData<T>>> {
    const ctx = getContext();
    const meta: JobMeta = {
      correlationId: ctx?.correlationId ?? uuidv7(),
      requestId: ctx?.requestId ?? uuidv7(),
    };
    return this.queue<T>(name).add(jobName as never, { ...data, _meta: meta } as never, opts) as Promise<
      Job<JobData<T>>
    >;
  }

  worker<T, R = unknown>(
    name: string,
    processor: (job: Job<JobData<T>>) => Promise<R>,
    { concurrency = 5 }: { concurrency?: number } = {},
  ): Worker<JobData<T>, R> {
    const { logger } = this.options;
    const wrapped: Processor<JobData<T>, R> = (job) => {
      const meta = job.data._meta;
      return runWithContext(
        {
          requestId: meta?.requestId ?? `job:${job.id}`,
          correlationId: meta?.correlationId ?? `job:${job.id}`,
        },
        () => processor(job),
      );
    };
    const worker = new Worker<JobData<T>, R>(name, wrapped, {
      connection: connection(this.options.redisUrl),
      prefix: this.options.prefix,
      concurrency,
    });
    worker.on('failed', (job, err) => {
      if (!job) return;
      const attempts = job.opts.attempts ?? 1;
      const final = job.attemptsMade >= attempts;
      logger[final ? 'error' : 'warn'](
        { err, queue: name, jobId: job.id, attemptsMade: job.attemptsMade, attempts },
        final ? 'job failed permanently; moved to dead-letter queue' : 'job attempt failed; will retry',
      );
      if (final) {
        void this.queue<Record<string, unknown>>(`${name}.dlq`)
          .add('dead-letter', {
            queue: name,
            jobId: job.id,
            jobName: job.name,
            data: job.data,
            error: err.message,
            failedAt: new Date().toISOString(),
          }, { attempts: 1, removeOnComplete: false, removeOnFail: false })
          .catch((dlqErr: unknown) => logger.error({ err: dlqErr }, 'failed to write dead-letter job'));
      }
    });
    worker.on('error', (err) => logger.error({ err, queue: name }, 'queue worker error'));
    this.workers.push(worker as unknown as Worker);
    return worker;
  }

  async close(): Promise<void> {
    await Promise.allSettled(this.workers.map((w) => w.close()));
    await Promise.allSettled([...this.queues.values()].map((q) => q.close()));
  }
}
