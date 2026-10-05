import type { ReactNode } from 'react';
import { Link } from 'react-router';
import type { analytics } from '@a5/contracts';
import {
  BarList,
  LineChart,
  StatCell,
  StatRow,
  StatTile,
  type BarDatum,
  type LineSeries,
} from '@/components/charts';
import { StatusText, Table, TBody, Td, Th, THead, Tr } from '@/components/ui';
import { useCan } from '@/features/auth/session';
import { formatDate, formatRelative, pluralize } from '@/lib/format';
import { funnelSteps, formatDays, formatRatio, formatScore } from './funnel';

/** Headline figures in a hairline-separated row. */
export function KpiStrip({
  items,
}: {
  items: Array<{ label: string; value: ReactNode; context?: ReactNode }>;
}) {
  return (
    <StatRow>
      {items.map((i) => (
        <StatCell key={i.label}>
          <StatTile label={i.label} value={i.value} context={i.context} />
        </StatCell>
      ))}
    </StatRow>
  );
}

export function trendSeries(key: string, label: string, trend: analytics.Trend): LineSeries {
  return {
    key,
    label,
    points: trend.points.map((p) => ({ x: p.date, y: p.value })),
  };
}

/** Whether a trend has anything to plot (buckets without samples are gaps, not zeros). */
export function hasTrendData(trend: analytics.Trend | undefined): boolean {
  return Boolean(trend?.points.some((p) => p.value !== null));
}

export function TrendChart({
  series,
  ariaLabel,
  yDomain,
  formatY,
  height = 190,
}: {
  series: LineSeries[];
  ariaLabel: string;
  yDomain?: [number, number];
  formatY?: (n: number) => string;
  height?: number;
}) {
  return (
    <LineChart
      series={series}
      ariaLabel={ariaLabel}
      yDomain={yDomain}
      formatY={formatY}
      height={height}
    />
  );
}

/** Link to a person's drawer on the Team page when the viewer may open it. */
export function PersonLink({ person }: { person: { id: string; displayName: string } }) {
  const canOpen = useCan('enrollments.view');
  if (!canOpen) return <span className="font-medium">{person.displayName}</span>;
  return (
    <Link
      to={`/team?learner=${person.id}`}
      className="font-medium text-text-primary underline-offset-2 hover:underline"
    >
      {person.displayName}
    </Link>
  );
}

function RowList({ children, label }: { children: ReactNode; label: string }) {
  return (
    <ul aria-label={label} className="divide-y divide-divider border-y border-divider">
      {children}
    </ul>
  );
}

const REASON_LABEL: Record<analytics.FallingBehindItem['reasons'][number], string> = {
  overdue: 'Overdue',
  inactive: 'Inactive',
  behind_pace: 'Behind pace',
};

export function FallingBehindList({
  data,
  limit = 6,
  emptyText = 'Nobody is overdue, inactive or behind pace.',
}: {
  data: { total: number; items: analytics.FallingBehindItem[] };
  limit?: number;
  emptyText?: string;
}) {
  if (data.items.length === 0) return <p className="text-sm text-text-secondary">{emptyText}</p>;
  return (
    <>
      <RowList label="People falling behind">
        {data.items.slice(0, limit).map((i) => (
          <li
            key={i.enrollmentId}
            className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1 py-2.5"
          >
            <div className="min-w-0">
              <p className="truncate">
                <PersonLink person={i.person} />
              </p>
              <p className="truncate text-sm text-text-secondary">
                {i.programTitle} · {Math.round(i.progressPercent)}%
                {i.expectedPercent !== null && ` of ${Math.round(i.expectedPercent)}% expected`}
              </p>
            </div>
            <div className="ml-auto text-right text-sm">
              <p className="flex flex-wrap justify-end gap-x-2">
                {i.reasons.map((r) => (
                  <StatusText key={r} tone={r === 'overdue' ? 'danger' : 'warning'}>
                    {r === 'inactive'
                      ? `Inactive ${pluralize(i.daysInactive, 'day')}`
                      : REASON_LABEL[r]}
                  </StatusText>
                ))}
              </p>
              <p className="text-xs text-text-tertiary">
                {i.dueAt ? `Due ${formatDate(i.dueAt)}` : 'No due date'}
              </p>
            </div>
          </li>
        ))}
      </RowList>
      {data.total > limit && (
        <p className="mt-2 text-sm text-text-secondary">
          Showing {limit} of {data.total}.
        </p>
      )}
    </>
  );
}

