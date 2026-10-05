import {
  SignJWT,
  exportJWK,
  generateKeyPair,
  importJWK,
  importPKCS8,
  importSPKI,
  jwtVerify,
  type CryptoKey,
  type JWK,
  type JWTPayload,
  type KeyObject,
} from 'jose';
import { compactPermissions, expandPermissions, type CompactPermissions } from '@a5/permissions';
import { Principal, type PrincipalData } from './principal.js';

type SigningKey = CryptoKey | KeyObject | Uint8Array;

export class TokenError extends Error {
  constructor(
    message: string,
    readonly code: 'expired' | 'invalid' = 'invalid',
  ) {
    super(message);
    this.name = 'TokenError';
  }
}

async function verify<T extends JWTPayload>(
  token: string,
  key: SigningKey,
  options: { issuer?: string; audience: string; algorithms: string[] },
): Promise<T> {
  try {
    const { payload } = await jwtVerify(token, key, options);
    return payload as T;
  } catch (err) {
    const code = (err as { code?: string }).code === 'ERR_JWT_EXPIRED' ? 'expired' : 'invalid';
    throw new TokenError(code === 'expired' ? 'Token expired' : 'Token invalid', code);
  }
}

// ------------------------------------------------------------------ access tokens (Ed25519)

export const ACCESS_TOKEN_ISSUER = 'a5-identity';
export const ACCESS_TOKEN_AUDIENCE = 'a5-api';

export interface AccessTokenClaims {
  sub: string;
  sid: string;
  org: string;
}

export interface AccessKeyPair {
  privateKey: SigningKey;
  publicKey: SigningKey;
  kid: string;
}

export async function importAccessKeys(privatePem: string | undefined, publicPem: string, kid = 'a5-1') {
  return {
    privateKey: privatePem ? await importPKCS8(privatePem, 'EdDSA') : undefined,
    publicKey: await importSPKI(publicPem, 'EdDSA'),
    kid,
  };
}

