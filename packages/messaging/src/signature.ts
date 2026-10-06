import { createHmac, timingSafeEqual } from 'node:crypto';
import type { EventEnvelope } from '@a5/events';

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function unsignedFields(envelope: EventEnvelope): Omit<EventEnvelope, 'signature'> {
  const { signature: _signature, ...fields } = envelope;
  return fields;
}

/** Sign an event using the producer's secret. Canonical JSON survives JSONB key reordering. */
export function signEvent<T extends EventEnvelope>(envelope: T, secret: string): T {
  if (secret.length < 32) throw new Error('Event signing secret must be at least 32 characters');
  const signature = createHmac('sha256', secret)
    .update(canonical(unsignedFields(envelope)))
    .digest('base64url');
  return { ...unsignedFields(envelope), signature } as T;
}

/** Verify the producer signature without leaking timing information about a matching prefix. */
export function verifyEvent(envelope: EventEnvelope, secret: string): boolean {
  if (!envelope.signature || secret.length < 32) return false;
  const expected = createHmac('sha256', secret)
    .update(canonical(unsignedFields(envelope)))
    .digest();
  const actual = Buffer.from(envelope.signature, 'base64url');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
