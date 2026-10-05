import { Get, Header } from '@nestjs/common';
import { certification } from '@a5/contracts';
import { ApiController, Public, ZParam, ZResponse } from '@a5/nest-kit';
import { VerificationService } from './verification.service.js';

/** Public certificate verification (rate limited by the gateway). Never requires a principal. */
@ApiController('public/certificates', 'verification')
export class VerificationController {
  constructor(private readonly verification: VerificationService) {}

  @Get('verify/:token')
  @Public()
  @Header('Cache-Control', 'no-store')
  @ZResponse(certification.publicVerificationSchema)
  verify(@ZParam('token', certification.verificationTokenSchema) token: string) {
    return this.verification.verify(token);
  }
}
