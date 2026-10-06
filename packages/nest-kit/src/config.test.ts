import { describe, expect, it } from 'vitest';
import { z } from '@a5/config';
import { loadServiceConfig } from './config.js';

const base = {
  REDIS_URL: 'redis://localhost:6379',
  INTERNAL_AUTH_SECRET: 'internal-auth-secret-for-tests-0123456789',
};

describe('event signing configuration', () => {
  it('allows unsigned envelopes by default only in development and test', () => {
    const development = loadServiceConfig('identity-service', 4010, z.object({}), {
      database: false,
      source: { ...base, NODE_ENV: 'development' },
    });
    const test = loadServiceConfig('identity-service', 4010, z.object({}), {
      database: false,
      source: { ...base, NODE_ENV: 'test' },
    });
    const staging = loadServiceConfig('identity-service', 4010, z.object({}), {
      database: false,
      source: { ...base, NODE_ENV: 'staging', EVENT_SIGNING_SECRET_IDENTITY_SERVICE: 's'.repeat(32) },
    });
    expect(development.allowUnsignedEvents).toBe(true);
    expect(test.allowUnsignedEvents).toBe(true);
    expect(staging.allowUnsignedEvents).toBe(false);
  });

  it('requires each deployed producer to have its signing secret', () => {
    expect(() =>
      loadServiceConfig('identity-service', 4010, z.object({}), {
        database: false,
        source: { ...base, NODE_ENV: 'production' },
      }),
    ).toThrow('EVENT_SIGNING_SECRET_IDENTITY_SERVICE is required');
  });

  it('exposes the available producer verification keys', () => {
    const secret = 'identity-event-signing-secret-for-tests-123456789';
    const config = loadServiceConfig('identity-service', 4010, z.object({}), {
      database: false,
      source: {
        ...base,
        NODE_ENV: 'staging',
        EVENT_SIGNING_SECRET_IDENTITY_SERVICE: secret,
      },
    });
    expect(config.eventSigningSecret).toBe(secret);
    expect(config.eventSigningKeys['identity-service']).toBe(secret);
  });
});
