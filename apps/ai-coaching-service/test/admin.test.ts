import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PEOPLE } from '@a5/seed-data';
import { createAiHarness, sendStreaming, startSession, type AiHarness } from './harness.js';

let h: AiHarness;

beforeAll(async () => {
  h = await createAiHarness('admin');
});
afterAll(() => h?.close());

const audit = async (action: string) =>
  (
    await h.db
      .selectFrom('outbox_events')
      .select('envelope')
      .where('type', '=', 'audit.recorded')
      .execute()
  ).filter((r) => (r.envelope as { payload: { action: string } }).payload.action === action);

describe('prompt versioning', () => {
  it('creates a new immutable prompt version on every prompt-relevant edit; old sessions keep their version', async () => {
    const admin = await h.as('grant');
    const copy = await h.http
      .post(`/api/v1/ai/scenarios/${h.scenarioId('have-roofer')}/duplicate`)
      .set(admin)
      .send({ title: 'Versioning drill' });
    expect(copy.status).toBe(201);
    const id = copy.body.id as string;
    expect(copy.body).toMatchObject({
      status: 'draft',
      title: 'Versioning drill',
      currentPromptVersion: { version: 1 },
    });
    await h.http.post(`/api/v1/ai/scenarios/${id}/publish`).set(admin).expect(200);

    // A learner starts a session under v1.
    const marcus = await h.as('marcus');
    const oldSession = (
      await h.http.post('/api/v1/ai/sessions').set(marcus).send({ scenarioId: id })
    ).body;
    expect(oldSession.promptVersion.version).toBe(1);
    await sendStreaming(h, marcus, oldSession.id, { text: 'Hi, I am Marcus with A5 Roofing.' });

    // The scenario is edited: v2 is created, v1 is untouched.
    const edited = await h.http.patch(`/api/v1/ai/scenarios/${id}`).set(admin).send({
      openingLine: "Hello. I've got a roofer already, thanks.",
      hiddenConcern:
        'Your brother-in-law Ray has been promising to come out for two months. You feel loyal to him.',
    });
    expect(edited.status).toBe(200);
    expect(edited.body.currentPromptVersion.version).toBe(2);
    expect(edited.body.openingLine).toBe("Hello. I've got a roofer already, thanks.");

    const versions = await h.http.get(`/api/v1/ai/scenarios/${id}/prompt-versions`).set(admin);
    expect(
      versions.body.items.map((v: { version: number; current: boolean; sessionCount: number }) => [
        v.version,
        v.current,
        v.sessionCount,
      ]),
    ).toEqual([
      [2, true, 0],
      [1, false, 1],
    ]);
    const [v2, v1] = versions.body.items;
    expect(v1.id).toBe(oldSession.promptVersion.id);

    // The old session still points at the old version, and so does its transcript view.
    const reloaded = (await h.http.get(`/api/v1/ai/sessions/${oldSession.id}`).set(marcus)).body;
    expect(reloaded.promptVersion).toEqual({ id: v1.id, version: 1 });
    expect(reloaded.messages[0].content).toBe(
      "That's nice, but I already have a roofer. He's family, so I'm all set.",
    );

    // A new session runs under v2.
    const newSession = (
      await h.http
        .post('/api/v1/ai/sessions')
        .set(await h.as('tyler'))
        .send({ scenarioId: id })
    ).body;
    expect(newSession.promptVersion).toEqual({ id: v2.id, version: 2 });
    expect(newSession.messages[0].content).toBe("Hello. I've got a roofer already, thanks.");

    // Version detail exposes the compiled prompts; the diff lists exactly what changed.
    const detail = await h.http
      .get(`/api/v1/ai/scenarios/${id}/prompt-versions/${v2.id}`)
      .set(admin);
    expect(detail.body.homeownerSystemPrompt).toContain('You are playing a homeowner');
    expect(detail.body.homeownerSystemPrompt).toContain('Ray');
    expect(detail.body.evaluatorSystemPrompt).toContain('# Rubric');
    expect(detail.body.personaSnapshot.name).toBe('Skeptical homeowner');
    const diff = await h.http
      .get(`/api/v1/ai/scenarios/${id}/prompt-versions/diff?from=${v1.id}&to=${v2.id}`)
      .set(admin);
    expect(diff.status).toBe(200);
    expect(diff.body.changes.map((c: { field: string }) => c.field).sort()).toEqual([
      'evaluatorSystemPrompt',
      'homeownerSystemPrompt',
      'scenario.hiddenConcern',
      'scenario.openingLine',
    ]);
    expect(
      diff.body.changes.find((c: { field: string }) => c.field === 'scenario.openingLine'),
    ).toMatchObject({
      before: "That's nice, but I already have a roofer. He's family, so I'm all set.",
      after: "Hello. I've got a roofer already, thanks.",
    });

    // An edit that changes nothing creates no version.
    await h.http
      .patch(`/api/v1/ai/scenarios/${id}`)
      .set(admin)
      .send({ openingLine: "Hello. I've got a roofer already, thanks." })
      .expect(200);
    expect(
      (await h.http.get(`/api/v1/ai/scenarios/${id}/prompt-versions`).set(admin)).body.items,
    ).toHaveLength(2);
    expect((await h.http.patch(`/api/v1/ai/scenarios/${id}`).set(admin).send({})).status).toBe(400);
    expect((await audit('ai.scenario.updated')).length).toBeGreaterThanOrEqual(2);
  });

  it('versions are immutable in the database', async () => {
    const version = await h.db
      .selectFrom('ai_prompt_versions')
      .select('id')
      .limit(1)
      .executeTakeFirstOrThrow();
    await expect(
      h.db
        .updateTable('ai_prompt_versions')
        .set({ change_note: 'tampered' })
        .where('id', '=', version.id)
        .execute(),
    ).rejects.toThrow(/immutable/);
    await expect(
      h.db.deleteFrom('ai_prompt_versions').where('id', '=', version.id).execute(),
    ).rejects.toThrow(/immutable/);
    const message = await h.db
      .selectFrom('ai_messages')
      .select('id')
      .limit(1)
      .executeTakeFirstOrThrow();
    await expect(
      h.db
        .updateTable('ai_messages')
        .set({ content: 'tampered' })
        .where('id', '=', message.id)
        .execute(),
    ).rejects.toThrow(/immutable/);
    const evaluation = await h.db
      .selectFrom('ai_evaluations')
      .select('id')
      .limit(1)
      .executeTakeFirstOrThrow();
    await expect(
      h.db.deleteFrom('ai_evaluations').where('id', '=', evaluation.id).execute(),
    ).rejects.toThrow(/immutable/);
    const rubricVersion = await h.db
      .selectFrom('ai_rubric_versions')
      .select('id')
      .limit(1)
      .executeTakeFirstOrThrow();
    await expect(
      h.db
        .updateTable('ai_rubric_versions')
        .set({ passing_score: 1 })
        .where('id', '=', rubricVersion.id)
        .execute(),
    ).rejects.toThrow(/immutable/);
  });

  it('editing a persona or publishing a rubric version versions every live scenario that uses it', async () => {
    const admin = await h.as('grant');
    const persona = (await h.http.get('/api/v1/ai/personas?q=Friendly').set(admin)).body.items[0];
    expect(persona).toMatchObject({ name: 'Friendly homeowner', archived: false });
    expect(persona.scenarioCount).toBeGreaterThanOrEqual(2);
    const before = await h.db.selectFrom('ai_prompt_versions').select('id').execute();
    const updated = await h.http
      .patch(`/api/v1/ai/personas/${persona.id}`)
      .set(admin)
      .send({ speakingStyle: 'Warm, with the occasional "honey". Slow to say no.' });
    expect(updated.status).toBe(200);
    const after = await h.db.selectFrom('ai_prompt_versions').select('id').execute();
    expect(after.length - before.length).toBe(persona.scenarioCount);

    const rubrics = (await h.http.get('/api/v1/ai/rubrics').set(admin)).body;
    const rubric = rubrics.items[0];
    const detail = (await h.http.get(`/api/v1/ai/rubrics/${rubric.id}`).set(admin)).body;
    expect(detail.currentVersion.categories).toHaveLength(14);
    expect(
      detail.currentVersion.categories.reduce(
        (s: number, c: { weight: number }) => s + c.weight,
        0,
      ),
    ).toBe(100);
    const categories = detail.currentVersion.categories.map((c: { key: string; weight: number }) =>
      c.key === 'compliance' ? { ...c, weight: 12 } : c,
    );
    const published = await h.http
      .post(`/api/v1/ai/rubrics/${rubric.id}/versions`)
      .set(admin)
      .send({ categories, passingScore: 78, changeNote: 'Weigh compliance higher' });
    expect(published.status).toBe(201);
    expect(published.body.currentVersion).toMatchObject({
      version: 2,
      passingScore: 78,
      changeNote: 'Weigh compliance higher',
    });
    expect(published.body.versions.map((v: { version: number }) => v.version)).toEqual([2, 1]);

    const scenario = (
      await h.http.get(`/api/v1/ai/scenarios/${h.scenarioId('no-time')}`).set(admin)
    ).body;
    expect(scenario.rubric.currentVersion).toBe(2);
    expect(scenario.currentPromptVersion.version).toBe(2); // its persona was not edited, only the rubric changed
    // Sessions that ran under v1 keep scoring against rubric version 1.
    const v1 = (
      await h.http
        .get(`/api/v1/ai/rubrics/${rubric.id}/versions/${detail.currentVersion.id}`)
        .set(admin)
    ).body;
    expect(v1.version).toBe(1);
    expect(v1.categories.find((c: { key: string }) => c.key === 'compliance').weight).toBe(8);

    expect(
      (
        await h.http
          .post(`/api/v1/ai/rubrics/${rubric.id}/versions`)
          .set(admin)
          .send({ categories: [], passingScore: 70 })
      ).status,
    ).toBe(400);
    expect(
      (
        await h.http
          .post(`/api/v1/ai/rubrics/${rubric.id}/versions`)
          .set(admin)
          .send({ categories: [categories[0], categories[0]], passingScore: 70 })
      ).status,
    ).toBe(400);
  });
});

