import { Get, HttpCode, Patch, Post } from '@nestjs/common';
import type { z } from 'zod';
import type { Principal } from '@a5/auth';
import { ai } from '@a5/contracts';
import {
  ApiController,
  CurrentPrincipal,
  RequirePermissions,
  ZBody,
  ZParam,
  ZQuery,
  ZResponse,
} from '@a5/nest-kit';
import { PersonasService } from '../personas/personas.service.js';
import { RubricsService } from '../rubrics/rubrics.service.js';
import { PromptVersionService } from './prompt-versions.service.js';
import { ScenariosService } from './scenarios.service.js';

@ApiController('ai/personas', 'ai-admin')
export class PersonasController {
  constructor(private readonly personas: PersonasService) {}

  @Get()
  @RequirePermissions('ai_scenarios.view')
  @ZResponse(ai.personaPageSchema)
  list(
    @CurrentPrincipal() p: Principal,
    @ZQuery(ai.listPersonasQuerySchema) q: z.infer<typeof ai.listPersonasQuerySchema>,
  ) {
    return this.personas.list(p, q);
  }

  @Get(':id')
  @RequirePermissions('ai_scenarios.view')
  @ZResponse(ai.personaSchema)
  get(@CurrentPrincipal() p: Principal, @ZParam('id') id: string) {
    return this.personas.get(p, id);
  }

  @Post()
  @RequirePermissions('ai_scenarios.create')
  @ZResponse(ai.personaSchema)
  create(
    @CurrentPrincipal() p: Principal,
    @ZBody(ai.createPersonaRequestSchema) body: ai.CreatePersonaRequest,
  ) {
    return this.personas.create(p, body);
  }

  /** Editing a persona creates new prompt versions for every live scenario that uses it. */
  @Patch(':id')
  @RequirePermissions('ai_scenarios.update')
  @ZResponse(ai.personaSchema)
  update(
    @CurrentPrincipal() p: Principal,
    @ZParam('id') id: string,
    @ZBody(ai.updatePersonaRequestSchema) body: ai.UpdatePersonaRequest,
  ) {
    return this.personas.update(p, id, body);
  }

  @Post(':id/archive')
  @HttpCode(200)
  @RequirePermissions('ai_scenarios.update')
  @ZResponse(ai.personaSchema)
  archive(@CurrentPrincipal() p: Principal, @ZParam('id') id: string) {
    return this.personas.archive(p, id);
  }
}

@ApiController('ai/rubrics', 'ai-admin')
export class RubricsController {
  constructor(private readonly rubrics: RubricsService) {}

  @Get()
  @RequirePermissions('ai_scenarios.view')
  @ZResponse(ai.rubricPageSchema)
  list(
    @CurrentPrincipal() p: Principal,
    @ZQuery(ai.listRubricsQuerySchema) q: z.infer<typeof ai.listRubricsQuerySchema>,
  ) {
    return this.rubrics.list(p, q);
  }

  @Get(':id')
  @RequirePermissions('ai_scenarios.view')
  @ZResponse(ai.rubricDetailSchema)
  get(@CurrentPrincipal() p: Principal, @ZParam('id') id: string) {
    return this.rubrics.get(p, id);
  }

  @Get(':id/versions/:versionId')
  @RequirePermissions('ai_scenarios.view')
  @ZResponse(ai.rubricVersionSchema)
  version(
    @CurrentPrincipal() p: Principal,
    @ZParam('id') id: string,
    @ZParam('versionId') versionId: string,
  ) {
    return this.rubrics.getVersion(p, id, versionId);
  }

  /** Omit `categories` to start from the fourteen default A5 categories. */
  @Post()
  @RequirePermissions('ai_scenarios.create')
  @ZResponse(ai.rubricDetailSchema)
  create(
    @CurrentPrincipal() p: Principal,
    @ZBody(ai.createRubricRequestSchema) body: ai.CreateRubricRequest,
  ) {
    return this.rubrics.create(p, body);
  }

  @Patch(':id')
  @RequirePermissions('ai_scenarios.update')
  @ZResponse(ai.rubricDetailSchema)
  update(
    @CurrentPrincipal() p: Principal,
    @ZParam('id') id: string,
    @ZBody(ai.updateRubricRequestSchema) body: z.infer<typeof ai.updateRubricRequestSchema>,
  ) {
    return this.rubrics.update(p, id, body);
  }

