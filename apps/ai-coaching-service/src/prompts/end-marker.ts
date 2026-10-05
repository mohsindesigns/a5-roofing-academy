import type { MarkerEndReason } from './compiler.js';

const COMPLETE = /^\[\[END:([a-z_]+)\]\]/;
const PREFIX = '[[END:';
const VALID = new Set<MarkerEndReason>(['objective_reached', 'homeowner_ended']);

function couldBeMarker(s: string): boolean {
  if (s.length <= PREFIX.length) return PREFIX.startsWith(s);
  return /^\[\[END:[a-z_]*\]?$/.test(s);
}

/**
 * Streaming filter that removes `[[END:reason]]` markers from homeowner text. Text that could be
 * the start of a marker is held back until it is known not to be one, so the marker never
 * reaches the client even when split across deltas.
 */
export class EndMarkerFilter {
  private buffer = '';
  private emitted = '';
  private reason: MarkerEndReason | null = null;

  /** Feed a delta; returns the text that is safe to forward now. */
  push(chunk: string): string {
    this.buffer += chunk;
    let out = '';
    for (;;) {
      const i = this.buffer.indexOf('[');
      if (i === -1) {
        out += this.buffer;
        this.buffer = '';
        break;
      }
      out += this.buffer.slice(0, i);
      this.buffer = this.buffer.slice(i);
      const match = COMPLETE.exec(this.buffer);
      if (match) {
        const reason = match[1] as MarkerEndReason;
        if (VALID.has(reason)) this.reason = reason;
        this.buffer = this.buffer.slice(match[0].length);
        continue;
      }
      if (couldBeMarker(this.buffer)) break;
      out += this.buffer[0];
      this.buffer = this.buffer.slice(1);
    }
    this.emitted += out;
    return out;
  }

  /** Flush held text that turned out not to be a marker. */
  finish(): { tail: string; text: string; endReason: MarkerEndReason | null } {
    const tail = this.buffer;
    this.buffer = '';
    this.emitted += tail;
    return { tail, text: this.emitted.replace(/\s+/g, ' ').trim(), endReason: this.reason };
  }
}

/** Remove markers from a complete reply (non-streaming paths). */
export function stripEndMarkers(text: string): { text: string; endReason: MarkerEndReason | null } {
  const filter = new EndMarkerFilter();
  filter.push(text);
  const { text: clean, endReason } = filter.finish();
  return { text: clean, endReason };
}