/** Ephemeral key pair for tests. */
export async function generateAccessKeys(): Promise<AccessKeyPair & { publicJwk: JWK }> {
  const { privateKey, publicKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
  return { privateKey, publicKey, kid: 'test', publicJwk: await exportJWK(publicKey) };
}

export async function importPublicJwk(jwk: JWK): Promise<SigningKey> {
  return importJWK(jwk, 'EdDSA') as Promise<SigningKey>;
}

export async function signAccessToken(
  claims: AccessTokenClaims,
  key: { privateKey: SigningKey; kid: string },
  ttlSeconds: number,
): Promise<string> {
  return new SignJWT({ sid: claims.sid, org: claims.org })
    .setProtectedHeader({ alg: 'EdDSA', kid: key.kid, typ: 'at+jwt' })
    .setSubject(claims.sub)
    .setIssuer(ACCESS_TOKEN_ISSUER)
    .setAudience(ACCESS_TOKEN_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${ttlSeconds}s`)
    .sign(key.privateKey);
}

export async function verifyAccessToken(token: string, publicKey: SigningKey): Promise<AccessTokenClaims> {
  const payload = await verify<JWTPayload & { sid?: string; org?: string }>(token, publicKey, {
    issuer: ACCESS_TOKEN_ISSUER,
    audience: ACCESS_TOKEN_AUDIENCE,
    algorithms: ['EdDSA'],
  });
  if (!payload.sub || !payload.sid || !payload.org) throw new TokenError('Token missing claims');
  return { sub: payload.sub, sid: payload.sid, org: payload.org };
}

// ------------------------------------------------------------------ internal tokens (HS256)

export const INTERNAL_AUDIENCE = 'a5-internal';
export const GRANT_AUDIENCE = 'a5-grant';
export const PRINCIPAL_HEADER = 'x-a5-principal';
export const SERVICE_TOKEN_HEADER = 'x-a5-service';

function secretKey(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

interface PrincipalClaims extends JWTPayload {
  org: string;
  sid: string | null;
  name: string;
  roles: string[];
  perms: CompactPermissions;
  mt: string[];
  mu: string[];
}

/** Gateway → service principal token. Short lived; never leaves the internal network. */
export async function signPrincipalToken(data: PrincipalData, secret: string, ttlSeconds = 60): Promise<string> {
  const claims: Omit<PrincipalClaims, keyof JWTPayload> = {
    org: data.organizationId,
    sid: data.sessionId,
    name: data.displayName,
    roles: data.roles,
    perms: compactPermissions(data.permissions),
    mt: data.managedTeamIds,
    mu: data.managedUserIds,
  };
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(data.userId)
    .setAudience(INTERNAL_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${ttlSeconds}s`)
    .sign(secretKey(secret));
}

export async function verifyPrincipalToken(token: string, secret: string): Promise<Principal> {
  const p = await verify<PrincipalClaims>(token, secretKey(secret), {
    audience: INTERNAL_AUDIENCE,
    algorithms: ['HS256'],
  });
  if (!p.sub || !p.org) throw new TokenError('Principal token missing claims');
  return new Principal({
    userId: p.sub,
    organizationId: p.org,
    sessionId: p.sid ?? null,
    displayName: p.name ?? '',
    roles: p.roles ?? [],
    permissions: expandPermissions(p.perms ?? {}),
    managedTeamIds: p.mt ?? [],
    managedUserIds: p.mu ?? [],
  });
}

/** Service-to-service token for `/internal/*` endpoints. */
export async function signServiceToken(service: string, secret: string, ttlSeconds = 60): Promise<string> {
  return new SignJWT({ svc: service })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(`service:${service}`)
    .setAudience(INTERNAL_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${ttlSeconds}s`)
    .sign(secretKey(secret));
}

export async function verifyServiceToken(token: string, secret: string): Promise<{ service: string }> {
  const p = await verify<JWTPayload & { svc?: string }>(token, secretKey(secret), {
    audience: INTERNAL_AUDIENCE,
    algorithms: ['HS256'],
  });
  if (!p.svc) throw new TokenError('Not a service token');
  return { service: p.svc };
}

// ------------------------------------------------------------------ lesson grants

export interface LessonGrant {
  userId: string;
  organizationId: string;
  programId: string;
  enrollmentId: string;
  lessonId: string;
  resource: { type: 'media' | 'assessment' | 'ai_scenario' | 'document'; id: string };
  /** Resource-specific policy, e.g. video completion rules. */
  policy: Record<string, unknown>;
}

/**
 * Capability issued by learning-service when a learner opens an unlocked lesson. Media, assessment
 * and AI services verify it instead of calling learning-service synchronously.
 */
export async function signLessonGrant(grant: LessonGrant, secret: string, ttlSeconds = 4 * 3600): Promise<string> {
  return new SignJWT({
    org: grant.organizationId,
    prg: grant.programId,
    enr: grant.enrollmentId,
    les: grant.lessonId,
    res: grant.resource,
    pol: grant.policy,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(grant.userId)
    .setAudience(GRANT_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${ttlSeconds}s`)
    .sign(secretKey(secret));
}

export async function verifyLessonGrant(token: string, secret: string): Promise<LessonGrant> {
  const p = await verify<
    JWTPayload & {
      org: string;
      prg: string;
      enr: string;
      les: string;
      res: LessonGrant['resource'];
      pol: Record<string, unknown>;
    }
  >(token, secretKey(secret), { audience: GRANT_AUDIENCE, algorithms: ['HS256'] });
  if (!p.sub || !p.res) throw new TokenError('Grant missing claims');
  return {
    userId: p.sub,
    organizationId: p.org,
    programId: p.prg,
    enrollmentId: p.enr,
    lessonId: p.les,
    resource: p.res,
    policy: p.pol ?? {},
  };
}
