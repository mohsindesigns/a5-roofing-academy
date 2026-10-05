import { Module } from '@nestjs/common';
import { EvaluationService } from './evaluation/evaluation.service.js';
import { PersonasService } from './personas/personas.service.js';
import { ReviewController } from './review/review.controller.js';
import { ReviewService } from './review/review.service.js';
import { RubricsService } from './rubrics/rubrics.service.js';
import {
  PersonasController,
  RubricsController,
  ScenariosController,
} from './scenarios/admin.controllers.js';
import { CatalogService } from './scenarios/catalog.service.js';
import { PromptVersionService } from './scenarios/prompt-versions.service.js';
import { ScenariosService } from './scenarios/scenarios.service.js';
import { ConversationEngine } from './sessions/conversation.engine.js';
import { SessionLifecycle } from './sessions/lifecycle.js';
import { MaintenanceService } from './sessions/maintenance.service.js';
import { SessionView } from './sessions/session-view.js';
import {
  MySessionsController,
  PracticeController,
  SessionsController,
  TestRunController,
} from './sessions/sessions.controller.js';
import { SessionsService } from './sessions/sessions.service.js';
import { SettingsController, UsageController } from './settings/settings.controller.js';
import { SettingsService } from './settings/settings.service.js';
import { UsageService } from './usage/usage.service.js';

/** Organization AI settings and usage analytics. */
@Module({
  controllers: [SettingsController, UsageController],
  providers: [SettingsService, UsageService],
  exports: [SettingsService, UsageService],
})
export class SettingsModule {}

/** Personas, rubrics, scenarios and immutable prompt versions. */
@Module({
  controllers: [PersonasController, RubricsController, ScenariosController],
  providers: [
    PromptVersionService,
    PersonasService,
    RubricsService,
    ScenariosService,
    CatalogService,
  ],
  exports: [PromptVersionService, ScenariosService, CatalogService],
})
export class ScenariosModule {}

/** Practice sessions: conversation engine, lifecycle, evaluation worker and maintenance. */
@Module({
  imports: [SettingsModule, ScenariosModule],
  controllers: [PracticeController, SessionsController, MySessionsController, TestRunController],
  providers: [
    SessionView,
    EvaluationService,
    SessionLifecycle,
    ConversationEngine,
    SessionsService,
    MaintenanceService,
  ],
  exports: [
    SessionView,
    EvaluationService,
    ConversationEngine,
    SessionsService,
    MaintenanceService,
  ],
})
export class SessionsModule {}

/** Trainer / manager review of sessions in scope. */
@Module({
  imports: [SessionsModule],
  controllers: [ReviewController],
  providers: [ReviewService],
})
export class ReviewModule {}
