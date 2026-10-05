import { useCallback, useEffect, useReducer, useRef } from 'react';
import type { ai } from '@a5/contracts';
import { api } from '@/lib/api/client';
import { streamSse } from '@/lib/api/sse';
import { parseStreamEvent } from './chat-events';
import { chatReducer, initChat, type ChatMessage, type ChatState } from './chat-state';
import { runTurn, type TurnDeps, type TurnRequest } from './run-turn';

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new DOMException('Aborted', 'AbortError'));
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export function sessionTurnDeps(sessionId: string): TurnDeps {
  return {
    stream: (body, { signal, onEvent }) =>
      streamSse(`/ai/sessions/${sessionId}/messages`, {
        method: 'POST',
        body,
        signal,
        onMessage: (m) => {
          const event = parseStreamEvent(m);
          if (event) onEvent(event);
        },
      }),
    getSession: (signal) => api.get<ai.Session>(`/ai/sessions/${sessionId}`, undefined, signal),
    sleep: abortableSleep,
  };
}

function lastConfirmedSeq(messages: ChatMessage[]): number {
  return messages.reduce((max, m) => (m.seq !== null && m.seq > max ? m.seq : max), 0);
}

export interface Chat {
  state: ChatState;
  send: (text: string) => void;
  /** Resend a learner message the server never confirmed. */
  resend: (message: ChatMessage) => void;
  /** Ask for the homeowner's reply to the last saved message. */
  retryReply: () => void;
  /** Remove an unsent message and return its text so the learner can edit it. */
  discardUnsent: () => string | null;
  /** Adopt the session returned by "end session". */
  adoptEnded: (session: ai.Session) => void;
}

/**
 * Conversation state for one session. `initial` is read once; later changes come from the
 * stream (or from the server when a dropped connection is reconciled).
 */
export function useChat(initial: ai.Session): Chat {
  const sessionId = initial.id;
  const [state, dispatch] = useReducer(chatReducer, initial, initChat);
  const stateRef = useRef(state);
  const controller = useRef<AbortController | null>(null);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const start = useCallback(
    (request: TurnRequest) => {
      controller.current?.abort();
      const ctrl = new AbortController();
      controller.current = ctrl;
      void runTurn(
        sessionTurnDeps(sessionId),
        { request, baselineSeq: lastConfirmedSeq(stateRef.current.messages), signal: ctrl.signal },
        dispatch,
      );
    },
    [sessionId],
  );

  // A reply that was still being written when the page loaded: wait for it, never re-ask.
  useEffect(() => {
    if (initial.status === 'active' && initial.awaitingReply) {
      dispatch({ type: 'connection-lost' });
      start({ kind: 'watch' });
    }
    // The server finishes the turn on its own, so leaving the page needs no cancellation call.
    return () => controller.current?.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const send = useCallback(
    (text: string) => {
      const clientMessageId = crypto.randomUUID();
      dispatch({ type: 'send', clientMessageId, text, now: new Date().toISOString() });
      start({ kind: 'message', text, clientMessageId });
    },
    [start],
  );

  const resend = useCallback(
    (message: ChatMessage) => {
      dispatch({
        type: 'send',
        clientMessageId: message.key,
        text: message.content,
        now: new Date().toISOString(),
      });
      start({ kind: 'message', text: message.content, clientMessageId: message.key });
    },
    [start],
  );

  const retryReply = useCallback(() => {
    dispatch({ type: 'retry-reply' });
    start({ kind: 'retry' });
  }, [start]);

  const discardUnsent = useCallback(() => {
    const failed = stateRef.current.messages.find((m) => m.delivery === 'failed');
    if (!failed) return null;
    dispatch({ type: 'discard-failed' });
    return failed.content;
  }, []);

  const adoptEnded = useCallback((session: ai.Session) => {
    controller.current?.abort();
    dispatch({ type: 'ended', session });
  }, []);

  return { state, send, resend, retryReply, discardUnsent, adoptEnded };
}
