import { useEffect, useRef } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { RotateCw } from 'lucide-react';
import type { ai } from '@a5/contracts';
import {
  Button,
  EmptyState,
  ErrorState,
  Notice,
  PageHeader,
  Section,
  Skeleton,
  Spinner,
  Tag,
  toast,
} from '@/components/ui';
import { RequirePermission } from '@/app/guards';
import { ApiError, errorMessage } from '@/lib/api/errors';
import { formatDateTime, pluralize } from '@/lib/format';
import { useRefreshPracticeStats, useRetryEvaluation, useSession, useStartSession } from './api';
import { useConversationContext } from './conversation-context';
import { Difficulty, ScoreMeter } from './ui';
import { EvidenceQuote, Transcript, TranscriptProvider } from './transcript';

/** Poll quickly at first, then ease off; stop once the scorecard exists or scoring failed. */
export function scorecardPollInterval(session: ai.Session | undefined, now = Date.now()) {
  if (!session || (session.status !== 'ended' && session.status !== 'evaluating')) return false;
  const since = session.endedAt ? now - new Date(session.endedAt).getTime() : 0;
  return since < 30_000 ? 2_000 : 5_000;
}

const SLOW_SCORING_MS = 90_000;

function useTryAgain(session: ai.Session) {
  const navigate = useNavigate();
  const start = useStartSession();
  const run = () =>
    start.mutate(
      { scenarioId: session.scenario.id, test: session.isTest },
      {
        onSuccess: (next) => navigate(`/ai-coach/sessions/${next.id}`),
        onError: (err) => toast.error('Could not start a new conversation', errorMessage(err)),
      },
    );
  return { run, pending: start.isPending };
}

function Actions({ session, passed }: { session: ai.Session; passed?: boolean }) {
  const again = useTryAgain(session);
  const { programId, lessonId } = session.context;
  const lessonLink =
    session.mode === 'assigned' && programId && lessonId
      ? `/training/${programId}/lessons/${lessonId}`
      : null;
  return (
    <div className="flex flex-wrap gap-2">
      {lessonLink ? (
        <>
          <Button asChild variant="primary">
            <Link to={lessonLink}>
              {passed ? 'Back to the lesson' : 'Try again from the lesson'}
            </Link>
          </Button>
          <Button
            onClick={again.run}
            loading={again.pending}
            leading={<RotateCw className="size-4" />}
          >
            Practice again
          </Button>
        </>
      ) : (
        <Button
          variant="primary"
          onClick={again.run}
          loading={again.pending}
          leading={<RotateCw className="size-4" />}
        >
          Try again
        </Button>
      )}
      {session.isTest ? (
        <Button asChild>
          <Link to={`/content/ai-scenarios/${session.scenario.id}`}>Back to scenario</Link>
        </Button>
      ) : (
        <Button asChild>
          <Link to="/ai-coach">All scenarios</Link>
        </Button>
      )}
    </div>
  );
}

function Pending({ session }: { session: ai.Session }) {
  const waited = session.endedAt ? Date.now() - new Date(session.endedAt).getTime() : 0;
  return (
    <div className="flex items-start gap-3 rounded-lg border border-border bg-surface px-5 py-4">
      <Spinner size={18} className="mt-1 text-text-secondary" />
      <div>
        <p className="font-semibold">Scoring your conversation</p>
        <p className="text-sm text-text-secondary">
          Your replies are being checked against the rubric. This page updates when the scorecard is
          ready.
        </p>
        {waited > SLOW_SCORING_MS && (
          <p className="mt-2 text-sm text-text-secondary">
            This is taking longer than usual. You can leave this page; the scorecard will be in your
            history when it finishes.
          </p>
        )}
      </div>
    </div>
  );
}

function ScoringFailed({ session }: { session: ai.Session }) {
  const retry = useRetryEvaluation(session.id);
  return (
    <Notice
      tone="danger"
      title="Scoring did not finish"
      action={
        <Button
          size="sm"
          loading={retry.isPending}
          onClick={() =>
            retry.mutate(undefined, {
              onError: (err) => toast.error('Could not restart scoring', errorMessage(err)),
            })
          }
          leading={<RotateCw className="size-3.5" />}
        >
          Retry scoring
        </Button>
      }
    >
      {session.evaluationError ?? 'The scorecard could not be generated. Try again in a moment.'}
    </Notice>
  );
}

