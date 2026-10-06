import { useState } from 'react';
import { Link } from 'react-router';
import { CalendarClock, ChevronDown, ChevronRight, UserMinus, UserPlus } from 'lucide-react';
import type { analytics, learning } from '@a5/contracts';
import {
  Button,
  ConfirmDialog,
  DialogContent,
  DialogRoot,
  ErrorState,
  Field,
  Input,
  ProgressBar,
  SheetContent,
  Skeleton,
  StatusText,
  Table,
  TBody,
  Td,
  Th,
  THead,
  Tr,
  toast,
} from '@/components/ui';
import { LineChart } from '@/components/charts';
import { useCan } from '@/features/auth/session';
import { useLearnerSummary } from '@/features/analytics/api';
import { errorMessage } from '@/lib/api/errors';
import { formatDate, formatDateTime, formatRelative } from '@/lib/format';
import {
  endOfDayIso,
  useEnrollmentDetail,
  useLearnerProgress,
  useSetDueDate,
  useWithdraw,
} from './api';
import { AttentionFlags } from './attention';

const STATE_LABEL: Record<learning.NodeState, string> = {
  locked: 'Locked',
  available: 'Not started',
  in_progress: 'In progress',
  completed: 'Completed',
};

function lessonTone(state: learning.NodeState) {
  return state === 'completed' ? 'success' : state === 'in_progress' ? 'information' : 'neutral';
}

