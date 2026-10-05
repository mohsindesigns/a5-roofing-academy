import { createContext, useContext, type ReactNode } from 'react';
import type { ai } from '@a5/contracts';
import { Avatar, EmptyState } from '@/components/ui';
import { cn } from '@/lib/cn';

type Message = ai.Message;

const TranscriptContext = createContext<{ messages: Message[]; linkable: boolean }>({
  messages: [],
  linkable: false,
});

export function TranscriptProvider({
  messages,
  linkable,
  children,
}: {
  messages: Message[];
  /** Evidence quotes link to the transcript on the same page. */
  linkable: boolean;
  children: ReactNode;
}) {
  return (
    <TranscriptContext.Provider value={{ messages, linkable }}>
      {children}
    </TranscriptContext.Provider>
  );
}

/** "Your message 3": turn number counts the learner's messages only. */
function describeMessage(messages: Message[], seq: number): string | null {
  const message = messages.find((m) => m.seq === seq);
  if (!message) return null;
  if (message.role === 'homeowner') return 'Homeowner';
  const turn = messages.filter((m) => m.role === 'rep' && m.seq <= seq).length;
  return `Your turn ${turn}`;
}

/** A line from the conversation that backs up a score or a piece of feedback. */
export function EvidenceQuote({ seq, quote }: { seq: number | null; quote: string }) {
  const { messages, linkable } = useContext(TranscriptContext);
  const where = seq === null ? null : describeMessage(messages, seq);
  return (
    <figure className="border-l-2 border-brand-secondary pl-3">
      <blockquote className="text-sm text-text-primary">&ldquo;{quote}&rdquo;</blockquote>
      {where && (
        <figcaption className="mt-0.5 text-xs text-text-secondary">
          {where}
          {linkable && seq !== null && (
            <>
              {' · '}
              <a href={`#message-${seq}`} className="text-information hover:underline">
                See in transcript
              </a>
            </>
          )}
        </figcaption>
      )}
    </figure>
  );
}

export function Transcript({
  messages,
  personaName,
  purged,
}: {
  messages: Message[];
  personaName: string;
  purged: boolean;
}) {
  if (purged)
    return (
      <EmptyState
        title="The transcript was removed"
        description="Your organization's retention policy deleted this conversation's text. The scorecard above is kept."
      />
    );
  let turn = 0;
  return (
    <ol aria-label="Transcript" className="grid gap-3">
      {messages.map((m) => {
        if (m.role === 'rep') turn += 1;
        const rep = m.role === 'rep';
        return (
          <li
            key={m.id}
            id={`message-${m.seq}`}
            className={cn(
              'scroll-mt-24 target:ring-2 target:ring-focus/40 grid gap-1 rounded-lg px-3.5 py-2.5',
              rep ? 'bg-surface-sunken' : 'border border-border bg-surface',
            )}
          >
            <p className="flex items-center gap-2 text-xs text-text-secondary">
              {!rep && <Avatar name={personaName} size={18} />}
              <span className="font-medium text-text-secondary">
                {rep ? `You, turn ${turn}` : personaName}
              </span>
            </p>
            <p className="text-base break-words whitespace-pre-wrap">{m.content}</p>
          </li>
        );
      })}
    </ol>
  );
}
