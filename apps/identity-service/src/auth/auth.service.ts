import { Inject, Injectable } from '@nestjs/common';
import type { Principal } from '@a5/auth';
import { defaultFeatureFlags, type FeatureFlagState, type identity } from '@a5/contracts';
import { sql } from '@a5/database';
import { identityEvents } from '@a5/events';
import {
  AppError,
  EventBus,
  InjectDb,
  LOGGER,
  PreconditionError,
  UnauthenticatedError,
  ValidationError,
} from '@a5/nest-kit';
import { getContext, randomToken, uuidv7, type Logger } from '@a5/observability';
import { PasswordService } from '../common/passwords.js';
import { IamCache } from '../common/iam-cache.js';
import { DirectoryPublisher } from '../common/directory-publisher.js';
import { hashToken, issueOneTimeToken } from '../common/one-time-tokens.js';
import { IDENTITY_CONFIG, type IdentityConfig } from '../config.js';
import type { Db, OrganizationsTable, OneTimeTokenPurpose, Trx } from '../database/index.js';
import { TokenService } from './token.service.js';

export interface IssuedSession {
  response: identity.LoginResponse;
  refreshToken: string;
  refreshExpiresAt: Date;
}

/** Window in which a just-rotated refresh token is still honoured (concurrent tabs). */
const ROTATION_GRACE_MS = 20_000;

/** One answer for unknown email, wrong password and locked account. */
const GENERIC_LOGIN_FAILURE =
  'The email or password is incorrect, or sign-in is paused for a few minutes after repeated attempts. Try again shortly or reset your password.';