describe('scenario administration', () => {
  it('creates, validates, publishes and archives scenarios', async () => {
    const admin = await h.as('shelby');
    const persona = (await h.http.get('/api/v1/ai/personas').set(admin)).body.items[0];
    const rubric = (await h.http.get('/api/v1/ai/rubrics').set(admin)).body.items[0];
    const body = {
      title: 'Neighbor Told Me It Was a Scam',
      category: 'Trust',
      difficulty: 'intermediate',
      personaId: persona.id,
      objection: 'My neighbor said roofers who knock on doors are scammers.',
      repBrief:
        'A Mesquite homeowner has heard warnings about door-knockers. Earn trust with specifics.',
      background: 'You live in Mesquite and your neighbor lost money to a storm chaser.',
      propertyContext: 'A 2010 house with 3-tab shingles hit by the April 14 hailstorm.',
      trigger: 'A5 Roofing is canvassing after the April storm.',
      hiddenConcern:
        'Your neighbor paid a deposit to a storm chaser from out of state and lost it. You are afraid of repeating that mistake.',
      expectedBehaviors: ["Acknowledges the neighbor's experience"],
      requiredTalkingPoints: ['A5 is local, licensed and insured'],
      forbiddenClaims: ['Calling the neighbor foolish'],
      openingLine: 'My neighbor says people who knock on doors are scammers.',
      passingScore: 75,
      rubricId: rubric.id,
      maxTurns: 10,
    };
    const created = await h.http.post('/api/v1/ai/scenarios').set(admin).send(body);
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      status: 'draft',
      provider: null,
      model: null,
      currentPromptVersion: { version: 1 },
    });

    const dup = await h.http.post('/api/v1/ai/scenarios').set(admin).send(body);
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('SCENARIO_TITLE_TAKEN');
    const invalid = await h.http
      .post('/api/v1/ai/scenarios')
      .set(admin)
      .send({
        ...body,
        title: 'Other',
        difficulty: 'impossible',
        passingScore: 101,
        personaId: 'x',
      });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error.fields.map((f: { path: string }) => f.path).sort()).toEqual([
      'difficulty',
      'passingScore',
      'personaId',
    ]);
    const missingRefs = await h.http
      .post('/api/v1/ai/scenarios')
      .set(admin)
      .send({ ...body, title: 'Other', personaId: '0190a3b2-0000-7000-8000-000000000999' });
    expect(missingRefs.status).toBe(400);
    expect(missingRefs.body.error.fields[0].path).toBe('personaId');

    // Drafts are invisible to learners until published.
    const marcus = await h.as('marcus');
    const hiddenFromLearners = await h.http
      .get(`/api/v1/ai/practice/scenarios/${created.body.id}`)
      .set(marcus);
    expect(hiddenFromLearners.status).toBe(404);
    expect(
      (await h.http.post('/api/v1/ai/sessions').set(marcus).send({ scenarioId: created.body.id }))
        .status,
    ).toBe(404);
    await h.http.post(`/api/v1/ai/scenarios/${created.body.id}/publish`).set(admin).expect(200);
    expect(
      (await h.http.get(`/api/v1/ai/practice/scenarios/${created.body.id}`).set(marcus)).status,
    ).toBe(200);

    // Archived scenarios leave the catalogue but keep their history.
    const archived = await h.http
      .post(`/api/v1/ai/scenarios/${created.body.id}/archive`)
      .set(admin);
    expect(archived.body.status).toBe('archived');
    expect(
      (await h.http.get(`/api/v1/ai/practice/scenarios/${created.body.id}`).set(marcus)).status,
    ).toBe(404);
    expect(
      (
        await h.http
          .patch(`/api/v1/ai/scenarios/${created.body.id}`)
          .set(admin)
          .send({ maxTurns: 5 })
      ).status,
    ).toBe(409);
    const listed = await h.http.get('/api/v1/ai/scenarios?pageSize=50').set(admin);
    expect(listed.body.items.map((s: { id: string }) => s.id)).not.toContain(created.body.id);
    const withArchived = await h.http.get('/api/v1/ai/scenarios?status=archived').set(admin);
    expect(withArchived.body.items.map((s: { id: string }) => s.id)).toContain(created.body.id);
    expect((await audit('ai.scenario.created')).length).toBeGreaterThanOrEqual(1);
    expect((await audit('ai.scenario.published')).length).toBeGreaterThanOrEqual(1);
  });

  it('protects administration with permissions', async () => {
    const marcus = await h.as('marcus');
    expect((await h.http.get('/api/v1/ai/scenarios').set(marcus)).status).toBe(403);
    expect((await h.http.get('/api/v1/ai/personas').set(marcus)).status).toBe(403);
    expect((await h.http.get('/api/v1/ai/rubrics').set(marcus)).status).toBe(403);
    expect((await h.http.get('/api/v1/ai/settings').set(marcus)).status).toBe(403);
    expect(
      (
        await h.http
          .post(`/api/v1/ai/scenarios/${h.scenarioId('no-time')}/test-sessions`)
          .set(marcus)
      ).status,
    ).toBe(403);
    // Trainers can read scenarios but not change them.
    const hector = await h.as('hector');
    expect((await h.http.get('/api/v1/ai/scenarios').set(hector)).status).toBe(200);
    expect(
      (
        await h.http
          .patch(`/api/v1/ai/scenarios/${h.scenarioId('no-time')}`)
          .set(hector)
          .send({ maxTurns: 5 })
      ).status,
    ).toBe(403);
    expect((await h.http.post('/api/v1/ai/scenarios').set(hector).send({})).status).toBe(403);
    // Auditors can read, nothing more.
    const ruth = await h.as('ruth');
    expect((await h.http.get('/api/v1/ai/scenarios').set(ruth)).status).toBe(200);
    expect(
      (
        await h.http
          .post(`/api/v1/ai/scenarios/${h.scenarioId('no-time')}/duplicate`)
          .set(ruth)
          .send({})
      ).status,
    ).toBe(403);
  });

  it('test runs are flagged, usable on drafts and excluded from learner views', async () => {
    const admin = await h.as('grant');
    const draft = await h.http
      .post(`/api/v1/ai/scenarios/${h.scenarioId('cheaper')}/duplicate`)
      .set(admin)
      .send({ title: 'Draft for testing' });
    const run = await h.http.post(`/api/v1/ai/scenarios/${draft.body.id}/test-sessions`).set(admin);
    expect(run.status).toBe(201);
    expect(run.body).toMatchObject({ isTest: true, mode: 'practice', status: 'active' });
    const reply = await sendStreaming(h, admin, run.body.id, {
      text: 'Hi, I am a tester from A5 Roofing.',
    });
    expect(reply.events.at(-1)!.event).toBe('done');
    const usage = await h.db
      .selectFrom('ai_usage')
      .select('is_test')
      .where('session_id', '=', run.body.id)
      .execute();
    expect(usage.length).toBeGreaterThan(0);
    expect(usage.every((u) => u.is_test)).toBe(true);
    const grantToken = await h.grant('marcus', 'cheaper');
    const withGrant = await h.http
      .post(`/api/v1/ai/scenarios/${draft.body.id}/test-sessions`)
      .set(admin)
      .send({ lessonGrant: grantToken });
    expect(withGrant.status).toBe(201); // body is ignored: test runs never attach to lessons
    expect(withGrant.body.context).toEqual({});
    // Someone else cannot read an admin's test session.
    expect(
      (await h.http.get(`/api/v1/ai/sessions/${run.body.id}`).set(await h.as('marcus'))).status,
    ).toBe(404);
  });
});

