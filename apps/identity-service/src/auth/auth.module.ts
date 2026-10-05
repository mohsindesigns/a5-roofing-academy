import { Module } from '@nestjs/common';
import { AccessModule } from '../access/access.module.js';
import { PasswordService } from '../common/passwords.js';
import { UsersModule } from '../users/users.module.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { TokenService } from './token.service.js';

@Module({
  imports: [AccessModule, UsersModule],
  controllers: [AuthController],
  providers: [AuthService, TokenService, PasswordService],
  exports: [AuthService, PasswordService],
})
export class AuthModule {}
