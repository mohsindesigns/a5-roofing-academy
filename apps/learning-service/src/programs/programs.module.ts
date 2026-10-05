import { Module } from '@nestjs/common';
import { LessonsController } from './lessons.controller.js';
import { ProgramsController } from './programs.controller.js';
import { ProgramsRepository } from './programs.repository.js';
import { ProgramsService } from './programs.service.js';
import { PublishService } from './publish.service.js';
import { StructureController } from './structure.controller.js';
import { StructureService } from './structure.service.js';

@Module({
  controllers: [ProgramsController, StructureController, LessonsController],
  providers: [ProgramsRepository, ProgramsService, StructureService, PublishService],
  exports: [ProgramsRepository, ProgramsService, PublishService],
})
export class ProgramsModule {}
