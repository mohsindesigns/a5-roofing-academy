import { Delete, Get, HttpCode, Patch, Post } from '@nestjs/common';
import { z } from 'zod';
import type { Principal } from '@a5/auth';
import { learning, okSchema } from '@a5/contracts';
import {
  ApiController,
  CurrentPrincipal,
  RequireAnyPermission,
  RequirePermissions,
  ZBody,
  ZParam,
  ZQuery,
  ZResponse,
} from '@a5/nest-kit';
import { LearnerService } from './learner.service.js';
import { SearchService } from './search.service.js';

type Out<T extends z.ZodType> = z.output<T>;

/** The signed-in learner's own training (`/learning/me/...`) and search. */
@ApiController('learning')
export class LearnerController {
  constructor(
    private readonly learner: LearnerService,
    private readonly searcher: SearchService,
  ) {}

  @Get('me/enrollments')
  @RequirePermissions('training.participate')
  @ZResponse(learning.myEnrollmentListSchema)
  async enrollments(@CurrentPrincipal() p: Principal) {
    return { items: await this.learner.myEnrollments(p) };
  }

  @Get('me/continue')
  @RequirePermissions('training.participate')
  @ZResponse(learning.continueLearningSchema)
  continueLearning(@CurrentPrincipal() p: Principal) {
    return this.learner.continueLearning(p);
  }

  @Get('me/catalog')
  @RequirePermissions('training.participate')
  @ZResponse(learning.catalogSchema)
  async catalog(@CurrentPrincipal() p: Principal) {
    return { items: await this.learner.catalog(p) };
  }

  @Post('me/programs/:programId/enroll')
  @HttpCode(200)
  @RequirePermissions('training.participate')
  @ZResponse(learning.myEnrollmentSchema)
  selfEnroll(@CurrentPrincipal() p: Principal, @ZParam('programId') programId: string) {
    return this.learner.selfEnroll(p, programId);
  }

  @Get('me/programs/:programId/outline')
  @RequirePermissions('training.participate')
  @ZResponse(learning.outlineSchema)
  outline(@CurrentPrincipal() p: Principal, @ZParam('programId') programId: string) {
    return this.learner.outline(p, programId);
  }

  @Get('me/lessons/:lessonId')
  @RequirePermissions('training.participate')
  @ZResponse(learning.lessonDetailSchema)
  lesson(@CurrentPrincipal() p: Principal, @ZParam('lessonId') lessonId: string) {
    return this.learner.lessonDetail(p, lessonId);
  }

  @Post('me/lessons/:lessonId/start')
  @HttpCode(200)
  @RequirePermissions('training.participate')
  @ZResponse(learning.lessonProgressSchema)
  start(@CurrentPrincipal() p: Principal, @ZParam('lessonId') lessonId: string) {
    return this.learner.start(p, lessonId);
  }

  @Post('me/lessons/:lessonId/complete')
  @HttpCode(200)
  @RequirePermissions('training.participate')
  @ZResponse(learning.completeLessonResultSchema)
  complete(@CurrentPrincipal() p: Principal, @ZParam('lessonId') lessonId: string) {
    return this.learner.complete(p, lessonId);
  }

  @Post('me/lessons/:lessonId/acknowledge')
  @HttpCode(200)
  @RequirePermissions('training.participate')
  @ZResponse(learning.acknowledgmentSchema)
  acknowledge(
    @CurrentPrincipal() p: Principal,
    @ZParam('lessonId') lessonId: string,
    @ZBody(learning.acknowledgeRequestSchema) body: Out<typeof learning.acknowledgeRequestSchema>,
  ) {
    return this.learner.acknowledge(p, lessonId, body.typedName);
  }

  @Post('me/lessons/:lessonId/submission')
  @RequirePermissions('training.participate')
  @ZResponse(learning.submissionResultSchema)
  submit(
    @CurrentPrincipal() p: Principal,
    @ZParam('lessonId') lessonId: string,
    @ZBody(learning.submitAssignmentRequestSchema) body: Out<typeof learning.submitAssignmentRequestSchema>,
  ) {
    return this.learner.submitAssignment(p, lessonId, body.body);
  }

  @Post('me/lessons/:lessonId/approval-request')
  @HttpCode(200)
  @RequirePermissions('training.participate')
  @ZResponse(learning.learnerApprovalSchema)
  requestApproval(
    @CurrentPrincipal() p: Principal,
    @ZParam('lessonId') lessonId: string,
    @ZBody(learning.requestApprovalRequestSchema) body: Out<typeof learning.requestApprovalRequestSchema>,
  ) {
    return this.learner.requestApproval(p, lessonId, body.note);
  }

  @Get('me/lessons/:lessonId/notes')
  @RequirePermissions('training.participate')
  @ZResponse(learning.noteListSchema)
  async notes(@CurrentPrincipal() p: Principal, @ZParam('lessonId') lessonId: string) {
    return { items: await this.learner.notes(p, lessonId) };
  }

  @Post('me/lessons/:lessonId/notes')
  @RequirePermissions('training.participate')
  @ZResponse(learning.noteSchema)
  addNote(
    @CurrentPrincipal() p: Principal,
    @ZParam('lessonId') lessonId: string,
    @ZBody(learning.createNoteRequestSchema) body: Out<typeof learning.createNoteRequestSchema>,
  ) {
    return this.learner.addNote(p, lessonId, body);
  }

  @Patch('me/notes/:noteId')
  @RequirePermissions('training.participate')
  @ZResponse(learning.noteSchema)
  updateNote(
    @CurrentPrincipal() p: Principal,
    @ZParam('noteId') noteId: string,
    @ZBody(learning.updateNoteRequestSchema) body: Out<typeof learning.updateNoteRequestSchema>,
  ) {
    return this.learner.updateNote(p, noteId, body);
  }

  @Delete('me/notes/:noteId')
  @RequirePermissions('training.participate')
  @ZResponse(okSchema)
  async deleteNote(@CurrentPrincipal() p: Principal, @ZParam('noteId') noteId: string) {
    await this.learner.deleteNote(p, noteId);
    return { ok: true as const };
  }

  @Get('search')
  @RequireAnyPermission('programs.view', 'training.participate')
  @ZResponse(learning.searchResultSchema)
  search(@CurrentPrincipal() p: Principal, @ZQuery(learning.searchQuerySchema) q: Out<typeof learning.searchQuerySchema>) {
    return this.searcher.search(p, q.q, q.limit);
  }
}