export function AttentionList({
  data,
  limit = 6,
}: {
  data: analytics.TeamDashboard['requiringAttention'];
  limit?: number;
}) {
  if (data.items.length === 0)
    return (
      <p className="text-sm text-text-secondary">
        No failed assessments or low AI scores in this period.
      </p>
    );
  return (
    <>
      <RowList label="People who need coaching">
        {data.items.slice(0, limit).map((i) => (
          <li key={i.person.id} className="py-2.5">
            <div className="flex flex-wrap items-baseline justify-between gap-x-4">
              <PersonLink person={i.person} />
              <span className="text-xs text-text-tertiary">{formatRelative(i.latestAt)}</span>
            </div>
            <ul className="mt-0.5 text-sm text-text-secondary">
              {i.reasons.map((r) => (
                <li
                  key={`${r.kind}-${r.kind === 'failed_assessment' ? r.assessmentId : r.scenarioId}`}
                >
                  {r.kind === 'failed_assessment'
                    ? `${r.title}: ${Math.round(r.scorePercent)}% (pass mark ${Math.round(r.passingPercent)}%), ${pluralize(r.attempts, 'attempt')}`
                    : `${r.title}: scored ${Math.round(r.score)} (pass mark ${Math.round(r.passingScore)})`}
                </li>
              ))}
            </ul>
          </li>
        ))}
      </RowList>
      {data.total > limit && (
        <p className="mt-2 text-sm text-text-secondary">
          Showing {limit} of {data.total}.
        </p>
      )}
    </>
  );
}

export function ExpiringCertificates({
  data,
  limit = 6,
}: {
  data: analytics.TeamDashboard['expiringCertifications'];
  limit?: number;
}) {
  if (data.within90Days === 0)
    return (
      <p className="text-sm text-text-secondary">No certificates expire in the next 90 days.</p>
    );
  return (
    <>
      <p className="mb-2 text-sm text-text-secondary">
        <span className="tabular font-medium text-text-primary">{data.within30Days}</span> within 30
        days · <span className="tabular font-medium text-text-primary">{data.within60Days}</span>{' '}
        within 60 ·{' '}
        <span className="tabular font-medium text-text-primary">{data.within90Days}</span> within 90
      </p>
      <RowList label="Certificates expiring soon">
        {data.items.slice(0, limit).map((c) => (
          <li
            key={c.certificateId}
            className="flex flex-wrap items-baseline justify-between gap-x-4 py-2.5"
          >
            <div className="min-w-0">
              <p className="truncate">
                <PersonLink person={c.person} />
              </p>
              <p className="truncate text-sm text-text-secondary">{c.certificationName}</p>
            </div>
            <p className="ml-auto text-right text-sm">
              <span className={c.daysRemaining <= 30 ? 'font-medium text-warning' : undefined}>
                {pluralize(c.daysRemaining, 'day')} left
              </span>
              <span className="block text-xs text-text-tertiary">{formatDate(c.expiresAt)}</span>
            </p>
          </li>
        ))}
      </RowList>
    </>
  );
}

const ACTIVITY_LABEL: Record<analytics.ActivityKind, string> = {
  enrolled: 'Enrolled',
  lesson_completed: 'Finished a lesson',
  phase_completed: 'Finished a phase',
  program_completed: 'Finished a program',
  assessment_passed: 'Passed',
  assessment_failed: 'Did not pass',
  ai_session_scored: 'AI role-play',
  certificate_issued: 'Certificate issued',
  certificate_revoked: 'Certificate revoked',
  certificate_expired: 'Certificate expired',
};

export function RecentActivity({
  items,
  limit = 8,
}: {
  items: analytics.ActivityItem[];
  limit?: number;
}) {
  if (items.length === 0)
    return <p className="text-sm text-text-secondary">No learning activity in this period.</p>;
  return (
    <RowList label="Recent activity">
      {items.slice(0, limit).map((a) => (
        <li key={a.id} className="flex flex-wrap items-baseline justify-between gap-x-4 py-2">
          <p className="min-w-0 text-sm">
            <PersonLink person={a.person} />{' '}
            <span className="text-text-secondary">
              {ACTIVITY_LABEL[a.kind]}
              {a.title ? `: ${a.title}` : ''}
              {a.score !== null && ` (${Math.round(a.score)})`}
            </span>
          </p>
          <span className="shrink-0 text-xs text-text-tertiary">{formatRelative(a.at)}</span>
        </li>
      ))}
    </RowList>
  );
}

