import { useEffect, useRef, useState } from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router';
import { ArrowLeft } from 'lucide-react';
import type { ai } from '@a5/contracts';
import {
  Button,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  Skeleton,
  Spinner,
  Tag,
} from '@/components/ui';
import { RequirePermission } from '@/app/guards';
import { ApiError, errorMessage } from '@/lib/api/errors';
import { cn } from '@/lib/cn';
import { pluralize } from '@/lib/format';
import { useEndSession, useSession } from './api';
import { Composer, HomeownerBubble, RepBubble, RetryReplyBar } from './chat-parts';
import { turnsRemaining, type ChatState } from './chat-state';
import { useConversationContext, type ConversationContext } from './conversation-context';
import { useChat } from './use-chat';
import { Difficulty, END_REASON_TEXT } from './ui';

function nearBottom(): boolean {
  const el = document.documentElement;
  return el.scrollHeight - (window.scrollY + window.innerHeight) < 180;
}

/** Polite one-shot announcements; streamed words are never read out one by one. */
function announcementFor(state: ChatState, personaName: string, initialLastId: string | null) {
  const lastHomeowner = [...state.messages].reverse().find((m) => m.role === 'homeowner');
  const replying = state.phase === 'waiting' || state.phase === 'streaming';
  if (replying) return 'The homeowner is replying.';
  if (state.phase === 'recovering') return 'Connection lost. Checking for the reply.';
  if (lastHomeowner && lastHomeowner.id !== initialLastId)
    return `${personaName} said: ${lastHomeowner.content}`;
  return '';
}

function BriefDisclosure({
  context,
  defaultOpen,
}: {
  context: ConversationContext;
  defaultOpen: boolean;
}) {
  if (!context.repBrief) return null;
  return (
    <details open={defaultOpen} className="group rounded-lg border border-border bg-surface">
      <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 px-4 text-sm font-medium [&::-webkit-details-marker]:hidden">
        Your brief for this door
        <span aria-hidden className="text-text-secondary group-open:hidden">
          Show
        </span>
        <span aria-hidden className="hidden text-text-secondary group-open:inline">
          Hide
        </span>
      </summary>
      <div className="grid gap-3 border-t border-divider px-4 py-3 text-sm">
        <p className="whitespace-pre-wrap text-text-primary">{context.repBrief}</p>
        {context.personaDescription && (
          <p className="text-text-secondary">
            <span className="font-medium text-text-primary">{context.personaName}. </span>
            {context.personaDescription}
          </p>
        )}
        {context.scoredOn.length > 0 && (
          <p className="text-text-secondary">
            <span className="font-medium text-text-primary">Scored on: </span>
            {context.scoredOn.join(', ')}.
          </p>
        )}
      </div>
    </details>
  );
}

function TurnCounter({ state }: { state: ChatState }) {
  const left = turnsRemaining(state);
  const low = state.sessionStatus === 'active' && left <= 2;
  return (
    <p className="tabular text-sm text-text-secondary">
      Turn {state.turnCount} of {state.maxTurns}
      {low && (
        <span className="ml-2 font-medium text-warning">
          {left === 0 ? 'Last reply pending' : `${pluralize(left, 'turn')} left`}
        </span>
      )}
    </p>
  );
}

function EndedPanel({ session, state }: { session: ai.Session; state: ChatState }) {
  const nothingSaid = state.sessionStatus === 'abandoned';
  return (
    <div role="status" className="grid gap-3 rounded-lg border border-border bg-surface px-4 py-4">
      <div>
        <p className="font-semibold">Conversation ended</p>
        <p className="text-sm text-text-secondary">
          {state.endReason ? END_REASON_TEXT[state.endReason] : 'This conversation is over.'}{' '}
          {nothingSaid
            ? 'Nothing was said, so there is nothing to score.'
            : 'Your scorecard is being prepared.'}
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button asChild variant="primary">
          <Link to={`/ai-coach/sessions/${session.id}/scorecard`}>
            {nothingSaid ? 'What happens next' : 'View scorecard'}
          </Link>
        </Button>
      </div>
    </div>
  );
}

