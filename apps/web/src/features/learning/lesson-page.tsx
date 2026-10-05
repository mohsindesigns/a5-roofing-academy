import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { ArrowLeft, ArrowRight, Check, ExternalLink, FileText, Trash2 } from 'lucide-react';
import type { learning, media } from '@a5/contracts';
import {
  Button,
  EmptyState,
  ErrorState,
  Field,
  Input,
  Notice,
  PageHeader,
  Skeleton,
  StatusText,
  Textarea,
  toast,
} from '@/components/ui';
import { Markdown } from '@/components/markdown';
import { api } from '@/lib/api/client';
import { ApiError, errorMessage } from '@/lib/api/errors';
import { cn } from '@/lib/cn';
import { formatDateTime } from '@/lib/format';
import {
  VideoPlayer,
  formatClock,
  type PlayerSource,
  type VideoPlayerHandle,
} from '@/features/media/video-player';
import type { WatchReport } from '@/features/media/watch-tracker';
import {
  learningKeys,
  useAcknowledge,
  useCompleteLesson,
  useInvalidateProgress,
  useLesson,
  useNotes,
  useOutline,
  usePlayback,
  useRequestApproval,
  useStartLesson,
  useSubmitAssignment,
} from './api';
import { LessonTypeIcon, Requirements, StateMark, lessonTypeLabel } from './lesson-ui';
import { useQueryClient } from '@tanstack/react-query';

type Detail = learning.LessonDetail;

// ------------------------------------------------------------------ video