/** Weakest AI rubric categories and most-missed question categories, as ranked bars. */
export function WeakestAreas({ data }: { data: analytics.TeamDashboard['weakestAreas'] }) {
  const ai: BarDatum[] = data.aiCategories.map((c) => ({
    key: c.key,
    label: c.label,
    value: c.averageScore,
    meta: pluralize(c.sessions, 'session'),
  }));
  const questions: BarDatum[] = data.questionCategories.map((c) => ({
    key: c.categoryId ?? c.name,
    label: c.name,
    value: c.missRatePercent,
    meta: `${c.incorrect} of ${c.answered} missed`,
  }));
  if (ai.length === 0 && questions.length === 0)
    return (
      <p className="text-sm text-text-secondary">
        Not enough scored practice yet to show weak spots.
      </p>
    );
  return (
    <div className="grid gap-6 sm:grid-cols-2">
      {ai.length > 0 && (
        <div>
          <h3 className="mb-2 text-sm font-medium text-text-secondary">
            Lowest AI role-play categories (average score)
          </h3>
          <BarList data={ai} max={100} ariaLabel="Lowest AI role-play categories" />
        </div>
      )}
      {questions.length > 0 && (
        <div>
          <h3 className="mb-2 text-sm font-medium text-text-secondary">
            Most-missed quiz topics (miss rate)
          </h3>
          <BarList
            data={questions}
            max={100}
            format={(n) => `${Math.round(n)}%`}
            color="var(--a5-series-2)"
            ariaLabel="Most-missed quiz topics"
          />
        </div>
      )}
    </div>
  );
}

/**
 * Enrolled → completed → field ready → certified. The first two steps count enrollments, the
 * last two count people; the caption keeps that visible.
 */
export function FunnelPanel({ kpis }: { kpis: analytics.TeamKpis }) {
  const steps = funnelSteps(kpis);
  if (kpis.enrollments === 0)
    return <p className="text-sm text-text-secondary">Nobody is enrolled for this selection.</p>;
  return (
    <>
      <BarList
        ariaLabel="Completion funnel"
        max={Math.max(steps[0]!.value, 1)}
        format={(n) => n.toLocaleString()}
        data={steps.map((s) => ({
          key: s.key,
          label: s.label,
          value: s.value,
          meta:
            s.ofFirst === null
              ? undefined
              : `${s.ofFirst}% of enrolled${s.ofPrevious !== null && s.key !== 'completed' ? ` · ${s.ofPrevious}% of previous step` : ''}`,
        }))}
      />
      <p className="mt-2 text-xs text-text-tertiary">
        Enrolled and completed count enrollments; field ready (completed and passed a final
        assessment) and certified count people.
      </p>
    </>
  );
}

export function BreakdownBars({ rows, noun }: { rows: analytics.BreakdownRow[]; noun: string }) {
  const data: BarDatum[] = rows
    .filter((r) => r.programCompletion.denominator > 0)
    .map((r) => ({
      key: r.id,
      label: r.name,
      value: r.programCompletion.percent ?? 0,
      meta: `${pluralize(r.headcount, 'person', 'people')}${r.overdueEnrollments ? ` · ${r.overdueEnrollments} overdue` : ''}`,
    }))
    .sort((a, b) => b.value - a.value);
  return (
    <BarList
      data={data}
      max={100}
      format={(n) => `${Math.round(n)}%`}
      ariaLabel={`Program completion by ${noun}`}
      emptyText={`No enrollments by ${noun} for this selection yet.`}
    />
  );
}

export function DropOffTable({
  rows,
  limit = 6,
}: {
  rows: analytics.CompanyDashboard['dropOffLessons'];
  limit?: number;
}) {
  if (rows.length === 0)
    return <p className="text-sm text-text-secondary">No lessons are slowing learners down.</p>;
  return (
    <Table caption="Lessons where learners spend the longest">
      <THead>
        <tr>
          <Th>Lesson</Th>
          <Th className="hidden sm:table-cell">Type</Th>
          <Th>Average time on lesson</Th>
          <Th className="hidden md:table-cell">Waiting now</Th>
        </tr>
      </THead>
      <TBody>
        {rows.slice(0, limit).map((r) => (
          <Tr key={r.lessonId}>
            <Td>
              <span className="block font-medium">{r.title}</span>
              {r.phaseTitle && <span className="text-xs text-text-tertiary">{r.phaseTitle}</span>}
            </Td>
            <Td className="hidden text-text-secondary capitalize sm:table-cell">
              {r.lessonType ? r.lessonType.replace(/_/g, ' ') : '—'}
            </Td>
            <Td className="tabular">{formatDays(r.averageDwellDays)}</Td>
            <Td className="tabular hidden text-text-secondary md:table-cell">
              {r.stalledLearners > 0
                ? `${pluralize(r.stalledLearners, 'person', 'people')}${r.averageDaysStalled !== null ? `, ${formatDays(r.averageDaysStalled)}` : ''}`
                : '—'}
            </Td>
          </Tr>
        ))}
      </TBody>
    </Table>
  );
}

