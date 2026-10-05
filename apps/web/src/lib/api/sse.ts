import { useAuth } from '../auth-store';
import { buildUrl, refreshSession } from './client';
import { ApiError, NETWORK_ERROR_MESSAGE } from './errors';

export interface SseMessage {
  event: string;
  data: string;
  id?: string;
}

/** Incremental text/event-stream parser (spec-compliant for event, data, id and comments). */
export function createSseParser(onMessage: (m: SseMessage) => void) {
  let buffer = '';
  let event = 'message';
  let data: string[] = [];
  let id: string | undefined;
  return (chunk: string) => {
    buffer += chunk;
    let newline: number;
    while ((newline = buffer.search(/\r\n|\r|\n/)) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(
        newline + (buffer[newline] === '\r' && buffer[newline + 1] === '\n' ? 2 : 1),
      );
      if (line === '') {
        if (data.length) onMessage({ event, data: data.join('\n'), id });
        event = 'message';
        data = [];
        continue;
      }
      if (line.startsWith(':')) continue;
      const colon = line.indexOf(':');
      const field = colon === -1 ? line : line.slice(0, colon);
      const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
      if (field === 'event') event = value;
      else if (field === 'data') data.push(value);
      else if (field === 'id') id = value;
    }
  };
}

export interface StreamOptions {
  method?: 'GET' | 'POST';
  body?: unknown;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  onMessage: (m: SseMessage) => void;
}

/**
 * Server-sent events over fetch so the bearer token can be sent (EventSource cannot set headers).
 * Resolves when the stream ends; rejects with ApiError for HTTP errors.
 */
export async function streamSse(
  path: string,
  { method = 'GET', body, headers, signal, onMessage }: StreamOptions,
): Promise<void> {
  const attempt = async (retried: boolean): Promise<void> => {
    const token = useAuth.getState().accessToken;
    let res: Response;
    try {
      res = await fetch(buildUrl(path), {
        method,
        signal,
        credentials: 'same-origin',
        headers: {
          accept: 'text/event-stream',
          ...headers,
          ...(body !== undefined && { 'content-type': 'application/json' }),
          ...(token && { authorization: `Bearer ${token}` }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      if ((err as Error).name === 'AbortError') throw err;
      throw new ApiError(0, 'NETWORK_ERROR', NETWORK_ERROR_MESSAGE);
    }
    if (res.status === 401 && !retried && (await refreshSession())) return attempt(true);
    if (!res.ok || !res.body) throw await ApiError.fromResponse(res);
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    const parse = createSseParser(onMessage);
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      parse(value);
    }
  };
  return attempt(false);
}