function percentShare(weight: number, total: number): string {
  if (total <= 0 || weight <= 0) return 'Not weighted';
  const share = (weight / total) * 100;
  return `${share >= 10 ? Math.round(share) : Math.round(share * 10) / 10}% of score`;
}

function Criteria({ card }: { card: ai.Scorecard }) {
  const total = card.categoryScores.reduce((sum, c) => sum + c.weight, 0);
  return (
    <ul className="divide-y divide-divider overflow-hidden rounded-lg border border-border bg-surface">
      {card.categoryScores.map((c) => (
        <li key={c.key}>
          <details className="group">
            <summary className="grid min-h-14 cursor-pointer list-none grid-cols-[1fr_auto] items-center gap-x-4 gap-y-1.5 px-4 py-3 hover:bg-surface-hover [&::-webkit-details-marker]:hidden">
              <span className="min-w-0">
                <span className="block font-medium">{c.label}</span>
                <span className="block text-xs text-text-secondary">
                  {percentShare(c.weight, total)}
                </span>
              </span>
              <span className="tabular text-right text-lg font-semibold">
                {c.score}
                <span className="text-sm font-normal text-text-secondary"> / 100</span>
              </span>
              <span className="col-span-2">
                <ScoreMeter
                  score={c.score}
                  passMark={card.passingScore}
                  label={`${c.label} score`}
                />
              </span>
            </summary>
            <div className="grid gap-3 px-4 pt-1 pb-4 text-sm">
              <p className="whitespace-pre-wrap text-text-primary">{c.rationale}</p>
              {c.evidence.length > 0 ? (
                c.evidence.map((e, i) => (
                  <EvidenceQuote key={`${e.seq}-${i}`} seq={e.seq} quote={e.quote} />
                ))
              ) : (
                <p className="text-text-secondary">No specific line was cited for this score.</p>
              )}
            </div>
          </details>
        </li>
      ))}
    </ul>
  );
}

function Result({ card, session }: { card: ai.Scorecard; session: ai.Session }) {
  const gap = card.passingScore - card.overallScore;
  return (
    <section
      aria-labelledby="result-heading"
      className="grid gap-5 rounded-lg border border-border bg-surface p-5 sm:grid-cols-[auto_1fr] sm:gap-8"
    >
      <div>
        <h2 id="result-heading" className="text-xs font-medium text-text-secondary">
          Overall score
        </h2>
        <p className="tabular mt-1 text-3xl leading-none font-semibold tracking-[-0.02em]">
          {card.overallScore}
          <span className="ml-1 text-base font-normal text-text-secondary">/ 100</span>
        </p>
        <p
          className={`mt-2 text-sm font-semibold ${card.passed ? 'text-success' : 'text-warning'}`}
        >
          {card.passed ? 'Passed' : 'Below the pass mark'}
        </p>
      </div>
      <div className="grid content-start gap-3">
        <div>
          <ScoreMeter
            score={card.overallScore}
            passMark={card.passingScore}
            label="Overall score"
            size="lg"
          />
          <p className="tabular mt-2 text-sm text-text-secondary">
            Pass mark {card.passingScore}.{' '}
            {card.passed
              ? `You scored ${card.overallScore - card.passingScore} above it.`
              : `You are ${pluralize(gap, 'point')} short.`}
          </p>
        </div>
        <p className="max-w-[70ch] text-base whitespace-pre-wrap">{card.summary}</p>
        {card.nextGoal && (
          <p className="max-w-[70ch] border-t border-divider pt-3 text-sm">
            <span className="font-semibold">Next goal: </span>
            {card.nextGoal}
          </p>
        )}
        <Actions session={session} passed={card.passed} />
      </div>
    </section>
  );
}

