import { describe, expect, it } from 'vitest';
import {
  EVENT_DEFINITIONS,
  buildEvent,
  certificationEvents,
  isSensitiveEvent,
  parseEnvelope,
  streamFor,
  EventContractError,
} from './index.js';

const UID = '0190a3b2-0000-7000-8000-000000000010';
const ORG = '0190a3b2-0000-7000-8000-000000000011';

describe('event catalog', () => {
  it('has unique type@version pairs', () => {
    const keys = EVENT_DEFINITIONS.map((d) => `${d.type}@${d.version}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('flags events that carry one-time links as sensitive', () => {
    expect(isSensitiveEvent('identity.password_reset.requested', 1)).toBe(true);
    expect(isSensitiveEvent('certificate.issued', 1)).toBe(false);
  });

  it('maps producers to streams', () => {
    expect(streamFor('certification-service')).toBe('events:certification');
    expect(streamFor('gateway')).toBe('events:gateway');
  });
});

describe('build and parse', () => {
  const meta = {
    id: '0190a3b2-0000-7000-8000-000000000012',
    producer: 'certification-service' as const,
    organizationId: ORG,
    actor: { type: 'system' as const, id: null },
  };

  it('round-trips a valid event', () => {
    const event = buildEvent(
      certificationEvents.revoked,
      {
        certificateId: UID,
        definitionId: UID,
        definitionName: 'A5 Roofing Certified Sales Representative',
        userId: UID,
        certificateNumber: 'A5-SALES-2026-000184',
        reason: 'Issued in error',
      },
      meta,
    );
    const parsed = parseEnvelope(JSON.parse(JSON.stringify(event)));
    expect(parsed?.type).toBe('certificate.revoked');
    expect(parsed?.payload).toMatchObject({ reason: 'Issued in error' });
  });

  it('rejects payloads that violate the contract', () => {
    expect(() =>
      buildEvent(certificationEvents.revoked, { certificateId: 'nope' } as never, meta),
    ).toThrow();
  });

  it('skips unknown versions instead of failing', () => {
    const event = {
      ...buildEvent(
        certificationEvents.expired,
        {
          certificateId: UID,
          definitionId: UID,
          definitionName: 'x',
          userId: UID,
          expiredAt: new Date().toISOString(),
        },
        meta,
      ),
      version: 99,
    };
    expect(parseEnvelope(event)).toBeNull();
  });

  it('throws on malformed envelopes', () => {
    expect(() => parseEnvelope({ type: 'x' })).toThrow(EventContractError);
  });
});