function Conversation({ session }: { session: ai.Session }) {
  const navigate = useNavigate();
  const chat = useChat(session);
  const { state } = chat;
  const context = useConversationContext(session);
  const end = useEndSession(session.id);
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [restore, setRestore] = useState<{ token: number; text: string } | undefined>();
  const initialLastId = useRef(
    [...session.messages].reverse().find((m) => m.role === 'homeowner')?.id ?? null,
  ).current;
  const bottomRef = useRef<HTMLLIElement>(null);
  const announcement = announcementFor(state, context.personaName, initialLastId);

  const busy = state.phase !== 'idle' && state.phase !== 'error';
  const failedMessage = state.messages.find((m) => m.delivery === 'failed');
  const replyPending = state.phase === 'error' && !failedMessage;
  const sessionOver = state.sessionStatus !== 'active';

  // Keep the newest words in view, unless the learner scrolled up to re-read.
  const stickToBottom = useRef(true);
  useEffect(() => {
    const onScroll = () => {
      stickToBottom.current = nearBottom();
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);
  const firstRun = useRef(true);
  useEffect(() => {
    // A new conversation opens at the top (the brief); a resumed one opens at the latest message.
    const skip = firstRun.current && session.turnCount === 0;
    firstRun.current = false;
    if (!skip && stickToBottom.current) bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [state.messages.length, state.draft, state.phase, session.turnCount]);

  const blockedReason = busy
    ? 'Wait for the homeowner to finish replying.'
    : replyPending
      ? 'Get the homeowner reply to your last message first.'
      : failedMessage
        ? 'Send your last message again, or edit it.'
        : turnsRemaining(state) === 0
          ? 'You have used every turn in this scenario.'
          : undefined;

  const back = session.isTest
    ? { to: `/content/ai-scenarios/${session.scenario.id}`, label: 'Scenario' }
    : { to: '/ai-coach', label: 'AI Coach' };

  const endNow = () =>
    end.mutate(undefined, {
      onSuccess: (ended) => {
        chat.adoptEnded(ended);
        setConfirmEnd(false);
        navigate(`/ai-coach/sessions/${session.id}/scorecard`);
      },
    });

  const lastIdx = state.messages.length - 1;
  const streaming = state.phase === 'waiting' || state.phase === 'streaming';
  const showReplyBubble = streaming || state.phase === 'recovering';

  return (
    <div className="mx-auto flex min-h-[calc(100dvh-10.75rem)] w-full max-w-3xl flex-col lg:min-h-[calc(100dvh-5rem)]">
      <header className="sticky top-14 z-20 -mx-4 border-b border-border bg-background px-4 pt-1 pb-3 sm:-mx-6 sm:px-6 lg:top-0 lg:mx-0 lg:px-0">
        <div className="flex items-center justify-between gap-3">
          <Link
            to={back.to}
            className="-ml-1 inline-flex min-h-8 items-center gap-1.5 rounded px-1 text-sm text-text-secondary hover:text-text-primary"
          >
            <ArrowLeft aria-hidden className="size-4" />
            {back.label}
          </Link>
          <div className="flex items-center gap-3">
            <TurnCounter state={state} />
            {!sessionOver && (
              <Button
                size="sm"
                disabled={busy}
                title={busy ? 'Available once the homeowner has finished replying' : undefined}
                onClick={() => {
                  end.reset();
                  setConfirmEnd(true);
                }}
              >
                End session
              </Button>
            )}
          </div>
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
          <h1 className="min-w-0 text-lg font-semibold tracking-[-0.01em]">
            {session.scenario.title}
          </h1>
          {session.isTest && <Tag tone="warning">Test run</Tag>}
          {session.mode === 'assigned' && <Tag tone="information">Counts toward your lesson</Tag>}
          {session.provider.simulated && <Tag>Simulated homeowner</Tag>}
        </div>
        <p className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-sm text-text-secondary">
          <span>
            <span className="sr-only">Speaking with </span>
            {context.personaName}
          </span>
          <Difficulty level={session.scenario.difficulty} />
          <span>{session.scenario.category}</span>
        </p>
      </header>

      <div className="mt-4">
        <BriefDisclosure context={context} defaultOpen={session.turnCount === 0} />
      </div>

      <ol aria-label="Conversation" className="flex flex-1 flex-col gap-4 py-5">
        {state.messages.map((m, i) =>
          m.role === 'homeowner' ? (
            <HomeownerBubble key={m.key} personaName={context.personaName} time={m.createdAt}>
              {m.content}
            </HomeownerBubble>
          ) : (
            <RepBubble
              key={m.key}
              message={m}
              canResend={i === lastIdx && !busy && state.error?.retryable !== false}
              onResend={chat.resend}
              onDiscard={() => {
                const text = chat.discardUnsent();
                if (text !== null) setRestore({ token: Date.now(), text });
              }}
            />
          ),
        )}
        {showReplyBubble && (
          <HomeownerBubble
            personaName={context.personaName}
            hiddenFromAssistiveTech
            pending={!state.draft}
          >
            {state.draft}
          </HomeownerBubble>
        )}
        <li ref={bottomRef} aria-hidden className="h-px scroll-mb-40 lg:scroll-mb-28" />
      </ol>

      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
        data-testid="chat-announcer"
      >
        {announcement}
      </div>

      <div
        className={cn(
          'sticky bottom-[calc(3.5rem+env(safe-area-inset-bottom))] z-20 -mx-4 -mb-10 grid gap-3 border-t border-border bg-background px-4 pt-3 pb-3',
          'sm:-mx-6 sm:px-6 lg:bottom-0 lg:mx-0 lg:-mb-12 lg:px-0 lg:pb-5',
        )}
      >
        {state.phase === 'recovering' && (
          <p role="status" className="flex items-center gap-2 text-sm text-text-secondary">
            <Spinner size={14} />
            Connection interrupted. Checking whether the homeowner replied.
          </p>
        )}
        {state.phase === 'error' && state.error && (
          <RetryReplyBar
            message={state.error.message}
            retryable={replyPending && state.error.retryable}
            onRetry={chat.retryReply}
          />
        )}
        {sessionOver ? (
          <EndedPanel session={session} state={state} />
        ) : (
          <Composer
            blockedReason={blockedReason}
            onSend={chat.send}
            restore={restore}
            // Voice input goes in `extraActions` when the platform can offer it. It is not offered
            // today: nothing in the API reports speech support (voice sessions are rejected until
            // providers are registered) and there is no audio upload endpoint.
          />
        )}
      </div>

      <ConfirmDialog
        open={confirmEnd}
        onOpenChange={setConfirmEnd}
        title="End this conversation?"
        description={
          state.turnCount === 0
            ? 'You have not said anything yet, so there will be nothing to score.'
            : 'You will get a scorecard for what you have said so far. You cannot continue this conversation afterward.'
        }
        confirmLabel="End and score"
        loading={end.isPending}
        error={end.isError ? errorMessage(end.error) : null}
        onConfirm={endNow}
      />
    </div>
  );
}

function ChatSkeleton() {
  return (
    <div
      className="mx-auto grid max-w-3xl gap-4"
      aria-busy="true"
      aria-label="Loading conversation"
    >
      <Skeleton className="h-6 w-64" />
      <Skeleton className="h-4 w-48" />
      <Skeleton className="mt-4 h-16 w-3/4" />
      <Skeleton className="ml-auto h-12 w-1/2" />
    </div>
  );
}

function SessionLoader({ id }: { id: string }) {
  const session = useSession(id);
  if (session.isPending) return <ChatSkeleton />;
  if (session.isError) {
    const gone = session.error instanceof ApiError && session.error.isNotFound;
    return gone ? (
      <EmptyState
        title="This conversation is not available"
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
        title="The conversation could not be loaded"
        message={errorMessage(session.error)}
        onRetry={() => session.refetch()}
      />
    );
  }
  if (session.data.status !== 'active')
    return <Navigate to={`/ai-coach/sessions/${id}/scorecard`} replace />;
  return <Conversation key={session.data.id} session={session.data} />;
}

export function SessionPage() {
  const { id = '' } = useParams();
  return (
    <RequirePermission any={['ai_practice.use', 'ai_scenarios.update']}>
      <SessionLoader id={id} />
    </RequirePermission>
  );
}
