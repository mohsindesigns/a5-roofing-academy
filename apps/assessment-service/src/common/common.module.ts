import { Global, Module } from '@nestjs/common';
import { DirectoryReader } from '@a5/directory';
import { EventBus } from '@a5/nest-kit';
import { AttemptEngine } from '../engine/attempt-engine.js';
import { People } from './people.js';

/** Providers shared by every feature module. */
@Global()
@Module({
  providers: [
    People,
    {
      provide: AttemptEngine,
      inject: [EventBus, DirectoryReader],
      useFactory: (events: EventBus, directory: DirectoryReader) => new AttemptEngine(events, directory),
    },
  ],
  exports: [People, AttemptEngine],
})
export class CommonModule {}
