import { Global, Module } from '@nestjs/common';
import { People } from './people.js';

@Global()
@Module({ providers: [People], exports: [People] })
export class CommonModule {}
