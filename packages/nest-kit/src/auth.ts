import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  SetMetadata,
  createParamDecorator,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ApiHeader, ApiSecurity } from '@nestjs/swagger';
import {
  PRINCIPAL_HEADER,
  SERVICE_TOKEN_HEADER,
  TokenError,
  verifyPrincipalToken,
  verifyServiceToken,
  type Principal,
} from '@a5/auth';
import { patchContext } from '@a5/observability';
import type { PermissionKey } from '@a5/permissions';
import { ForbiddenError, UnauthenticatedError } from './errors.js';
import { SERVICE_CONFIG } from './tokens.js';
import type { ServiceRuntimeConfig } from './config.js';
import type { A5Request } from './types.js';

const IS_PUBLIC = 'a5:public';
const IS_INTERNAL = 'a5:internal';
const REQUIRED_ALL = 'a5:permissions:all';
const REQUIRED_ANY = 'a5:permissions:any';

/** Route is reachable without a principal (login, public certificate verification). */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/** Route is for service-to-service calls only and requires a service token. */
export const Internal = () => SetMetadata(IS_INTERNAL, true);

/** Every listed permission is required. */
export const RequirePermissions = (...permissions: PermissionKey[]) =>
  SetMetadata(REQUIRED_ALL, permissions);

/** At least one listed permission is required. */
export const RequireAnyPermission = (...permissions: PermissionKey[]) =>
  SetMetadata(REQUIRED_ANY, permissions);

export const CurrentPrincipal = createParamDecorator((_data: unknown, ctx: ExecutionContext) => {
  const req = ctx.switchToHttp().getRequest<A5Request>();
  if (!req.principal) throw new UnauthenticatedError();
  return req.principal;
});

export const OptionalPrincipal = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext) =>
    ctx.switchToHttp().getRequest<A5Request>().principal ?? null,
);

export const ApiPrincipal = () =>
  ApiHeader({
    name: PRINCIPAL_HEADER,
    required: true,
    description: 'Internal principal token (set by the gateway)',
  });

/**
 * Global guard: authenticates the caller from the gateway-issued principal token (or a service
 * token on internal routes) and enforces declared permissions.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(SERVICE_CONFIG) private readonly config: ServiceRuntimeConfig,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const req = context.switchToHttp().getRequest<A5Request>();
    const targets = [context.getHandler(), context.getClass()];

    if (this.reflector.getAllAndOverride<boolean>(IS_INTERNAL, targets)) {
      const token = req.header(SERVICE_TOKEN_HEADER);
      if (!token)
        throw new UnauthenticatedError('SERVICE_TOKEN_REQUIRED', 'Service token required.');
      try {
        req.serviceCaller = (
          await verifyServiceToken(token, this.config.internalAuthSecret)
        ).service;
      } catch {
        throw new UnauthenticatedError('TOKEN_INVALID', 'Service token is invalid.');
      }
      return true;
    }

    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets);
    const token = req.header(PRINCIPAL_HEADER);
    if (token) {
      try {
        req.principal = await verifyPrincipalToken(token, this.config.internalAuthSecret);
        patchContext({
          userId: req.principal.userId,
          organizationId: req.principal.organizationId,
        });
      } catch (err) {
        if (!isPublic) {
          throw new UnauthenticatedError(
            err instanceof TokenError && err.code === 'expired'
              ? 'SESSION_EXPIRED'
              : 'UNAUTHENTICATED',
            'Your session expired. Sign in again.',
          );
        }
      }
    }
    if (isPublic) return true;
    if (!req.principal) throw new UnauthenticatedError();

    const all = this.reflector.getAllAndOverride<PermissionKey[] | undefined>(
      REQUIRED_ALL,
      targets,
    );
    const any = this.reflector.getAllAndOverride<PermissionKey[] | undefined>(
      REQUIRED_ANY,
      targets,
    );
    assertPermissions(req.principal, all, any);
    return true;
  }
}

export function assertPermissions(
  principal: Principal,
  all: readonly PermissionKey[] | undefined,
  any?: readonly PermissionKey[] | undefined,
): void {
  if (all?.length && !principal.permissions.hasAll(all)) {
    throw new ForbiddenError(undefined, { required: all });
  }
  if (any?.length && !principal.permissions.hasAny(any)) {
    throw new ForbiddenError(undefined, { requiredAny: any });
  }
}

export const ApiPrincipalAuth = () => ApiSecurity('principal');
