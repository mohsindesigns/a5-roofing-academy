import { DynamicModule, Global, Module } from '@nestjs/common';
import { DirectoryReader } from '@a5/directory';
import { EventBus } from '@a5/nest-kit';
import { AttemptEngine } from '../engine/attempt-engine.js';
import { Clock } from './clock.js';
import { People } from './people.js';

/** Providers shared by every feature module. */
@Global()
@Module({})
export class CommonModule {
  static register(clock: Clock = new Clock()): DynamicModule {
    return {
      module: CommonModule,
      providers: [
        People,
        { provide: Clock, useValue: clock },
        {
          provide: AttemptEngine,
          inject: [EventBus, DirectoryReader],
          useFactory: (events: EventBus, directory: DirectoryReader) => new AttemptEngine(events, directory),
        },
      ],
      exports: [People, Clock, AttemptEngine],
    };
  }
}
