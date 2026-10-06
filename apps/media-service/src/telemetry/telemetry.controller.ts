import { Body, HttpCode, Post } from '@nestjs/common';
import { ApiBody } from '@nestjs/swagger';
import type { Principal } from '@a5/auth';
import { media } from '@a5/contracts';
import {
  ApiController,
  AppError,
  CurrentPrincipal,
  Public,
  ZBody,
  ZodValidationPipe,
  ZResponse,
  jsonSchema,
} from '@a5/nest-kit';
import { TelemetryService } from './telemetry.service.js';

const heartbeatPipe = new ZodValidationPipe(media.heartbeatRequestSchema);

@ApiController('media/playback', 'media')
export class TelemetryController {
  constructor(private readonly telemetry: TelemetryService) {}

  /** Periodic watch report from the player (every ~15 s while playing). */
  @Post('heartbeat')
  @HttpCode(200)
  @ZResponse(media.heartbeatResponseSchema)
  heartbeat(
    @CurrentPrincipal() p: Principal,
    @ZBody(media.heartbeatRequestSchema) body: media.HeartbeatRequest,
  ) {
    return this.telemetry.heartbeat(body, p);
  }

  /**
   * Final report sent with `navigator.sendBeacon` on pause, end or page hide. Beacons cannot carry
   * an Authorization header, so the signed playback token in the body is the only credential.
   * Accepts `text/plain` (sendBeacon with a string) as well as `application/json`.
   */
  @Public()
  @Post('beacon')
  @HttpCode(204)
  @ApiBody({ schema: jsonSchema(media.heartbeatRequestSchema) })
  async beacon(@Body() raw: unknown): Promise<void> {
    let value = raw;
    if (typeof raw === 'string') {
      try {
        value = JSON.parse(raw);
      } catch {
        throw new AppError(400, 'MALFORMED_JSON', 'The request body is not valid JSON.');
      }
    }
    await this.telemetry.heartbeat(heartbeatPipe.transform(value), null);
  }
}