  /** Categories and passing score are immutable per version: changes publish a new version. */
  @Post(':id/versions')
  @RequirePermissions('ai_scenarios.update')
  @ZResponse(ai.rubricDetailSchema)
  createVersion(
    @CurrentPrincipal() p: Principal,
    @ZParam('id') id: string,
    @ZBody(ai.createRubricVersionRequestSchema) body: ai.CreateRubricVersionRequest,
  ) {
    return this.rubrics.createVersion(p, id, body);
  }

  @Post(':id/archive')
  @HttpCode(200)
  @RequirePermissions('ai_scenarios.update')
  @ZResponse(ai.rubricDetailSchema)
  archive(@CurrentPrincipal() p: Principal, @ZParam('id') id: string) {
    return this.rubrics.archive(p, id);
  }
}

@ApiController('ai/scenarios', 'ai-admin')
export class ScenariosController {
  constructor(
    private readonly scenarios: ScenariosService,
    private readonly versions: PromptVersionService,
  ) {}

  @Get()
  @RequirePermissions('ai_scenarios.view')
  @ZResponse(ai.scenarioPageSchema)
  list(
    @CurrentPrincipal() p: Principal,
    @ZQuery(ai.listScenariosQuerySchema) q: z.infer<typeof ai.listScenariosQuerySchema>,
  ) {
    return this.scenarios.list(p, q);
  }

  @Get(':id')
  @RequirePermissions('ai_scenarios.view')
  @ZResponse(ai.scenarioDetailSchema)
  get(@CurrentPrincipal() p: Principal, @ZParam('id') id: string) {
    return this.scenarios.get(p, id);
  }

  @Post()
  @RequirePermissions('ai_scenarios.create')
  @ZResponse(ai.scenarioDetailSchema)
  create(
    @CurrentPrincipal() p: Principal,
    @ZBody(ai.createScenarioRequestSchema) body: ai.CreateScenarioRequest,
  ) {
    return this.scenarios.create(p, body);
  }

  @Patch(':id')
  @RequirePermissions('ai_scenarios.update')
  @ZResponse(ai.scenarioDetailSchema)
  update(
    @CurrentPrincipal() p: Principal,
    @ZParam('id') id: string,
    @ZBody(ai.updateScenarioRequestSchema) body: ai.UpdateScenarioRequest,
  ) {
    return this.scenarios.update(p, id, body);
  }

  @Post(':id/publish')
  @HttpCode(200)
  @RequirePermissions('ai_scenarios.update')
  @ZResponse(ai.scenarioDetailSchema)
  publish(@CurrentPrincipal() p: Principal, @ZParam('id') id: string) {
    return this.scenarios.publish(p, id);
  }

  @Post(':id/archive')
  @HttpCode(200)
  @RequirePermissions('ai_scenarios.update')
  @ZResponse(ai.scenarioDetailSchema)
  archive(@CurrentPrincipal() p: Principal, @ZParam('id') id: string) {
    return this.scenarios.archive(p, id);
  }

  @Post(':id/duplicate')
  @RequirePermissions('ai_scenarios.create')
  @ZResponse(ai.scenarioDetailSchema)
  duplicate(
    @CurrentPrincipal() p: Principal,
    @ZParam('id') id: string,
    @ZBody(ai.duplicateScenarioRequestSchema)
    body: z.infer<typeof ai.duplicateScenarioRequestSchema>,
  ) {
    return this.scenarios.duplicate(p, id, body);
  }

  @Get(':id/prompt-versions')
  @RequirePermissions('ai_scenarios.view')
  @ZResponse(ai.promptVersionListSchema)
  versionsList(@CurrentPrincipal() p: Principal, @ZParam('id') id: string) {
    return this.versions.list(p, id);
  }

  @Get(':id/prompt-versions/diff')
  @RequirePermissions('ai_scenarios.view')
  @ZResponse(ai.promptVersionDiffSchema)
  diff(
    @CurrentPrincipal() p: Principal,
    @ZParam('id') id: string,
    @ZQuery(ai.promptVersionDiffQuerySchema) q: z.infer<typeof ai.promptVersionDiffQuerySchema>,
  ) {
    return this.versions.diff(p, id, q.from, q.to);
  }

  @Get(':id/prompt-versions/:versionId')
  @RequirePermissions('ai_scenarios.view')
  @ZResponse(ai.promptVersionDetailSchema)
  version(
    @CurrentPrincipal() p: Principal,
    @ZParam('id') id: string,
    @ZParam('versionId') versionId: string,
  ) {
    return this.versions.get(p, id, versionId);
  }
}
