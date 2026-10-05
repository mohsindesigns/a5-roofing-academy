import { Global, Module } from '@nestjs/common';
import { ScopeService } from '../common/scope.service.js';
import { FactsService } from './facts.service.js';
import { ProgressService } from './progress.service.js';
import { TreeService } from './tree.service.js';

/** Progression core shared by every feature module. */
@Global()
@Module({
  providers: [TreeService, FactsService, ProgressService, ScopeService],
  exports: [TreeService, FactsService, ProgressService, ScopeService],
})
export class EngineModule {}
