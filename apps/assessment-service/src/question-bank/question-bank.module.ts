import { Module } from '@nestjs/common';
import { BanksController } from './banks.controller.js';
import { BanksService } from './banks.service.js';
import { QuestionsController } from './questions.controller.js';
import { QuestionsService } from './questions.service.js';

@Module({
  controllers: [BanksController, QuestionsController],
  providers: [BanksService, QuestionsService],
  exports: [QuestionsService],
})
export class QuestionBankModule {}
