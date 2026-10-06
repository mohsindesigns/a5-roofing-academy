import { Controller, applyDecorators } from '@nestjs/common';
import { ApiExcludeController, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { Internal } from './auth.js';

export const API_PREFIX = 'api/v1';

/** Public API controller under /api/v1, reached through the gateway. */
export function ApiController(path: string, tag?: string): ClassDecorator {
  return applyDecorators(
    Controller(`${API_PREFIX}/${path}`),
    ApiTags(tag ?? path.split('/')[0] ?? path),
    ApiSecurity('principal'),
  );
}

/** Service-to-service controller under /internal. Never routed by the gateway. */
export function InternalController(path: string): ClassDecorator {
  return applyDecorators(Controller(`internal/${path}`), Internal(), ApiExcludeController());
}
