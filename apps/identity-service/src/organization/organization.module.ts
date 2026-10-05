import { Module } from '@nestjs/common';
import { AccessModule } from '../access/access.module.js';
import { UsersModule } from '../users/users.module.js';
import {
  DepartmentsController,
  FeatureFlagsController,
  LocationsController,
  OrganizationController,
  SettingsController,
  TeamsController,
} from './organization.controller.js';
import { OrganizationService } from './organization.service.js';

@Module({
  imports: [AccessModule, UsersModule],
  controllers: [
    OrganizationController,
    LocationsController,
    DepartmentsController,
    TeamsController,
    SettingsController,
    FeatureFlagsController,
  ],
  providers: [OrganizationService],
  exports: [OrganizationService],
})
export class OrganizationModule {}