function EnrollmentLessons({ enrollmentId }: { enrollmentId: string }) {
  const detail = useEnrollmentDetail(enrollmentId);
  if (detail.isPending) return <Skeleton className="mt-2 h-24 w-full" />;
  if (detail.isError)
    return (
      <ErrorState
        className="mt-2"
        title="Lesson progress could not be loaded"
        message={errorMessage(detail.error)}
        onRetry={() => detail.refetch()}
      />
    );
  const phases = detail.data.phases;
  return (
    <div className="mt-3 flex flex-col gap-4">
      {phases.map((phase) => {
        const lessons = detail.data.lessons.filter((l) => l.phaseId === phase.id);
        if (lessons.length === 0) return null;
        return (
          <div key={phase.id}>
            <p className="text-sm font-medium text-text-primary">
              {phase.label}: {phase.title}
              <span className="ml-2 font-normal text-text-tertiary">
                {Math.round(phase.percent)}%
              </span>
            </p>
            <ul className="mt-1 divide-y divide-divider border-y border-divider">
              {lessons.map((l) => (
                <li key={l.lessonId} className="flex items-center justify-between gap-3 py-1.5">
                  <span className="min-w-0 truncate text-sm">
                    {l.title}
                    {!l.isRequired && <span className="ml-1.5 text-text-tertiary">Optional</span>}
                  </span>
                  <span className="shrink-0 text-right text-xs text-text-secondary">
                    <StatusText tone={lessonTone(l.state)}>{STATE_LABEL[l.state]}</StatusText>
                    {l.completedAt && <span className="block">{formatDate(l.completedAt)}</span>}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

function DueDateDialog({
  row,
  open,
  onOpenChange,
}: {
  row: learning.TeamProgressRow;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const setDue = useSetDueDate(row.enrollmentId);
  const [date, setDate] = useState(row.dueAt ? row.dueAt.slice(0, 10) : '');
  const [error, setError] = useState<string | null>(null);
  const submit = async (value: string | null) => {
    setError(null);
    try {
      await setDue.mutateAsync(value ? endOfDayIso(value) : null);
      toast.success(value ? 'Due date updated' : 'Due date removed');
      onOpenChange(false);
    } catch (err) {
      setError(errorMessage(err));
    }
  };
  return (
    <DialogRoot open={open} onOpenChange={onOpenChange}>
      <DialogContent
        size="sm"
        title="Due date"
        description={`${row.learner.displayName} · ${row.program.title}`}
        footer={
          <>
            {row.dueAt && (
              <Button
                className="mr-auto"
                disabled={setDue.isPending}
                onClick={() => void submit(null)}
              >
                Remove due date
              </Button>
            )}
            <Button onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button
              variant="primary"
              loading={setDue.isPending}
              disabled={!date}
              onClick={() => void submit(date)}
            >
              Save
            </Button>
          </>
        }
      >
        <Field label="Due on" error={error ?? undefined}>
          <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </Field>
      </DialogContent>
    </DialogRoot>
  );
}

function EnrollmentCard({ row }: { row: learning.TeamProgressRow }) {
  const canWithdraw = useCan('enrollments.manage');
  const canDue = useCan('programs.assign') || canWithdraw;
  const [expanded, setExpanded] = useState(false);
  const [dueOpen, setDueOpen] = useState(false);
  const [withdrawOpen, setWithdrawOpen] = useState(false);
  const withdraw = useWithdraw(row.enrollmentId);
  const [withdrawError, setWithdrawError] = useState<string | null>(null);
  const active = row.status === 'active';
  return (
    <li className="py-4 first:pt-0">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-medium">{row.program.title}</p>
          <p className="text-sm text-text-secondary">
            {row.status === 'completed'
              ? 'Completed'
              : row.status === 'withdrawn'
                ? 'Withdrawn'
                : row.currentPhase
                  ? `${row.currentPhase.label}: ${row.currentPhase.title}`
                  : 'Not started'}
          </p>
        </div>
        <p className="text-sm text-text-secondary">
          {row.dueAt ? (
            <span className={row.overdue ? 'font-medium text-danger' : undefined}>
              Due {formatDate(row.dueAt)}
            </span>
          ) : (
            'No due date'
          )}
        </p>
      </div>
      <ProgressBar
        className="mt-2"
        value={row.progressPercent}
        label={`Progress in ${row.program.title}`}
        tone={row.status === 'completed' ? 'success' : 'accent'}
        showValue
      />
      <p className="mt-1 text-xs text-text-tertiary">
        {row.requiredCompleted} of {row.requiredTotal} required lessons · enrolled{' '}
        {formatDate(row.enrolledAt)} ·{' '}
        {row.lastActivityAt
          ? `last activity ${formatRelative(row.lastActivityAt)}`
          : 'no activity yet'}
      </p>
      {row.attention.length > 0 && <AttentionFlags flags={row.attention} className="mt-3" />}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="ghost"
          aria-expanded={expanded}
          leading={
            expanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />
          }
          onClick={() => setExpanded((e) => !e)}
        >
          Lesson progress
        </Button>
        {active && canDue && (
          <Button
            size="sm"
            variant="ghost"
            leading={<CalendarClock className="size-3.5" />}
            onClick={() => setDueOpen(true)}
          >
            {row.dueAt ? 'Change due date' : 'Set due date'}
          </Button>
        )}
        {active && canWithdraw && (
          <Button
            size="sm"
            variant="ghost"
            leading={<UserMinus className="size-3.5" />}
            onClick={() => setWithdrawOpen(true)}
          >
            Withdraw
          </Button>
        )}
      </div>
      {expanded && <EnrollmentLessons enrollmentId={row.enrollmentId} />}
      {dueOpen && <DueDateDialog row={row} open={dueOpen} onOpenChange={setDueOpen} />}
      <ConfirmDialog
        open={withdrawOpen}
        onOpenChange={(o) => {
          setWithdrawOpen(o);
          if (!o) setWithdrawError(null);
        }}
        title={`Withdraw ${row.learner.displayName}?`}
        description={`They will no longer see ${row.program.title} in their training. Their progress is kept, and you can enroll them again later.`}
        confirmLabel="Withdraw"
        tone="danger"
        reasonLabel="Reason"
        loading={withdraw.isPending}
        error={withdrawError}
        onConfirm={async (reason) => {
          setWithdrawError(null);
          try {
            await withdraw.mutateAsync(reason);
            toast.success('Withdrawn from program');
            setWithdrawOpen(false);
          } catch (err) {
            setWithdrawError(errorMessage(err));
          }
        }}
      />
    </li>
  );
}

interface Score {
  id: string;
  title: string;
  bestScore: number;
  lastScore: number;
  passed: boolean;
  attempts: number;
  lastAt: string;
}

function ScoreTable({
  caption,
  rows,
  cohort,
  unit,
}: {
  caption: string;
  rows: Score[];
  cohort: Map<string, number | null>;
  unit: string;
}) {
  if (rows.length === 0) return null;
  const showCohort = rows.some((r) => cohort.get(r.id) != null);
  return (
    <Table caption={caption}>
      <THead>
        <tr>
          <Th>Title</Th>
          <Th>Best</Th>
          <Th className="hidden sm:table-cell">Last</Th>
          {showCohort && <Th className="hidden sm:table-cell">Peers</Th>}
          <Th>Result</Th>
        </tr>
      </THead>
      <TBody>
        {rows.map((r) => (
          <Tr key={r.id}>
            <Td>
              <span className="block font-medium">{r.title}</span>
              <span className="text-xs text-text-tertiary">
                {r.attempts} {r.attempts === 1 ? 'attempt' : 'attempts'} ·{' '}
                {formatRelative(r.lastAt)}
              </span>
            </Td>
            <Td className="tabular">
              {Math.round(r.bestScore)}
              {unit}
            </Td>
            <Td className="tabular hidden sm:table-cell">
              {Math.round(r.lastScore)}
              {unit}
            </Td>
            {showCohort && (
              <Td className="tabular hidden text-text-secondary sm:table-cell">
                {cohort.get(r.id) != null ? `${Math.round(cohort.get(r.id)!)}${unit}` : '—'}
              </Td>
            )}
            <Td>
              <StatusText tone={r.passed ? 'success' : 'danger'}>
                {r.passed ? 'Passed' : 'Not passed'}
              </StatusText>
            </Td>
          </Tr>
        ))}
      </TBody>
    </Table>
  );
}

function Content({ userId, onAssign }: { userId: string; onAssign?: () => void }) {
  const progress = useLearnerProgress(userId);
  const canAnalytics = useCan('analytics.view');
  const summary = useLearnerSummary(canAnalytics ? userId : null);
  const canProfile = useCan('users.view');
  if (progress.isPending) return <Skeleton className="h-64 w-full" />;
  if (progress.isError)
    return <ErrorState message={errorMessage(progress.error)} onRetry={() => progress.refetch()} />;
  const { learner, enrollments, assessments, aiScenarios } = progress.data;
  const quizCohort = new Map<string, number | null>(
    summary.data?.quizScores.map((q) => [q.assessmentId, q.cohortAverage]) ?? [],
  );
  const trend = summary.data?.progressTrend;
  return (
    <div className="flex flex-col gap-7">
      <section aria-labelledby="learner-enrollments">
        <h3 id="learner-enrollments" className="mb-2 text-md font-semibold">
          Programs
        </h3>
        {enrollments.length === 0 ? (
          <p className="text-sm text-text-secondary">Not enrolled in any program.</p>
        ) : (
          <ul className="divide-y divide-divider">
            {enrollments.map((row) => (
              <EnrollmentCard key={row.enrollmentId} row={row} />
            ))}
          </ul>
        )}
      </section>

      {trend && trend.points.length > 1 && (
        <section aria-labelledby="learner-trend">
          <h3 id="learner-trend" className="mb-2 text-md font-semibold">
            Progress over time
          </h3>
          <LineChart
            ariaLabel={`Progress in ${trend.programTitle} over time`}
            height={170}
            yDomain={[0, 100]}
            formatY={(n) => `${Math.round(n)}%`}
            series={[
              {
                key: 'progress',
                label: 'Progress',
                points: trend.points.map((p) => ({ x: p.date, y: p.progressPercent })),
              },
            ]}
          />
        </section>
      )}

      {assessments.length > 0 && (
        <section aria-labelledby="learner-assessments">
          <h3 id="learner-assessments" className="mb-2 text-md font-semibold">
            Quizzes and exams
          </h3>
          <ScoreTable caption="Assessment scores" rows={assessments} cohort={quizCohort} unit="%" />
        </section>
      )}

      {aiScenarios.length > 0 && (
        <section aria-labelledby="learner-ai">
          <h3 id="learner-ai" className="mb-2 text-md font-semibold">
            AI role-play
          </h3>
          <ScoreTable caption="AI role-play scores" rows={aiScenarios} cohort={new Map()} unit="" />
        </section>
      )}

      <SummaryNote summary={summary.data} />

      <div className="flex flex-wrap gap-2 border-t border-divider pt-4">
        {onAssign && (
          <Button leading={<UserPlus className="size-4" />} onClick={onAssign}>
            Assign program
          </Button>
        )}
        {canProfile && (
          <Button asChild variant="ghost">
            <Link to={`/people/${learner.id}`}>Open profile</Link>
          </Button>
        )}
      </div>
    </div>
  );
}

/** Peer averages are hidden by the API for small cohorts; say so instead of showing nothing. */
function SummaryNote({ summary }: { summary: analytics.LearnerSummary | undefined }) {
  if (!summary) return null;
  const { comparisons } = summary;
  if (comparisons.cohortSize >= comparisons.minimumCohortSize) return null;
  return (
    <p className="text-xs text-text-tertiary">
      Peer averages are hidden until at least {comparisons.minimumCohortSize} other people are in
      the same programs, so no one can be identified from them. Generated{' '}
      {formatDateTime(summary.generatedAt)}.
    </p>
  );
}

/** Per-person drill-in, opened from the team table. State lives in the URL (`?learner=`). */
export function LearnerDrawer({
  userId,
  onClose,
  onAssign,
}: {
  userId: string | null;
  onClose: () => void;
  onAssign?: () => void;
}) {
  const progress = useLearnerProgress(userId);
  const learner = progress.data?.learner;
  return (
    <DialogRoot open={Boolean(userId)} onOpenChange={(o) => !o && onClose()}>
      <SheetContent
        title={learner?.displayName ?? 'Learner progress'}
        description={
          learner
            ? [learner.jobTitle, learner.teams.map((t) => t.name).join(', '), learner.email]
                .filter(Boolean)
                .join(' · ')
            : undefined
        }
      >
        {userId && <Content userId={userId} onAssign={onAssign} />}
      </SheetContent>
    </DialogRoot>
  );
}
