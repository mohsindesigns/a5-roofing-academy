import { Module } from '@nestjs/common';
import { AccessModule } from '../access/access.module.js';
import { DirectoryPublisher } from '../common/directory-publisher.js';
import { UsersController } from './users.controller.js';
import { UsersRepository } from './users.repository.js';
import { UsersService } from './users.service.js';

@Module({
  imports: [AccessModule],
  controllers: [UsersController],
  providers: [UsersService, UsersRepository, DirectoryPublisher],
  exports: [UsersService, UsersRepository, DirectoryPublisher],
})
export class UsersModule {}
