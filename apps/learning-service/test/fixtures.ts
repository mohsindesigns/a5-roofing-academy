import { expect } from 'vitest';
import type { Rule } from '@a5/rules';
import { PEOPLE, type PersonKey } from '@a5/seed-data';
import { uuidv7 } from '@a5/observability';
import type { LearningHarness } from './harness.js';

type Headers = Record<string, string>;

export interface LessonSpec {
  key: string;
  type: string;
  title?: string;
  config?: Record<string, unknown>;
  body?: string;
  isRequired?: boolean;
  estimatedMinutes?: number;
  unlockRule?: (ids: BuiltProgram) => Rule;
}

export interface PhaseSpec {
  key: string;
  title?: string;
  unlockRule?: (ids: BuiltProgram) => Rule;
  lessons: LessonSpec[];
}

export interface ProgramSpec {
  title: string;
  settings?: Record<string, unknown>;
  phases: PhaseSpec[];
}

export interface BuiltProgram {
  id: string;
  phases: Record<string, string>;
  modules: Record<string, string>;
  lessons: Record<string, string>;
}

/** Create a program through the builder API (one module per phase), then optionally publish it. */
export async function buildProgram(
  h: LearningHarness,
  admin: Headers,
  spec: ProgramSpec,
  publish = true,
): Promise<BuiltProgram> {
  const created = await h.http
    .post('/api/v1/programs')
    .set(admin)
    .send({ title: spec.title, settings: spec.settings ?? {} });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const built: BuiltProgram = { id: created.body.id, phases: {}, modules: {}, lessons: {} };

  for (const phase of spec.phases) {
    const res = await h.http
      .post(`/api/v1/programs/${built.id}/phases`)
      .set(admin)
      .send({ title: phase.title ?? phase.key });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    built.phases[phase.key] = res.body.phases.find(
      (p: { title: string }) => p.title === (phase.title ?? phase.key),
    ).id;
    const mod = await h.http
      .post(`/api/v1/programs/${built.id}/modules`)
      .set(admin)
      .send({ phaseId: built.phases[phase.key], title: `${phase.title ?? phase.key} module` });
    expect(mod.status, JSON.stringify(mod.body)).toBe(201);
    built.modules[phase.key] = mod.body.phases
      .flatMap((p: { modules: Array<{ id: string; phaseId: string }> }) => p.modules)
      .find((m: { phaseId: string }) => m.phaseId === built.phases[phase.key]).id;
    for (const lesson of phase.lessons) {
      const l = await h.http
        .post('/api/v1/lessons')
        .set(admin)
        .send({
          moduleId: built.modules[phase.key],
          type: lesson.type,
          title: lesson.title ?? lesson.key,
          config: lesson.config ?? {},
          body:
            lesson.body ??
            (lesson.type === 'article'
              ? `# ${lesson.title ?? lesson.key}\n\nBody text for ${lesson.key}.`
              : undefined),
          isRequired: lesson.isRequired ?? true,
          estimatedMinutes: lesson.estimatedMinutes ?? 5,
        });
      expect(l.status, JSON.stringify(l.body)).toBe(201);
      built.lessons[lesson.key] = l.body.id;
    }
  }
  // Rules refer to ids, so they are attached once everything exists.
  for (const phase of spec.phases) {
    if (phase.unlockRule) {
      const res = await h.http
        .patch(`/api/v1/programs/${built.id}/phases/${built.phases[phase.key]}`)
        .set(admin)
        .send({ unlockRule: phase.unlockRule(built) });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
    }
    for (const lesson of phase.lessons) {
      if (lesson.unlockRule) {
        const res = await h.http
          .patch(`/api/v1/lessons/${built.lessons[lesson.key]}`)
          .set(admin)
          .send({ unlockRule: lesson.unlockRule(built) });
        expect(res.status, JSON.stringify(res.body)).toBe(200);
      }
    }
  }
  if (publish) {
    const res = await h.http
      .post(`/api/v1/programs/${built.id}/publish`)
      .set(admin)
      .send({ changeNote: 'First publication for tests' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  }
  return built;
}

export async function enroll(
  h: LearningHarness,
  admin: Headers,
  programId: string,
  people: PersonKey[],
  dueAt?: string,
) {
  const res = await h.http
    .post('/api/v1/enrollments')
    .set(admin)
    .send({ programId, userIds: people.map((p) => PEOPLE[p].id), ...(dueAt && { dueAt }) });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body as {
    created: number;
    reactivated: number;
    unchanged: number;
    items: Array<{ userId: string; enrollmentId: string; outcome: string }>;
  };
}

export async function outline(h: LearningHarness, who: Headers, programId: string) {
  const res = await h.http.get(`/api/v1/learning/me/programs/${programId}/outline`).set(who);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body as {
    state: string;
    percent: number;
    nextLessonId: string | null;
    phases: Array<{
      id: string;
      state: string;
      percent: number;
      requirements: Array<{
        description: string;
        satisfied: boolean;
        progress: { current: number; target: number; unit: string } | null;
      }>;
      modules: Array<{
        lessons: Array<{ id: string; state: string; requirements: Array<{ description: string }> }>;
      }>;
    }>;
  };
}

/** Lesson states keyed by id, flattened from the outline. */
export function lessonStates(o: Awaited<ReturnType<typeof outline>>): Record<string, string> {
  return Object.fromEntries(
    o.phases.flatMap((p) => p.modules.flatMap((m) => m.lessons.map((l) => [l.id, l.state]))),
  );
}

export const randomId = () => uuidv7();
