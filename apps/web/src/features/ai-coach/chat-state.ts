import type { ai } from '@a5/contracts';

export interface TurnError {
  code: string;
  message: string;
  retryable: boolean;
}

export interface ChatMessage {
  /** Stable React key: the client message id for the learner's own messages, else the server id. */
  key: string;
  id: string | null;
  seq: number | null;
  role: ai.Message['role'];
  content: string;
  createdAt: string | null;
  /** `sending` and `failed` only exist for learner messages the server has not confirmed. */
  delivery: 'sent' | 'sending' | 'failed';
}

/**
 * Where the current turn is:
 * - `sending`: request in flight, the server has not confirmed the message yet
 * - `waiting`: the message is saved, the homeowner has not started answering
 * - `streaming`: reply text is arriving
 * - `recovering`: the connection dropped; we are asking the server what it saved
 * - `error`: the turn failed and needs a retry or a decision
 */
export type TurnPhase = 'idle' | 'sending' | 'waiting' | 'streaming' | 'recovering' | 'error';

export interface ChatState {
  messages: ChatMessage[];
  /** Homeowner text received so far for the reply in progress (not yet a saved message). */
  draft: string;
  phase: TurnPhase;
  error: TurnError | null;
  /** Idempotency key of the learner message being sent, if any. */
  clientMessageId: string | null;
  sessionStatus: ai.SessionStatus;
  endReason: ai.EndReason | null;
  turnCount: number;
  maxTurns: number;
}

export type SessionSnapshot = Pick<
  ai.Session,
  'messages' | 'status' | 'endReason' | 'turnCount' | 'maxTurns' | 'awaitingReply'
>;

export type ChatAction =
  | { type: 'send'; clientMessageId: string; text: string; now: string }
  | { type: 'retry-reply' }
  | { type: 'accepted'; repMessage: ai.Message | null; retried: boolean }
  | { type: 'delta'; text: string }
  | {
      type: 'done';
      message: ai.Message;
      status: ai.SessionStatus;
      endReason: ai.EndReason | null;
      turnCount: number;
    }
  /** The server reported that the reply failed (the learner message is saved). */
  | { type: 'reply-failed'; error: TurnError }
  /** The request failed before the server confirmed the message. */
  | { type: 'send-failed'; error: TurnError }
  | { type: 'connection-lost' }
  /** The server's view of the session, adopted once we know what it saved. */
  | { type: 'sync'; session: SessionSnapshot }
  | { type: 'discard-failed' }
  | { type: 'ended'; session: SessionSnapshot };

export function fromServer(m: ai.Message): ChatMessage {
  return {
    key: m.id,
    id: m.id,
    seq: m.seq,
    role: m.role,
    content: m.content,
    createdAt: m.createdAt,
    delivery: 'sent',
  };
}

export function initChat(session: SessionSnapshot): ChatState {
  return {
    messages: session.messages.map(fromServer),
    draft: '',
    phase: 'idle',
    error: null,
    clientMessageId: null,
    sessionStatus: session.status,
    endReason: session.endReason,
    turnCount: session.turnCount,
    maxTurns: session.maxTurns,
  };
}

export const turnsRemaining = (s: Pick<ChatState, 'sessionStatus' | 'maxTurns' | 'turnCount'>) =>
  s.sessionStatus === 'active' ? Math.max(0, s.maxTurns - s.turnCount) : 0;

export const REPLY_MISSING: TurnError = {
  code: 'REPLY_MISSING',
  message: 'The homeowner has not answered your last message yet.',
  retryable: true,
};

export const NOT_SENT: TurnError = {
  code: 'NOT_SENT',
  message: 'Your last message did not reach the homeowner. Send it again or edit it.',
  retryable: true,
};

function replaceByKey(list: ChatMessage[], key: string, next: ChatMessage): ChatMessage[] {
  return list.map((m) => (m.key === key ? next : m));
}

