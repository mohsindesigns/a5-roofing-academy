import { ai } from '@a5/contracts';
import type { SseMessage } from '@/lib/api/sse';

/** The four events of POST /ai/sessions/:id/messages (Accept: text/event-stream). */
export type StreamEvent =
  | { type: 'accepted'; repMessage: ai.Message | null; retried: boolean }
  | { type: 'delta'; text: string }
  | {
      type: 'done';
      message: ai.Message;
      sessionEnded: boolean;
      endReason: ai.EndReason | null;
      status: ai.SessionStatus;
      turnCount: number;
      turnsRemaining: number;
    }
  | { type: 'error'; code: string; message: string; retryable: boolean };

/**
 * Validates one SSE message against the shared contracts. Unknown event names (and comments,
 * which the parser already drops) are ignored so the server can add events without breaking
 * older clients; a known event with a malformed payload is a protocol error and returns null.
 */
export function parseStreamEvent(m: SseMessage): StreamEvent | null {
  let payload: unknown;
  try {
    payload = JSON.parse(m.data);
  } catch {
    return null;
  }
  switch (m.event) {
    case 'accepted': {
      const r = ai.streamAcceptedEventSchema.safeParse(payload);
      return r.success ? { type: 'accepted', ...r.data } : null;
    }
    case 'delta': {
      const r = ai.streamDeltaEventSchema.safeParse(payload);
      return r.success ? { type: 'delta', text: r.data.text } : null;
    }
    case 'done': {
      const r = ai.streamDoneEventSchema.safeParse(payload);
      if (!r.success) return null;
      const { messageId: _messageId, ...rest } = r.data;
      return { type: 'done', ...rest };
    }
    case 'error': {
      const r = ai.streamErrorEventSchema.safeParse(payload);
      return r.success ? { type: 'error', ...r.data } : null;
    }
    default:
      return null;
  }
}
