import { Module } from '@nestjs/common';
import { AccessModule } from '../access/access.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { IdentityInternalController } from './internal.controller.js';

@Module({
  imports: [AccessModule, AuthModule],
  controllers: [IdentityInternalController],
})
export class InternalModule {}
