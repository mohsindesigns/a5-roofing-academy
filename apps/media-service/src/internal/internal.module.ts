import { Module } from '@nestjs/common';
import { MediaInternalController } from './internal.controller.js';

@Module({ controllers: [MediaInternalController] })
export class InternalModule {}