/** Merge the server transcript with learner messages the server has not confirmed. */
function mergeTranscript(local: ChatMessage[], server: ai.Message[]): ChatMessage[] {
  const saved = server.map(fromServer);
  const lastServerRep = [...server].reverse().find((m) => m.role === 'rep');
  // A message we sent may already be saved: the server copy then carries the same text.
  const pending = local.filter(
    (m) =>
      m.delivery !== 'sent' &&
      m.id === null &&
      !(lastServerRep && lastServerRep.content === m.content),
  );
  return [...saved, ...pending];
}

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case 'send': {
      const exists = state.messages.some((m) => m.key === action.clientMessageId);
      const messages = exists
        ? state.messages.map((m) =>
            m.key === action.clientMessageId ? { ...m, delivery: 'sending' as const } : m,
          )
        : [
            ...state.messages,
            {
              key: action.clientMessageId,
              id: null,
              seq: null,
              role: 'rep' as const,
              content: action.text,
              createdAt: action.now,
              delivery: 'sending' as const,
            },
          ];
      return {
        ...state,
        messages,
        draft: '',
        phase: 'sending',
        error: null,
        clientMessageId: action.clientMessageId,
      };
    }

    case 'retry-reply':
      return { ...state, draft: '', phase: 'waiting', error: null };

    case 'accepted': {
      let messages = state.messages;
      const confirmed = action.repMessage;
      if (confirmed) {
        const pending = state.clientMessageId
          ? messages.find((m) => m.key === state.clientMessageId)
          : undefined;
        if (pending) {
          messages = replaceByKey(messages, pending.key, {
            ...fromServer(confirmed),
            key: pending.key,
          });
        } else if (!messages.some((m) => m.id === confirmed.id)) {
          messages = [...messages, fromServer(confirmed)];
        }
      }
      return {
        ...state,
        messages,
        phase: 'waiting',
        turnCount: action.retried ? state.turnCount : state.turnCount + 1,
      };
    }

    case 'delta':
      return { ...state, draft: state.draft + action.text, phase: 'streaming' };

    case 'done': {
      const known = state.messages.some((m) => m.id === action.message.id);
      return {
        ...state,
        messages: known ? state.messages : [...state.messages, fromServer(action.message)],
        draft: '',
        phase: 'idle',
        error: null,
        clientMessageId: null,
        sessionStatus: action.status,
        endReason: action.endReason,
        turnCount: action.turnCount,
      };
    }

    case 'reply-failed':
      return {
        ...state,
        messages: state.messages.map((m) =>
          m.delivery === 'sending' ? { ...m, delivery: 'sent' as const } : m,
        ),
        draft: '',
        phase: 'error',
        error: action.error,
      };

    case 'send-failed':
      return {
        ...state,
        messages: state.messages.map((m) =>
          m.delivery === 'sending' ? { ...m, delivery: 'failed' as const } : m,
        ),
        draft: '',
        phase: 'error',
        error: action.error,
      };

    case 'connection-lost':
      return { ...state, phase: 'recovering' };

    case 'sync': {
      const s = action.session;
      const base = {
        ...state,
        messages: mergeTranscript(state.messages, s.messages),
        sessionStatus: s.status,
        endReason: s.endReason,
        turnCount: s.turnCount,
        maxTurns: s.maxTurns,
      };
      // Still waiting for the reply: keep recovering, but show the confirmed message as sent.
      if (s.status === 'active' && s.awaitingReply)
        return { ...base, phase: state.phase === 'recovering' ? 'recovering' : 'waiting' };
      // Nothing more is coming. A learner message the server does not have was never sent.
      if (base.messages.some((m) => m.delivery !== 'sent')) {
        return {
          ...base,
          messages: base.messages.map((m) =>
            m.delivery === 'sent' ? m : { ...m, delivery: 'failed' as const },
          ),
          draft: '',
          phase: 'error',
          error: NOT_SENT,
        };
      }
      return { ...base, draft: '', phase: 'idle', error: null, clientMessageId: null };
    }

    case 'discard-failed':
      return {
        ...state,
        messages: state.messages.filter((m) => m.delivery !== 'failed'),
        phase: 'idle',
        error: null,
        clientMessageId: null,
      };

    case 'ended': {
      const s = action.session;
      return {
        ...state,
        messages: mergeTranscript(state.messages, s.messages),
        draft: '',
        phase: 'idle',
        error: null,
        clientMessageId: null,
        sessionStatus: s.status,
        endReason: s.endReason,
        turnCount: s.turnCount,
      };
    }
  }
}
