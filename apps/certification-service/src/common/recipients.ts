import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { DirectoryReader } from '@a5/directory';
import { InternalHttpClient, LOGGER, NotFoundError } from '@a5/nest-kit';
import type { Logger } from '@a5/observability';

export interface Recipient {
  userId: string;
  organizationId: string;
  legalName: string;
  firstName: string;
  lastName: string;
  employeeId: string | null;
  source: 'identity' | 'directory';
}

const identityUsersSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      organizationId: z.string(),
      firstName: z.string(),
      lastName: z.string(),
      employeeId: z.string().nullable(),
      status: z.string(),
    }),
  ),
});

/**
 * Resolves the recipient's legal name at the moment of issuance. Identity is the source of truth
 * (a fresh read at a decision point, architecture §2.3); the local directory projection is the
 * fallback when identity is unreachable so issuance does not depend on it being up.
 */
@Injectable()
export class RecipientResolver {
  constructor(
    private readonly http: InternalHttpClient,
    private readonly directory: DirectoryReader,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  async resolve(userId: string, organizationId: string): Promise<Recipient> {
    try {
      const res = await this.http.request('identity-service', '/internal/users', {
        query: { ids: userId },
        schema: identityUsersSchema,
        timeoutMs: 3_000,
        retries: 1,
      });
      const user = res.items.find((u) => u.id === userId);
      if (user && user.organizationId === organizationId) {
        return {
          userId,
          organizationId,
          firstName: user.firstName,
          lastName: user.lastName,
          legalName: `${user.firstName} ${user.lastName}`.trim(),
          employeeId: user.employeeId,
          source: 'identity',
        };
      }
    } catch (err) {
      this.logger.warn(
        { err, userId },
        'identity lookup failed; using directory projection for recipient name',
      );
    }
    const person = await this.directory.getUser(userId);
    if (!person || person.organizationId !== organizationId) throw new NotFoundError('Person');
    return {
      userId,
      organizationId,
      firstName: person.firstName,
      lastName: person.lastName,
      legalName: `${person.firstName} ${person.lastName}`.trim(),
      employeeId: person.employeeId,
      source: 'directory',
    };
  }
}