function Feedback({ card }: { card: ai.Scorecard }) {
  return (
    <>
      {card.strengths.length > 0 && (
        <Section title="What went well" id="strengths">
          <ul className="grid gap-5">
            {card.strengths.map((s, i) => (
              <li key={i} className="grid gap-2">
                <p className="max-w-[70ch]">{s.point}</p>
                {s.evidence.map((e, j) => (
                  <EvidenceQuote key={j} seq={e.seq} quote={e.quote} />
                ))}
              </li>
            ))}
          </ul>
        </Section>
      )}

      {card.missedOpportunities.length > 0 && (
        <Section title="What to work on" id="improvements">
          <ul className="grid gap-5">
            {card.missedOpportunities.map((m, i) => (
              <li key={i} className="grid gap-2">
                <p className="max-w-[70ch] font-medium">{m.point}</p>
                {m.quote && <EvidenceQuote seq={m.seq} quote={m.quote} />}
                <p className="max-w-[70ch] text-sm text-text-secondary">
                  <span className="font-medium text-text-primary">Try instead: </span>
                  {m.betterApproach}
                </p>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {card.riskyStatements.length > 0 && (
        <Section
          title="Statements to avoid"
          description="Things said that could create a compliance or trust problem with a real homeowner."
          id="risky"
        >
          <ul className="grid gap-4">
            {card.riskyStatements.map((r, i) => (
              <li
                key={i}
                className="grid gap-2 rounded-lg border border-warning/30 bg-warning-soft px-4 py-3"
              >
                <EvidenceQuote seq={r.seq} quote={r.quote} />
                <p className="text-sm">{r.issue}</p>
                <p className="text-sm text-text-secondary">
                  <span className="font-medium text-text-primary">Safer wording: </span>
                  {r.saferAlternative}
                </p>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {card.recommendedResponses.length > 0 && (
        <Section title="Stronger responses" id="responses">
          <ul className="grid gap-5">
            {card.recommendedResponses.map((r, i) => (
              <li key={i} className="grid gap-2">
                {r.repSaid && <EvidenceQuote seq={r.seq} quote={r.repSaid} />}
                <p className="max-w-[70ch] text-sm">
                  <span className="font-medium">Try: </span>
                  {r.betterResponse}
                </p>
                <p className="max-w-[70ch] text-sm text-text-secondary">{r.why}</p>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {card.questionsToAsk.length > 0 && (
        <Section title="Questions worth asking" id="questions">
          <ul className="grid gap-3">
            {card.questionsToAsk.map((q, i) => (
              <li key={i} className="max-w-[70ch]">
                <p className="font-medium">{q.question}</p>
                <p className="text-sm text-text-secondary">{q.why}</p>
              </li>
            ))}
          </ul>
        </Section>
      )}
    </>
  );
}

function CoachFeedback({ reviews }: { reviews: ai.Review[] }) {
  if (reviews.length === 0) return null;
  const label = { ready: 'Ready', practice_again: 'Practice again', retrain: 'Retrain' } as const;
  return (
    <Section title="Coach feedback" id="coach">
      <ul className="grid gap-3">
        {reviews.map((r) => (
          <li key={r.id} className="rounded-lg border border-border bg-surface px-4 py-3">
            <p className="flex flex-wrap items-center gap-x-3 text-sm">
              <span className="font-semibold">{r.reviewer.displayName}</span>
              <Tag tone={r.recommendation === 'ready' ? 'success' : 'warning'}>
                {label[r.recommendation]}
              </Tag>
              <span className="text-text-secondary">{formatDateTime(r.createdAt)}</span>
            </p>
            <p className="mt-1.5 max-w-[70ch] text-sm whitespace-pre-wrap">{r.comment}</p>
          </li>
        ))}
      </ul>
    </Section>
  );
}

function ScorecardView({ session }: { session: ai.Session }) {
  const context = useConversationContext(session);
  const card = session.evaluation;
  const refreshStats = useRefreshPracticeStats();
  const refreshed = useRef(false);
  const status = session.status;
  const ready = status === 'evaluated' && card !== null;

  useEffect(() => {
    // Best score and attempts on the scenario list change when a scorecard lands.
    if (ready && !refreshed.current) {
      refreshed.current = true;
      refreshStats();
    }
  });

  const back = session.isTest
    ? { label: 'Scenario', to: `/content/ai-scenarios/${session.scenario.id}` }
    : { label: 'AI Coach', to: '/ai-coach' };

  return (
    <TranscriptProvider messages={session.messages} linkable={!session.transcriptPurged}>
      <PageHeader
        breadcrumbs={[{ label: back.label, to: back.to }, { label: session.scenario.title }]}
        title="Scorecard"
        meta={
          <>
            <span className="font-medium text-text-primary">{session.scenario.title}</span>
            <Difficulty level={session.scenario.difficulty} />
            <span>{session.scenario.category}</span>
            <span>{formatDateTime(session.startedAt)}</span>
            <span className="tabular">{pluralize(session.turnCount, 'turn')}</span>
            {session.isTest && <Tag tone="warning">Test run</Tag>}
          </>
        }
      />

      <p role="status" className="sr-only">
        {ready ? 'Your scorecard is ready.' : ''}
      </p>

      <div className="grid gap-8">
        {status === 'active' && (
          <Notice
            tone="information"
            title="This conversation is still going"
            action={
              <Button asChild size="sm">
                <Link to={`/ai-coach/sessions/${session.id}`}>Continue</Link>
              </Button>
            }
          >
            The scorecard appears after you end the conversation.
          </Notice>
        )}

        {status === 'abandoned' && (
          <EmptyState
            title="Nothing to score"
            description="This conversation ended before you said anything. Start again when you are ready."
            action={<Actions session={session} />}
          />
        )}

        {(status === 'ended' || status === 'evaluating') && <Pending session={session} />}
        {status === 'evaluation_failed' && <ScoringFailed session={session} />}

        {ready && card && (
          <>
            {card.provider.simulated && (
              <Notice tone="information" title="Scored by the development simulator">
                This scorecard is scripted for testing and does not reflect real coaching.
              </Notice>
            )}
            <Result card={card} session={session} />
            <Section
              title="How you scored"
              description="Open a row for the reasoning and the lines it is based on."
              id="criteria"
            >
              <Criteria card={card} />
            </Section>
            <Feedback card={card} />
            <p className="text-xs text-text-secondary">
              Scored {formatDateTime(card.evaluatedAt)} by {card.provider.label}
              {card.provider.model ? ` (${card.provider.model})` : ''}.
            </p>
          </>
        )}

        <CoachFeedback reviews={session.reviews} />

        {status !== 'active' && status !== 'abandoned' && (
          <Section title="Transcript" id="transcript" className="mb-0">
            <Transcript
              messages={session.messages}
              personaName={context.personaName}
              purged={session.transcriptPurged}
            />
          </Section>
        )}
      </div>
    </TranscriptProvider>
  );
}

function ScorecardLoader({ id }: { id: string }) {
  const session = useSession(id, { refetch: (s) => scorecardPollInterval(s) });
  if (session.isPending)
    return (
      <div className="grid gap-4" aria-busy="true" aria-label="Loading scorecard">
        <Skeleton className="h-7 w-48" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  if (session.isError) {
    const gone = session.error instanceof ApiError && session.error.isNotFound;
    return gone ? (
      <EmptyState
        title="This scorecard is not available"
        description="It may belong to someone else, or it was removed under the retention policy."
        action={
          <Button asChild>
            <Link to="/ai-coach">Back to AI Coach</Link>
          </Button>
        }
        className="mx-auto mt-10 max-w-xl"
      />
    ) : (
      <ErrorState
        title="The scorecard could not be loaded"
        message={errorMessage(session.error)}
        onRetry={() => session.refetch()}
      />
    );
  }
  return <ScorecardView session={session.data} />;
}

export function ScorecardPage() {
  const { id = '' } = useParams();
  return (
    <RequirePermission any={['ai_practice.use', 'ai_scenarios.update']}>
      <ScorecardLoader id={id} />
    </RequirePermission>
  );
}