function VideoLesson({ detail }: { detail: Detail }) {
  const playback = usePlayback(detail.grant?.token);
  const invalidate = useInvalidateProgress();
  const qc = useQueryClient();
  const playerRef = useRef<VideoPlayerHandle>(null);
  const [time, setTime] = useState(0);
  const completedRef = useRef(detail.state === 'completed');
  const notes = useNotes(detail.lesson.id);
  const [noteText, setNoteText] = useState('');
  const [watched, setWatched] = useState<number | null>(detail.progress.watchedPercent);
  const d = playback.data;

  const source: PlayerSource | null = useMemo(
    () =>
      d && d.kind !== 'document'
        ? {
            kind: d.kind === 'hls' ? 'hls' : 'progressive',
            url: d.url,
            posterUrl: d.posterUrl,
            durationSeconds: d.durationSeconds,
            captions: d.captions.map((c) => ({
              language: c.language,
              label: c.label,
              url: c.url,
              isDefault: c.isDefault,
            })),
            chapters: d.chapters.map((c) => ({ startSeconds: c.startSeconds, title: c.title })),
            resume: d.resume,
          }
        : null,
    [d],
  );

  const token = d?.playbackToken;
  const report = useMemo(
    () =>
      (r: WatchReport, { beacon }: { beacon: boolean }) => {
        if (!token) return;
        const payload = { playbackToken: token, ...r };
        if (beacon && 'sendBeacon' in navigator) {
          // sendBeacon cannot set Authorization; the signed playback token authorises the request.
          navigator.sendBeacon(
            '/api/v1/media/playback/beacon',
            new Blob([JSON.stringify(payload)], { type: 'text/plain' }),
          );
          return;
        }
        void api
          .post<media.HeartbeatResponse>('/media/playback/heartbeat', payload)
          .then((res) => {
            setWatched(res.watchedPercent);
            if (res.completed && !completedRef.current) {
              completedRef.current = true;
              invalidate();
            }
          })
          .catch(() => undefined); // telemetry must never interrupt viewing; the next heartbeat re-sends
      },
    [token, invalidate],
  );

  useEffect(() => {
    // Leaving the lesson (or the tab) lets the server settle progress; refresh the outline after.
    return () => void qc.invalidateQueries({ queryKey: learningKeys.all });
  }, [qc]);

  if (!detail.grant) return null;
  if (playback.isPending) return <Skeleton className="aspect-video w-full" />;
  if (playback.isError)
    return (
      <ErrorState
        title="The video could not be loaded"
        message={errorMessage(playback.error)}
        onRetry={() => playback.refetch()}
      />
    );
  if (!d || !source) return <EmptyState title="This lesson has no video yet" />;
  const min = d.policy.minWatchPercent ?? null;

  return (
    <div className="grid gap-5">
      <div className="-mx-4 sm:mx-0">
        <VideoPlayer
          ref={playerRef}
          source={source}
          title={detail.lesson.title}
          policy={{
            allowSkipping: d.policy.allowSeekAhead,
            maxCreditedPlaybackRate: d.policy.maxCreditedPlaybackRate,
          }}
          onReport={report}
          onTimeChange={setTime}
        />
      </div>
      <p className="text-sm text-text-secondary" aria-live="polite">
        {detail.state === 'completed' ? (
          <StatusText tone="success">Completed</StatusText>
        ) : (
          <>
            Watched{' '}
            <strong className="tabular font-medium text-text-primary">
              {Math.round(watched ?? 0)}%
            </strong>
            {min !== null && <> · {min}% needed to complete</>}
          </>
        )}
      </p>
      {d.chapters.length > 0 && (
        <section aria-label="Chapters">
          <h2 className="mb-1.5 text-sm font-semibold">Chapters</h2>
          <ol className="divide-y divide-divider overflow-hidden rounded-lg border border-border bg-surface">
            {d.chapters.map((c, i) => {
              const next = d.chapters[i + 1]?.startSeconds ?? Infinity;
              const current = time >= c.startSeconds && time < next;
              return (
                <li key={c.id}>
                  <button
                    type="button"
                    onClick={() => playerRef.current?.seekTo(c.startSeconds)}
                    className={cn(
                      'flex w-full items-center gap-3 px-4 py-2 text-left text-sm hover:bg-surface-hover',
                      current && 'bg-surface-selected font-medium',
                    )}
                    aria-current={current || undefined}
                  >
                    <span className="tabular w-12 text-text-tertiary">
                      {formatClock(c.startSeconds)}
                    </span>
                    {c.title}
                  </button>
                </li>
              );
            })}
          </ol>
        </section>
      )}
      <section aria-label="Notes">
        <h2 className="mb-1.5 text-sm font-semibold">My notes</h2>
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!noteText.trim()) return;
            notes.add.mutate(
              { body: noteText.trim(), videoTimestampSeconds: Math.floor(time) },
              {
                onSuccess: () => setNoteText(''),
                onError: (err) => toast.error('Note not saved', errorMessage(err)),
              },
            );
          }}
        >
          <Input
            aria-label={`Add a note at ${formatClock(time)}`}
            placeholder={`Add a note at ${formatClock(time)}`}
            value={noteText}
            onChange={(e) => setNoteText(e.target.value)}
          />
          <Button type="submit" loading={notes.add.isPending}>
            Save
          </Button>
        </form>
        {detail.notes.length > 0 && (
          <ul className="mt-2 divide-y divide-divider rounded-lg border border-border bg-surface">
            {detail.notes.map((n) => (
              <li key={n.id} className="flex items-start gap-3 px-4 py-2.5 text-sm">
                {n.videoTimestampSeconds !== null && (
                  <button
                    type="button"
                    className="tabular text-information hover:underline"
                    onClick={() => playerRef.current?.seekTo(n.videoTimestampSeconds ?? 0)}
                  >
                    {formatClock(n.videoTimestampSeconds)}
                  </button>
                )}
                <span className="min-w-0 flex-1 whitespace-pre-wrap">{n.body}</span>
                <button
                  type="button"
                  aria-label="Delete note"
                  className="text-text-tertiary hover:text-danger"
                  onClick={() => notes.remove.mutate(n.id)}
                >
                  <Trash2 className="size-4" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

// ------------------------------------------------------------------ other lesson types

function DocumentLesson({ detail }: { detail: Detail }) {
  const playback = usePlayback(detail.grant?.token);
  if (playback.isPending) return <Skeleton className="h-24 w-full" />;
  if (playback.isError)
    return (
      <ErrorState
        title="The document could not be loaded"
        message={errorMessage(playback.error)}
        onRetry={() => playback.refetch()}
      />
    );
  return (
    <div className="rounded-lg border border-border bg-surface p-5">
      <div className="flex items-center gap-3">
        <FileText aria-hidden className="size-8 text-text-tertiary" />
        <div className="min-w-0 flex-1">
          <p className="font-medium">{playback.data.title}</p>
          <p className="text-sm text-text-secondary">{playback.data.mimeType}</p>
        </div>
        <Button asChild variant="primary" trailing={<ExternalLink className="size-4" />}>
          <a href={playback.data.url} target="_blank" rel="noopener noreferrer">
            Open
          </a>
        </Button>
      </div>
    </div>
  );
}

function ExternalLesson({ detail }: { detail: Detail }) {
  const url = typeof detail.lesson.config?.url === 'string' ? detail.lesson.config.url : null;
  return url ? (
    <Button asChild variant="primary" trailing={<ExternalLink className="size-4" />}>
      <a href={url} target="_blank" rel="noopener noreferrer">
        Open resource
      </a>
    </Button>
  ) : (
    <EmptyState title="No link has been set for this lesson" />
  );
}

function AcknowledgmentLesson({ detail }: { detail: Detail }) {
  const ack = useAcknowledge(detail.lesson.id);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | undefined>();
  const statement =
    typeof detail.lesson.config?.statement === 'string' ? detail.lesson.config.statement : '';
  return (
    <div className="grid gap-5">
      <Markdown>{statement}</Markdown>
      {detail.acknowledgment ? (
        <Notice tone="success" title="Acknowledged">
          Signed by {detail.acknowledgment.typedName} on{' '}
          {formatDateTime(detail.acknowledgment.acknowledgedAt)}.
        </Notice>
      ) : (
        <form
          className="grid max-w-md gap-3 rounded-lg border border-border bg-surface p-5"
          onSubmit={(e) => {
            e.preventDefault();
            setError(undefined);
            ack.mutate(name, {
              onError: (err) =>
                setError(
                  err instanceof ApiError
                    ? (err.fields[0]?.message ?? err.message)
                    : errorMessage(err),
                ),
            });
          }}
        >
          <Field
            label="Type your full name to acknowledge"
            error={error}
            hint="Use your first and last name as they appear on your account."
          >
            <Input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" />
          </Field>
          <div>
            <Button
              type="submit"
              variant="primary"
              loading={ack.isPending}
              disabled={name.trim().length < 3}
            >
              I acknowledge
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}

function AssignmentLesson({ detail }: { detail: Detail }) {
  const submit = useSubmitAssignment(detail.lesson.id);
  const s = detail.submission;
  const [text, setText] = useState(s?.status === 'rejected' ? s.body : '');
  const [error, setError] = useState<string | null>(null);
  const instructions =
    typeof detail.lesson.config?.instructions === 'string' ? detail.lesson.config.instructions : '';
  const waiting = s?.status === 'submitted';
  return (
    <div className="grid gap-5">
      <Markdown>{instructions}</Markdown>
      {s && (
        <div className="rounded-lg border border-border bg-surface p-4">
          <div className="mb-2 flex items-center justify-between gap-3">
            <p className="text-sm font-semibold">Your submission</p>
            {s.status === 'approved' ? (
              <StatusText tone="success">Approved</StatusText>
            ) : s.status === 'rejected' ? (
              <StatusText tone="danger">Needs changes</StatusText>
            ) : (
              <StatusText tone="information">Waiting for review</StatusText>
            )}
          </div>
          <p className="text-sm whitespace-pre-wrap text-text-secondary">{s.body}</p>
          {s.feedback && (
            <Notice
              className="mt-3"
              tone={s.status === 'approved' ? 'success' : 'warning'}
              title={s.reviewedBy ? `Feedback from ${s.reviewedBy.displayName}` : 'Feedback'}
            >
              {s.feedback}
            </Notice>
          )}
        </div>
      )}
      {!waiting && s?.status !== 'approved' && (
        <form
          className="grid gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            setError(null);
            submit.mutate(text, {
              onSuccess: () => toast.success('Submitted for review'),
              onError: (err) => setError(errorMessage(err)),
            });
          }}
        >
          <Field label={s ? 'Revise and resubmit' : 'Your response'} error={error ?? undefined}>
            <Textarea rows={9} value={text} onChange={(e) => setText(e.target.value)} />
          </Field>
          <div>
            <Button
              type="submit"
              variant="primary"
              loading={submit.isPending}
              disabled={text.trim().length < 10}
            >
              Submit for review
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}

function ApprovalLesson({ detail }: { detail: Detail }) {
  const request = useRequestApproval(detail.lesson.id);
  const a = detail.approval;
  const instructions =
    typeof detail.lesson.config?.instructions === 'string'
      ? detail.lesson.config.instructions
      : (detail.lesson.body ?? '');
  return (
    <div className="grid gap-5">
      <Markdown>{instructions}</Markdown>
      {!a || a.status === 'rejected' ? (
        <div className="grid gap-3">
          {a?.status === 'rejected' && (
            <Notice tone="warning" title="Your manager asked for more work first">
              {a.comment ??
                'Talk with your manager about what to improve, then request sign-off again.'}
            </Notice>
          )}
          <div>
            <Button
              variant="primary"
              loading={request.isPending}
              onClick={() =>
                request.mutate(null, {
                  onSuccess: () =>
                    toast.success('Sign-off requested', 'Your manager has been notified.'),
                  onError: (err) => toast.error('Could not send request', errorMessage(err)),
                })
              }
            >
              Request manager sign-off
            </Button>
          </div>
        </div>
      ) : a.status === 'pending' ? (
        <Notice tone="information" title="Waiting for your manager">
          Requested {formatDateTime(a.requestedAt)}. You'll be notified as soon as it is decided.
        </Notice>
      ) : (
        <Notice tone="success" title="Signed off">
          {a.decidedBy
            ? `${a.decidedBy.displayName} approved this on ${formatDateTime(a.decidedAt)}.`
            : 'Approved.'}
          {a.comment && <span className="mt-1 block">“{a.comment}”</span>}
        </Notice>
      )}
    </div>
  );
}

function AssessmentLesson({ detail, programId }: { detail: Detail; programId: string }) {
  const best = detail.progress.bestScore;
  return (
    <div className="rounded-lg border border-border bg-surface p-5">
      <p className="text-base">
        {detail.lesson.type === 'final_assessment'
          ? 'This is a graded assessment.'
          : 'This quiz is graded.'}{' '}
        Your best score counts toward unlocking what comes next.
      </p>
      {best !== null && (
        <p className="mt-1 text-sm text-text-secondary">
          Best score so far:{' '}
          <strong className="tabular font-medium text-text-primary">{Math.round(best)}%</strong>
        </p>
      )}
      <Button asChild variant="primary" size="lg" className="mt-4">
        <Link to={`/training/${programId}/lessons/${detail.lesson.id}/assessment`}>
          {best === null ? 'Start' : 'Open'}
        </Link>
      </Button>
    </div>
  );
}

function ManualComplete({ detail }: { detail: Detail }) {
  const complete = useCompleteLesson();
  const navigate = useNavigate();
  const { programId = '' } = useParams();
  if (!detail.completion.canCompleteManually || detail.state === 'completed') return null;
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-surface px-5 py-4">
      <p className="text-sm text-text-secondary">{detail.completion.hint}</p>
      <Button
        variant="primary"
        leading={<Check className="size-4" />}
        loading={complete.isPending}
        onClick={() =>
          complete.mutate(detail.lesson.id, {
            onSuccess: () => {
              toast.success('Lesson complete');
              if (detail.nextLessonId)
                navigate(`/training/${programId}/lessons/${detail.nextLessonId}`);
            },
            onError: (err) => toast.error('Could not mark complete', errorMessage(err)),
          })
        }
      >
        Mark complete
      </Button>
    </div>
  );
}

// ------------------------------------------------------------------ page

function Body({ detail, programId }: { detail: Detail; programId: string }) {
  const t = detail.lesson.type;
  if (t === 'video') return <VideoLesson detail={detail} />;
  if (t === 'article') return detail.lesson.body ? <Markdown>{detail.lesson.body}</Markdown> : null;
  if (t === 'pdf' || t === 'document') return <DocumentLesson detail={detail} />;
  if (t === 'external') return <ExternalLesson detail={detail} />;
  if (t === 'acknowledgment') return <AcknowledgmentLesson detail={detail} />;
  if (t === 'assignment') return <AssignmentLesson detail={detail} />;
  if (t === 'manager_approval') return <ApprovalLesson detail={detail} />;
  if (t === 'quiz' || t === 'final_assessment')
    return <AssessmentLesson detail={detail} programId={programId} />;
  return null;
}

function Sidebar({ programId, lessonId }: { programId: string; lessonId: string }) {
  const outline = useOutline(programId);
  if (!outline.data) return null;
  const phase = outline.data.phases.find((p) =>
    p.modules.some((m) => m.lessons.some((l) => l.id === lessonId)),
  );
  const module = phase?.modules.find((m) => m.lessons.some((l) => l.id === lessonId));
  if (!phase || !module) return null;
  return (
    <nav aria-label="Lessons in this module" className="rounded-lg border border-border bg-surface">
      <p className="border-b border-divider px-4 py-2.5 text-sm font-semibold">{module.title}</p>
      <ol className="py-1">
        {module.lessons.map((l) => (
          <li key={l.id}>
            {l.state === 'locked' ? (
              <span className="flex items-center gap-2.5 px-4 py-2 text-sm text-text-tertiary">
                <StateMark state="locked" />
                <span className="truncate">{l.title}</span>
              </span>
            ) : (
              <Link
                to={`/training/${programId}/lessons/${l.id}`}
                aria-current={l.id === lessonId ? 'page' : undefined}
                className={cn(
                  'flex items-center gap-2.5 px-4 py-2 text-sm hover:bg-surface-hover',
                  l.id === lessonId && 'bg-surface-selected font-medium',
                )}
              >
                <StateMark state={l.state} />
                <span className="truncate">{l.title}</span>
              </Link>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}

export function LessonPage() {
  const { programId = '', lessonId = '' } = useParams();
  const lesson = useLesson(lessonId);
  const start = useStartLesson();
  const startedFor = useRef<string | null>(null);

  useEffect(() => {
    const d = lesson.data;
    if (
      d &&
      d.state !== 'locked' &&
      d.progress.status === 'not_started' &&
      startedFor.current !== d.lesson.id
    ) {
      startedFor.current = d.lesson.id;
      start.mutate(d.lesson.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lesson.data?.lesson.id, lesson.data?.progress.status, lesson.data?.state]);

  if (lesson.isPending) return <Skeleton className="h-96 w-full" />;
  if (lesson.isError) {
    const gone = lesson.error instanceof ApiError && lesson.error.isNotFound;
    return (
      <>
        <PageHeader title="Lesson" breadcrumbs={[{ label: 'Training', to: '/training' }]} />
        {gone ? (
          <Notice tone="warning">This lesson is not available to you.</Notice>
        ) : (
          <ErrorState message={errorMessage(lesson.error)} onRetry={() => lesson.refetch()} />
        )}
      </>
    );
  }
  const d = lesson.data;
  const locked = d.state === 'locked';
  return (
    <>
      <PageHeader
        breadcrumbs={[
          { label: 'Training', to: '/training' },
          { label: d.program.title, to: `/training/${programId}` },
          { label: `${d.phase.label}: ${d.phase.title}` },
        ]}
        title={d.lesson.title}
        description={d.lesson.summary}
        meta={
          <>
            <span className="inline-flex items-center gap-1.5">
              <LessonTypeIcon type={d.lesson.type} className="size-4" />
              {lessonTypeLabel(d.lesson.type)}
            </span>
            <span>{d.lesson.estimatedMinutes} min</span>
            {!d.lesson.isRequired && <span>Optional</span>}
            {d.state === 'completed' && <StatusText tone="success">Completed</StatusText>}
          </>
        }
      />
      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_280px]">
        <div className="grid min-w-0 content-start gap-6">
          {locked ? (
            <Requirements items={d.requirements} title="This lesson is locked" />
          ) : (
            <Body detail={d} programId={programId} />
          )}
          {!locked && <ManualComplete detail={d} />}
          {d.lesson.resources.length > 0 && !locked && (
            <section aria-label="Resources">
              <h2 className="mb-1.5 text-sm font-semibold">Resources</h2>
              <ul className="divide-y divide-divider rounded-lg border border-border bg-surface">
                {d.lesson.resources.map((r) => (
                  <li key={r.id} className="px-4 py-2.5 text-sm">
                    {r.url ? (
                      <a
                        href={r.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="font-medium text-information hover:underline"
                      >
                        {r.title}
                      </a>
                    ) : (
                      <span className="font-medium">{r.title}</span>
                    )}
                    {r.description && (
                      <span className="block text-text-secondary">{r.description}</span>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}
          <div className="flex items-center justify-between gap-3 border-t border-divider pt-4">
            {d.previousLessonId ? (
              <Button asChild leading={<ArrowLeft className="size-4" />}>
                <Link to={`/training/${programId}/lessons/${d.previousLessonId}`}>Previous</Link>
              </Button>
            ) : (
              <span />
            )}
            {d.nextLessonId && (
              <Button
                asChild
                variant={d.state === 'completed' ? 'primary' : 'secondary'}
                trailing={<ArrowRight className="size-4" />}
              >
                <Link to={`/training/${programId}/lessons/${d.nextLessonId}`}>Next lesson</Link>
              </Button>
            )}
          </div>
        </div>
        <aside className="order-first lg:order-none">
          <div className="lg:sticky lg:top-6">
            <Sidebar programId={programId} lessonId={lessonId} />
          </div>
        </aside>
      </div>
    </>
  );
}