describe('settings', () => {
  it('shows provider availability and the effective provider, and validates updates', async () => {
    const admin = await h.as('grant');
    const settings = await h.http.get('/api/v1/ai/settings').set(admin);
    expect(settings.status).toBe(200);
    expect(settings.body.providers).toEqual([
      expect.objectContaining({
        name: 'anthropic',
        available: false,
        defaultConversationModel: 'claude-opus-5-5',
      }),
      expect.objectContaining({ name: 'openai', available: false }),
      expect.objectContaining({
        name: 'dev_simulator',
        label: 'Development simulator',
        available: true,
        simulated: true,
      }),
    ]);
    expect(settings.body.effective.conversation).toEqual({
      name: 'dev_simulator',
      label: 'Development simulator',
      model: 'a5-dev-simulator-v1',
      simulated: true,
    });

    const updated = await h.http.put('/api/v1/ai/settings').set(admin).send({
      transcriptRetentionDays: 365,
      timezone: 'America/New_York',
      conversationModel: 'claude-sonnet-5-5',
    });
    expect(updated.status).toBe(200);
    expect(updated.body).toMatchObject({
      transcriptRetentionDays: 365,
      timezone: 'America/New_York',
      conversationModel: 'claude-sonnet-5-5',
      updatedBy: { id: PEOPLE.grant.id },
    });
    for (const bad of [
      {},
      { timezone: 'Mars/Olympus' },
      { maxSessionsPerLearnerPerDay: 0 },
      { transcriptRetentionDays: 3 },
      { defaultProvider: 'bard' },
      { conversationModel: 'bad model!' },
    ]) {
      expect(
        (await h.http.put('/api/v1/ai/settings').set(admin).send(bad)).status,
        JSON.stringify(bad),
      ).toBe(400);
    }
    await h.http
      .put('/api/v1/ai/settings')
      .set(admin)
      .send({ transcriptRetentionDays: null, timezone: 'America/Chicago', conversationModel: null })
      .expect(200);
    expect((await audit('ai.settings.updated')).length).toBe(2);
    // A preferred provider that is not configured falls back to what is available.
    await h.http
      .put('/api/v1/ai/settings')
      .set(admin)
      .send({ defaultProvider: 'anthropic' })
      .expect(200);
    const session = await startSession(h, await h.as('destiny'), 'leave-card');
    expect(session.body.provider.name).toBe('dev_simulator');
    await h.http
      .put('/api/v1/ai/settings')
      .set(admin)
      .send({ defaultProvider: 'auto' })
      .expect(200);
  });
});