@Injectable()
export class AuthService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
    private readonly cache: IamCache,
    private readonly events: EventBus,
    private readonly directory: DirectoryPublisher,
    @Inject(IDENTITY_CONFIG) private readonly config: IdentityConfig,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  private async securityOf(organizationId: string): Promise<OrganizationsTable['security']> {
    const org = await this.db
      .selectFrom('organizations')
      .select('security')
      .where('id', '=', organizationId)
      .executeTakeFirstOrThrow();
    return org.security;
  }

  private async recordAttempt(
    email: string,
    userId: string | null,
    success: boolean,
    reason: string | null,
  ) {
    const ctx = getContext();
    await this.db
      .insertInto('login_attempts')
      .values({
        id: uuidv7(),
        user_id: userId,
        email,
        ip: ctx?.ip ?? null,
        user_agent: ctx?.userAgent ?? null,
        success,
        reason,
      })
      .execute();
  }

  async login(email: string, password: string): Promise<IssuedSession> {
    const user = await this.db
      .selectFrom('users')
      .innerJoin('credentials', 'credentials.user_id', 'users.id')
      .select([
        'users.id',
        'users.organization_id',
        'users.status',
        'users.failed_login_count',
        'users.locked_until',
        'credentials.password_hash',
      ])
      .where(sql`lower(users.email)`, '=', email.toLowerCase())
      .executeTakeFirst();

    if (!user) {
      await this.passwords.verifyAgainstDummy(password);
      await this.recordAttempt(email, null, false, 'unknown_email');
      throw new UnauthenticatedError('INVALID_CREDENTIALS', GENERIC_LOGIN_FAILURE);
    }

    const security = await this.securityOf(user.organization_id);
    if (user.locked_until && user.locked_until > new Date()) {
      await this.recordAttempt(email, user.id, false, 'locked');
      // Same answer as an unknown email or a wrong password, so lockout cannot reveal an account.
      await this.passwords.verifyAgainstDummy(password);
      throw new UnauthenticatedError('INVALID_CREDENTIALS', GENERIC_LOGIN_FAILURE);
    }

    const valid = await this.passwords.verify(user.password_hash, password);
    if (!valid) {
      // One atomic statement: parallel guesses cannot all read the same counter and slip past
      // the threshold.
      const lockUntil = new Date(Date.now() + security.lockoutMinutes * 60_000);
      const updated = await this.db
        .updateTable('users')
        .set((eb) => ({
          failed_login_count: eb
            .case()
            .when(eb('failed_login_count', '+', 1), '>=', security.lockoutThreshold)
            .then(0)
            .else(eb('failed_login_count', '+', 1))
            .end(),
          locked_until: eb
            .case()
            .when(eb('failed_login_count', '+', 1), '>=', security.lockoutThreshold)
            .then(lockUntil)
            .else(eb.ref('locked_until'))
            .end(),
        }))
        .where('id', '=', user.id)
        .returning(['failed_login_count', 'locked_until'])
        .executeTakeFirstOrThrow();
      const lock = updated.failed_login_count === 0;
      await this.recordAttempt(
        email,
        user.id,
        false,
        lock ? 'locked_after_failures' : 'bad_password',
      );
      throw new UnauthenticatedError('INVALID_CREDENTIALS', GENERIC_LOGIN_FAILURE);
    }

    // Account state is only revealed after a correct password, so it cannot be probed.
    if (user.status === 'deactivated') {
      await this.recordAttempt(email, user.id, false, 'deactivated');
      throw new AppError(
        403,
        'ACCOUNT_DISABLED',
        'Your account has been deactivated. Contact your manager or administrator.',
      );
    }
    if (user.status !== 'active') {
      await this.recordAttempt(email, user.id, false, 'not_activated');
      throw new AppError(
        403,
        'ACCOUNT_NOT_ACTIVATED',
        'Activate your account with the link from your invitation email first.',
      );
    }

    const issued = await this.db.transaction().execute(async (trx) => {
      await trx
        .updateTable('users')
        .set({ failed_login_count: 0, locked_until: null, last_login_at: new Date() })
        .where('id', '=', user.id)
        .execute();
      return this.startSession(trx, user.id, user.organization_id, security.sessionMaxHours);
    });
    await this.recordAttempt(email, user.id, true, null);
    await this.cache.markSessionActive(issued.response.sessionId, issued.refreshExpiresAt);
    return issued;
  }

  private async startSession(
    trx: Trx,
    userId: string,
    organizationId: string,
    maxHours: number,
  ): Promise<IssuedSession> {
    const ctx = getContext();
    const sessionId = uuidv7();
    const expiresAt = new Date(Date.now() + maxHours * 3_600_000);
    await trx
      .insertInto('sessions')
      .values({
        id: sessionId,
        user_id: userId,
        organization_id: organizationId,
        expires_at: expiresAt,
        ip: ctx?.ip ?? null,
        user_agent: ctx?.userAgent?.slice(0, 400) ?? null,
        revoked_at: null,
        revoked_reason: null,
      })
      .execute();
    const refreshToken = randomToken(32);
    await trx
      .insertInto('refresh_tokens')
      .values({
        id: uuidv7(),
        session_id: sessionId,
        token_hash: hashToken(refreshToken),
        expires_at: expiresAt,
        rotated_at: null,
      })
      .execute();
    const user = await this.sessionUser(trx, userId);
    return {
      response: {
        accessToken: await this.tokens.accessToken({ userId, sessionId, organizationId }),
        expiresIn: this.tokens.ttlSeconds,
        sessionId,
        user,
      },
      refreshToken,
      refreshExpiresAt: expiresAt,
    };
  }

  async sessionUser(db: Db | Trx, userId: string): Promise<identity.SessionUser> {
    const u = await db
      .selectFrom('users')
      .innerJoin('organizations', 'organizations.id', 'users.organization_id')
      .select([
        'users.id',
        'users.organization_id',
        'organizations.name as organization_name',
        'users.email',
        'users.first_name',
        'users.last_name',
        'users.job_title',
      ])
      .where('users.id', '=', userId)
      .executeTakeFirstOrThrow();
    const roles = await db
      .selectFrom('user_roles')
      .innerJoin('roles', 'roles.id', 'user_roles.role_id')
      .select(['roles.id', 'roles.key', 'roles.name'])
      .where('user_roles.user_id', '=', userId)
      .where('roles.archived_at', 'is', null)
      .orderBy('roles.name')
      .execute();
    return {
      id: u.id,
      organizationId: u.organization_id,
      organizationName: u.organization_name,
      email: u.email,
      firstName: u.first_name,
      lastName: u.last_name,
      displayName: `${u.first_name} ${u.last_name}`,
      jobTitle: u.job_title,
      roles,
    };
  }

  /**
   * Rotate a refresh token. Reusing a rotated token outside the short grace window is treated as
   * token theft and revokes the whole session.
   */
  async refresh(refreshToken: string): Promise<IssuedSession> {
    const result = await this.db.transaction().execute(async (trx) => {
      const token = await trx
        .selectFrom('refresh_tokens as rt')
        .innerJoin('sessions as s', 's.id', 'rt.session_id')
        .innerJoin('users as u', 'u.id', 's.user_id')
        .select([
          'rt.id',
          'rt.rotated_at',
          'rt.expires_at',
          's.id as session_id',
          's.user_id',
          's.organization_id',
          's.revoked_at',
          's.last_seen_at',
          's.expires_at as session_expires_at',
          'u.status',
        ])
        .where('rt.token_hash', '=', hashToken(refreshToken))
        .forUpdate('rt')
        .executeTakeFirst();
      if (!token) return { error: 'UNAUTHENTICATED' as const };
      if (token.revoked_at) return { error: 'SESSION_REVOKED' as const };
      const now = Date.now();
      if (token.expires_at.getTime() <= now || token.session_expires_at.getTime() <= now) {
        return { error: 'SESSION_EXPIRED' as const };
      }
      if (token.status !== 'active') {
        await trx
          .updateTable('sessions')
          .set({ revoked_at: new Date(), revoked_reason: 'account_inactive' })
          .where('id', '=', token.session_id)
          .execute();
        return { error: 'SESSION_REVOKED' as const, revokedSession: token.session_id };
      }
      const security = (
        await trx
          .selectFrom('organizations')
          .select('security')
          .where('id', '=', token.organization_id)
          .executeTakeFirstOrThrow()
      ).security;
      if (token.last_seen_at.getTime() + security.sessionIdleMinutes * 60_000 <= now) {
        await trx
          .updateTable('sessions')
          .set({ revoked_at: new Date(), revoked_reason: 'idle_timeout' })
          .where('id', '=', token.session_id)
          .execute();
        return { error: 'SESSION_EXPIRED' as const, revokedSession: token.session_id };
      }
      if (token.rotated_at && now - token.rotated_at.getTime() > ROTATION_GRACE_MS) {
        await trx
          .updateTable('sessions')
          .set({ revoked_at: new Date(), revoked_reason: 'refresh_token_reuse' })
          .where('id', '=', token.session_id)
          .execute();
        await this.events.audit(
          trx,
          {
            action: 'session.refresh_token_reused',
            resourceType: 'session',
            resourceId: token.session_id,
            actorDisplay: null,
            metadata: { userId: token.user_id },
          },
          { organizationId: token.organization_id, actor: { type: 'system', id: null } },
        );
        return { error: 'SESSION_REVOKED' as const, revokedSession: token.session_id };
      }
      if (!token.rotated_at) {
        await trx
          .updateTable('refresh_tokens')
          .set({ rotated_at: new Date() })
          .where('id', '=', token.id)
          .execute();
      }
      const next = randomToken(32);
      await trx
        .insertInto('refresh_tokens')
        .values({
          id: uuidv7(),
          session_id: token.session_id,
          token_hash: hashToken(next),
          expires_at: token.session_expires_at,
          rotated_at: null,
        })
        .execute();
      await trx
        .updateTable('sessions')
        .set({ last_seen_at: new Date() })
        .where('id', '=', token.session_id)
        .execute();
      const user = await this.sessionUser(trx, token.user_id);
      return {
        issued: {
          response: {
            accessToken: await this.tokens.accessToken({
              userId: token.user_id,
              sessionId: token.session_id,
              organizationId: token.organization_id,
            }),
            expiresIn: this.tokens.ttlSeconds,
            sessionId: token.session_id,
            user,
          },
          refreshToken: next,
          refreshExpiresAt: token.session_expires_at,
        } satisfies IssuedSession,
      };
    });

    if ('error' in result) {
      if (result.revokedSession) await this.cache.revokeSessions([result.revokedSession]);
      const message =
        result.error === 'SESSION_REVOKED'
          ? 'You were signed out. Sign in again.'
          : result.error === 'SESSION_EXPIRED'
            ? 'Your session expired. Sign in again.'
            : 'Sign in to continue.';
      throw new UnauthenticatedError(result.error, message);
    }
    await this.cache.markSessionActive(
      result.issued.response.sessionId,
      result.issued.refreshExpiresAt,
    );
    return result.issued;
  }

  async logoutSession(sessionId: string, reason = 'signed_out'): Promise<void> {
    await this.db
      .updateTable('sessions')
      .set({ revoked_at: new Date(), revoked_reason: reason })
      .where('id', '=', sessionId)
      .where('revoked_at', 'is', null)
      .execute();
    await this.cache.revokeSessions([sessionId]);
  }

  async sessionIdForRefreshToken(refreshToken: string): Promise<string | null> {
    const row = await this.db
      .selectFrom('refresh_tokens')
      .select('session_id')
      .where('token_hash', '=', hashToken(refreshToken))
      .executeTakeFirst();
    return row?.session_id ?? null;
  }

  async forgotPassword(email: string): Promise<void> {
    const user = await this.db
      .selectFrom('users')
      .select(['id', 'email', 'first_name', 'last_name', 'status', 'organization_id'])
      .where(sql`lower(email)`, '=', email.toLowerCase())
      .executeTakeFirst();
    // Same response whether or not the account exists, to avoid account enumeration.
    if (!user || user.status !== 'active') {
      this.logger.info({ known: Boolean(user) }, 'password reset requested for ineligible account');
      return;
    }
    await this.db.transaction().execute(async (trx) => {
      const { token, expiresAt } = await issueOneTimeToken(
        trx,
        user.id,
        'password_reset',
        this.config.auth.resetTokenTtlMinutes * 60_000,
        null,
      );
      await this.events.emit(
        trx,
        identityEvents.passwordResetRequested,
        {
          userId: user.id,
          email: user.email,
          displayName: `${user.first_name} ${user.last_name}`,
          resetUrl: `${this.config.publicAppUrl}/reset-password?token=${encodeURIComponent(token)}`,
          expiresAt: expiresAt.toISOString(),
        },
        {
          organizationId: user.organization_id,
          subject: { type: 'user', id: user.id },
          actor: { type: 'user', id: user.id },
        },
      );
    });
  }

  private async findToken(token: string, purpose: OneTimeTokenPurpose | null, trx?: Trx) {
    const db = trx ?? this.db;
    const row = await db
      .selectFrom('one_time_tokens as t')
      .innerJoin('users as u', 'u.id', 't.user_id')
      .select([
        't.id',
        't.purpose',
        't.expires_at',
        't.used_at',
        'u.id as user_id',
        'u.organization_id',
        'u.email',
        'u.first_name',
        'u.last_name',
        'u.status',
      ])
      .where('t.token_hash', '=', hashToken(token))
      .$if(purpose !== null, (q) => q.where('t.purpose', '=', purpose!))
      .$if(Boolean(trx), (q) => q.forUpdate('t'))
      .executeTakeFirst();
    if (!row || row.used_at || row.expires_at <= new Date()) {
      throw new AppError(
        410,
        'TOKEN_INVALID',
        (purpose ?? row?.purpose) === 'activation'
          ? 'This activation link has expired or was already used. Ask your administrator to resend the invitation.'
          : 'This reset link has expired or was already used. Request a new one.',
      );
    }
    return row;
  }

  async tokenInfo(token: string): Promise<identity.TokenInfo> {
    const row = await this.findToken(token, null);
    const security = await this.securityOf(row.organization_id);
    return {
      purpose: row.purpose,
      email: row.email,
      displayName: `${row.first_name} ${row.last_name}`,
      passwordPolicy: { minLength: security.passwordMinLength },
    };
  }

  private async assertPolicy(
    organizationId: string,
    password: string,
    user: { email: string; first_name: string; last_name: string },
  ) {
    const security = await this.securityOf(organizationId);
    const problem = this.passwords.policyProblem(
      password,
      { minLength: security.passwordMinLength },
      {
        email: user.email,
        firstName: user.first_name,
        lastName: user.last_name,
      },
    );
    if (problem) throw new ValidationError([{ path: 'password', message: problem }]);
  }

  async resetPassword(token: string, password: string): Promise<void> {
    const preview = await this.findToken(token, 'password_reset');
    await this.assertPolicy(preview.organization_id, password, preview);
    const hash = await this.passwords.hash(password);
    const sessions = await this.db.transaction().execute(async (trx) => {
      const row = await this.findToken(token, 'password_reset', trx);
      await trx
        .updateTable('one_time_tokens')
        .set({ used_at: new Date() })
        .where('id', '=', row.id)
        .execute();
      await trx
        .insertInto('credentials')
        .values({ user_id: row.user_id, password_hash: hash })
        .onConflict((oc) =>
          oc
            .column('user_id')
            .doUpdateSet({ password_hash: hash, password_changed_at: new Date() }),
        )
        .execute();
      await trx
        .updateTable('users')
        .set({ failed_login_count: 0, locked_until: null })
        .where('id', '=', row.user_id)
        .execute();
      const revoked = await trx
        .updateTable('sessions')
        .set({ revoked_at: new Date(), revoked_reason: 'password_reset' })
        .where('user_id', '=', row.user_id)
        .where('revoked_at', 'is', null)
        .returning('id')
        .execute();
      await this.events.audit(
        trx,
        {
          action: 'user.password_reset',
          resourceType: 'user',
          resourceId: row.user_id,
          actorDisplay: `${row.first_name} ${row.last_name}`,
        },
        { organizationId: row.organization_id, actor: { type: 'user', id: row.user_id } },
      );
      return revoked.map((s) => s.id);
    });
    await this.cache.revokeSessions(sessions);
  }

  async activate(token: string, password: string): Promise<IssuedSession> {
    const preview = await this.findToken(token, 'activation');
    if (preview.status !== 'invited') {
      throw new PreconditionError(
        'ALREADY_ACTIVATED',
        'This account is already active. Sign in instead.',
      );
    }
    await this.assertPolicy(preview.organization_id, password, preview);
    const hash = await this.passwords.hash(password);
    const security = await this.securityOf(preview.organization_id);
    const issued = await this.db.transaction().execute(async (trx) => {
      const row = await this.findToken(token, 'activation', trx);
      await trx
        .updateTable('one_time_tokens')
        .set({ used_at: new Date() })
        .where('id', '=', row.id)
        .execute();
      await trx
        .insertInto('credentials')
        .values({ user_id: row.user_id, password_hash: hash })
        .onConflict((oc) =>
          oc
            .column('user_id')
            .doUpdateSet({ password_hash: hash, password_changed_at: new Date() }),
        )
        .execute();
      await trx
        .updateTable('users')
        .set({ status: 'active', activated_at: new Date(), last_login_at: new Date() })
        .where('id', '=', row.user_id)
        .execute();
      await this.events.emit(
        trx,
        identityEvents.userActivated,
        { userId: row.user_id },
        {
          organizationId: row.organization_id,
          subject: { type: 'user', id: row.user_id },
          actor: { type: 'user', id: row.user_id },
        },
      );
      await this.directory.users(trx, [row.user_id]);
      return this.startSession(trx, row.user_id, row.organization_id, security.sessionMaxHours);
    });
    await this.cache.invalidateUsers([preview.user_id]);
    await this.cache.markSessionActive(issued.response.sessionId, issued.refreshExpiresAt);
    return issued;
  }

  async changePassword(
    actor: Principal,
    currentPassword: string,
    newPassword: string,
  ): Promise<void> {
    const user = await this.db
      .selectFrom('users')
      .innerJoin('credentials', 'credentials.user_id', 'users.id')
      .select([
        'users.id',
        'users.organization_id',
        'users.email',
        'users.first_name',
        'users.last_name',
        'credentials.password_hash',
      ])
      .where('users.id', '=', actor.userId)
      .executeTakeFirstOrThrow();
    if (!(await this.passwords.verify(user.password_hash, currentPassword))) {
      throw new ValidationError([
        { path: 'currentPassword', message: 'Your current password is incorrect.' },
      ]);
    }
    await this.assertPolicy(user.organization_id, newPassword, user);
    const hash = await this.passwords.hash(newPassword);
    const others = await this.db.transaction().execute(async (trx) => {
      await trx
        .updateTable('credentials')
        .set({ password_hash: hash, password_changed_at: new Date() })
        .where('user_id', '=', user.id)
        .execute();
      const revoked = await trx
        .updateTable('sessions')
        .set({ revoked_at: new Date(), revoked_reason: 'password_changed' })
        .where('user_id', '=', user.id)
        .where('revoked_at', 'is', null)
        .$if(Boolean(actor.sessionId), (q) => q.where('id', '!=', actor.sessionId!))
        .returning('id')
        .execute();
      await this.events.audit(trx, {
        action: 'user.password_changed',
        resourceType: 'user',
        resourceId: user.id,
        actorDisplay: actor.displayName,
      });
      return revoked.map((r) => r.id);
    });
    await this.cache.revokeSessions(others);
  }

  async featureFlags(organizationId: string): Promise<FeatureFlagState> {
    const rows = await this.db
      .selectFrom('feature_flags')
      .select(['key', 'enabled'])
      .where('organization_id', '=', organizationId)
      .execute();
    const flags = defaultFeatureFlags();
    for (const r of rows) if (r.key in flags) flags[r.key as keyof FeatureFlagState] = r.enabled;
    return flags;
  }

  async me(actor: Principal): Promise<identity.MeResponse> {
    return {
      user: await this.sessionUser(this.db, actor.userId),
      permissions: actor.permissions.toJSON(),
      featureFlags: await this.featureFlags(actor.organizationId),
      managedTeamIds: [...actor.managedTeamIds],
    };
  }
}
