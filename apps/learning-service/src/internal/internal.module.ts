import { Module } from '@nestjs/common';
import { LearningInternalController } from './internal.controller.js';

@Module({ controllers: [LearningInternalController] })
export class InternalModule {}