export function HardestQuestions({
  rows,
  limit = 5,
}: {
  rows: analytics.CompanyDashboard['hardestQuestions'];
  limit?: number;
}) {
  if (rows.length === 0)
    return (
      <p className="text-sm text-text-secondary">
        No question has enough answers yet to rank by difficulty.
      </p>
    );
  return (
    <Table caption="Hardest quiz questions">
      <THead>
        <tr>
          <Th>Question</Th>
          <Th className="hidden sm:table-cell">Assessment</Th>
          <Th>Missed</Th>
        </tr>
      </THead>
      <TBody>
        {rows.slice(0, limit).map((q) => (
          <Tr key={q.questionId}>
            <Td className="max-w-[320px]">
              <span className="line-clamp-2">{q.prompt ?? 'Question text unavailable'}</span>
              {q.categoryName && (
                <span className="text-xs text-text-tertiary">{q.categoryName}</span>
              )}
            </Td>
            <Td className="hidden text-text-secondary sm:table-cell">{q.assessmentTitle}</Td>
            <Td className="tabular">
              {Math.round(q.missRatePercent)}%
              <span className="block text-xs text-text-tertiary">
                {q.incorrect} of {q.answered}
              </span>
            </Td>
          </Tr>
        ))}
      </TBody>
    </Table>
  );
}

export function FailedObjections({
  rows,
  limit = 5,
}: {
  rows: analytics.CompanyDashboard['mostFailedObjections'];
  limit?: number;
}) {
  if (rows.length === 0)
    return <p className="text-sm text-text-secondary">No AI scenario has enough sessions yet.</p>;
  return (
    <Table caption="AI scenarios with the highest failure rate">
      <THead>
        <tr>
          <Th>Scenario</Th>
          <Th className="hidden sm:table-cell">Sessions</Th>
          <Th>Failed</Th>
          <Th className="hidden md:table-cell">Average score</Th>
        </tr>
      </THead>
      <TBody>
        {rows.slice(0, limit).map((s) => (
          <Tr key={s.scenarioId}>
            <Td>
              <span className="block font-medium">{s.title}</span>
              <span className="text-xs text-text-tertiary capitalize">
                {s.category} · {s.difficulty}
              </span>
            </Td>
            <Td className="tabular hidden sm:table-cell">{s.sessions}</Td>
            <Td className="tabular">{Math.round(s.failureRatePercent)}%</Td>
            <Td className="tabular hidden md:table-cell">{formatScore(s.averageScore)}</Td>
          </Tr>
        ))}
      </TBody>
    </Table>
  );
}

/** Shared by the company and team dashboards: the figures every audience starts with. */
export function teamKpiItems(kpis: analytics.TeamKpis) {
  return [
    {
      label: 'Active trainees',
      value: kpis.activeTrainees.toLocaleString(),
      context: `${kpis.headcount.toLocaleString()} in view`,
    },
    {
      label: 'Program completion',
      value: formatRatio(kpis.programCompletion),
      context: `${kpis.programCompletion.numerator} of ${kpis.programCompletion.denominator} enrollments`,
    },
    {
      label: 'Quiz average',
      value:
        kpis.averageAssessmentScore === null ? '—' : `${Math.round(kpis.averageAssessmentScore)}%`,
      context: pluralize(kpis.assessmentAttempts, 'attempt'),
    },
    {
      label: 'AI role-play average',
      value: formatScore(kpis.aiRolePlayAverage),
      context: pluralize(kpis.aiSessions, 'session'),
    },
    {
      label: 'Certified',
      value: kpis.certifiedCount.toLocaleString(),
      context: `${kpis.fieldReadyCount.toLocaleString()} field ready`,
    },
  ];
}

/** Organization-wide headline figures (company dashboard). */
export function companyKpiItems(k: analytics.CompanyKpis) {
  return [
    {
      label: 'Active trainees',
      value: k.activeTrainees.toLocaleString(),
      context: `${k.headcount.toLocaleString()} in view`,
    },
    {
      label: 'Training completion',
      value: formatRatio(k.trainingCompletionRate),
      context: `${k.trainingCompletionRate.numerator} of ${k.trainingCompletionRate.denominator} due or finished`,
    },
    {
      label: 'Overdue',
      value: k.overdueEnrollments.toLocaleString(),
      context: 'active enrollments past due',
    },
    { label: 'Average days to complete', value: formatDays(k.averageCompletionDays) },
    {
      label: 'Certified',
      value: k.certifiedCount.toLocaleString(),
      context: `${k.fieldReadyCount.toLocaleString()} field ready`,
    },
  ];
}
