import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { PermissionKey } from '@a5/permissions';
import { json, meHandler, mockApi, renderRoute } from '@/test/render';
import { session } from '@/features/ai-coach/test-fixtures';
import { ScenarioCreatePage, ScenarioDetailPage } from './scenario-detail-page';
import { IDS, persona, promptVersions, rubric, scenario } from './test-fixtures';

afterEach(() => vi.restoreAllMocks());

const page = <T,>(items: T[]) => ({
  items,
  page: 1,
  pageSize: 100,
  total: items.length,
  pageCount: 1,
});
const VIEW: PermissionKey[] = ['ai_scenarios.view'];
const EDIT: PermissionKey[] = ['ai_scenarios.view', 'ai_scenarios.update'];
const ALL: PermissionKey[] = ['ai_scenarios.view', 'ai_scenarios.update', 'ai_scenarios.create'];

function setup(
  perms: PermissionKey[],
  current = scenario(),
  extra: Parameters<typeof mockApi>[0] = {},
  route = `/content/ai-scenarios/${IDS.scenario}`,
) {
  const api = mockApi({
    'GET /auth/me': meHandler(perms),
    [`GET /ai/scenarios/${IDS.scenario}`]: () => current,
    'GET /ai/personas': () => page([persona()]),
    'GET /ai/rubrics': () => page([]),
    [`GET /ai/scenarios/${IDS.scenario}/prompt-versions`]: () => promptVersions(),
    ...extra,
  });
  renderRoute(<ScenarioDetailPage />, { route, path: '/content/ai-scenarios/:id' });
  return api;
}

describe('scenario detail', () => {
  it('shows the scenario, its status and where it stands', async () => {
    setup(EDIT);
    expect(await screen.findByRole('heading', { name: 'Three Estimates' })).toBeInTheDocument();
    expect(screen.getByText('Draft', { selector: 'p' })).toBeInTheDocument();
    expect(screen.getByText('Version 2')).toBeInTheDocument();
    expect(screen.getByText(/Learners cannot see this scenario yet/)).toBeInTheDocument();
  });

  it('publishes a draft after confirmation', async () => {
    const user = userEvent.setup();
    const api = setup(EDIT, scenario(), {
      [`POST /ai/scenarios/${IDS.scenario}/publish`]: () =>
        scenario({ status: 'published', publishedAt: '2026-10-05T16:00:00.000Z' }),
    });
    await user.click(await screen.findByRole('button', { name: 'Publish' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('Learners will see it in the AI Coach straight away');
    await user.click(within(dialog).getByRole('button', { name: 'Publish' }));
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Publish' })).not.toBeInTheDocument(),
    );
    expect(screen.getByText('Published')).toBeInTheDocument();
    expect(screen.queryByText(/Learners cannot see this scenario yet/)).not.toBeInTheDocument();
    expect(api.callsTo(`POST /ai/scenarios/${IDS.scenario}/publish`)).toHaveLength(1);
  });

  it('does not offer to publish a scenario that is already live', async () => {
    setup(EDIT, scenario({ status: 'published' }));
    await screen.findByRole('heading', { name: 'Three Estimates' });
    expect(screen.queryByRole('button', { name: 'Publish' })).not.toBeInTheDocument();
    expect(screen.getByText(/This scenario is live/)).toBeInTheDocument();
  });

  describe('permissions', () => {
    it('is read-only without ai_scenarios.update', async () => {
      setup(VIEW);
      await screen.findByRole('heading', { name: 'Three Estimates' });
      expect(screen.getByLabelText(/^Title/)).toBeDisabled();
      expect(screen.queryByRole('button', { name: 'Publish' })).not.toBeInTheDocument();
      expect(screen.queryByRole('tab', { name: 'Test run' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'More actions' })).not.toBeInTheDocument();
    });

    it('offers duplicate only with ai_scenarios.create', async () => {
      const user = userEvent.setup();
      setup(ALL);
      await user.click(await screen.findByRole('button', { name: 'More actions' }));
      expect(await screen.findByRole('menuitem', { name: 'Duplicate' })).toBeInTheDocument();
    });

    it('shows no access without ai_scenarios.view', async () => {
      setup(['ai_practice.use']);
      await screen.findByText("You don't have access to this page");
    });

    it('treats an archived scenario as read-only even for editors', async () => {
      setup(EDIT, scenario({ status: 'archived', archivedAt: '2026-10-04T00:00:00.000Z' }));
      await screen.findByRole('heading', { name: 'Three Estimates' });
      expect(screen.getByLabelText(/^Title/)).toBeDisabled();
      expect(screen.getByText(/can no longer be edited/)).toBeInTheDocument();
    });
  });

  describe('editing', () => {
    it('saves only the fields that changed, with a note', async () => {
      const user = userEvent.setup();
      const api = setup(EDIT, scenario(), {
        [`PATCH /ai/scenarios/${IDS.scenario}`]: () => scenario({ passingScore: 80 }),
      });
      const passMark = await screen.findByLabelText(/^Pass mark/);
      await user.clear(passMark);
      await user.type(passMark, '80');
      await user.type(screen.getByLabelText(/Note for this change/), 'Raised the bar');

      const bar = await screen.findByRole('region', { name: 'Unsaved changes' });
      expect(bar).toHaveTextContent('Unsaved changes in 1 field');
      await user.click(within(bar).getByRole('button', { name: 'Save changes' }));

      await waitFor(() =>
        expect(api.callsTo(`PATCH /ai/scenarios/${IDS.scenario}`)).toHaveLength(1),
      );
      expect(api.callsTo(`PATCH /ai/scenarios/${IDS.scenario}`)[0]!.body).toEqual({
        passingScore: 80,
        changeNote: 'Raised the bar',
      });
      await waitFor(() =>
        expect(screen.queryByRole('region', { name: 'Unsaved changes' })).not.toBeInTheDocument(),
      );
    });

    it('discards edits', async () => {
      const user = userEvent.setup();
      setup(EDIT);
      const passMark = await screen.findByLabelText(/^Pass mark/);
      await user.clear(passMark);
      await user.type(passMark, '90');
      await user.click(await screen.findByRole('button', { name: 'Discard' }));
      expect(screen.getByLabelText(/^Pass mark/)).toHaveValue(75);
    });

    it('validates before sending and marks the field', async () => {
      const user = userEvent.setup();
      const api = setup(EDIT);
      const title = await screen.findByLabelText(/^Title/);
      await user.clear(title);
      await user.click(await screen.findByRole('button', { name: 'Save changes' }));
      expect(await screen.findByText('Required')).toBeInTheDocument();
      expect(title).toHaveAttribute('aria-invalid', 'true');
      expect(
        screen.getByText('Some fields need attention. They are marked below.'),
      ).toBeInTheDocument();
      expect(api.callsTo(`PATCH /ai/scenarios/${IDS.scenario}`)).toHaveLength(0);
    });

    it('puts a duplicate title message on the title field', async () => {
      const user = userEvent.setup();
      setup(EDIT, scenario(), {
        [`PATCH /ai/scenarios/${IDS.scenario}`]: () =>
          json(409, {
            error: {
              code: 'SCENARIO_TITLE_TAKEN',
              message: 'A scenario titled "Price" already exists. Choose another title.',
            },
          }),
      });
      const title = await screen.findByLabelText(/^Title/);
      await user.clear(title);
      await user.type(title, 'Price');
      await user.click(await screen.findByRole('button', { name: 'Save changes' }));
      await screen.findByText(/already exists\. Choose another title/);
      expect(title).toHaveAttribute('aria-invalid', 'true');
    });
  });

  describe('prompt versions', () => {
    it('lists versions with the current one marked', async () => {
      const user = userEvent.setup();
      setup(EDIT);
      await user.click(await screen.findByRole('tab', { name: /Prompt versions/ }));
      const history = await screen.findByRole('heading', { name: 'History' });
      const list = history.parentElement!.querySelector('ul')!;
      const rows = within(list).getAllByRole('listitem');
      expect(rows).toHaveLength(2);
      expect(within(rows[0]!).getByText('Current')).toBeInTheDocument();
      expect(within(rows[0]!).getByText('Edited opening line')).toBeInTheDocument();
      expect(within(rows[1]!).queryByText('Current')).not.toBeInTheDocument();
    });

    it('compares two versions line by line', async () => {
      const user = userEvent.setup();
      const api = setup(EDIT, scenario(), {
        [`GET /ai/scenarios/${IDS.scenario}/prompt-versions/diff`]: () => ({
          from: promptVersions().items[1],
          to: promptVersions().items[0],
          changes: [
            {
              field: 'scenario.openingLine',
              before: 'I have two quotes.',
              after: 'I already have two other quotes.',
            },
            {
              field: 'homeownerSystemPrompt',
              before: 'You are a homeowner.\nStay in character.',
              after: 'You are a homeowner.\nStay in character.\nNever coach the rep.',
            },
          ],
        }),
      });
      await user.click(await screen.findByRole('tab', { name: /Prompt versions/ }));
      await screen.findByRole('heading', { name: 'Compare versions' });

      const call = await waitFor(() => {
        const c = api.callsTo(`GET /ai/scenarios/${IDS.scenario}/prompt-versions/diff`)[0];
        expect(c).toBeDefined();
        return c!;
      });
      // Defaults to the previous version against the current one.
      expect(call.query.get('from')).toBe(IDS.promptV1);
      expect(call.query.get('to')).toBe(IDS.promptV2);

      const opening = await screen.findByRole('region', { name: 'Scenario: Opening line' });
      expect(within(opening).getByText(/Removed:/).parentElement).toHaveTextContent(
        'I have two quotes.',
      );
      expect(within(opening).getByText(/Added:/).parentElement).toHaveTextContent(
        'I already have two other quotes.',
      );
      const prompt = screen.getByRole('region', {
        name: 'Prompt and model: Homeowner system prompt',
      });
      expect(within(prompt).getByText(/Added:/).parentElement).toHaveTextContent(
        'Never coach the rep.',
      );
      expect(screen.getByText(/2 fields changed/)).toBeInTheDocument();
    });

    it('opens a version to read the prompts', async () => {
      const user = userEvent.setup();
      setup(EDIT, scenario(), {
        [`GET /ai/scenarios/${IDS.scenario}/prompt-versions/${IDS.promptV1}`]: () => ({
          ...promptVersions().items[1],
          scenarioId: IDS.scenario,
          homeownerSystemPrompt: 'You are a homeowner in Plano.',
          evaluatorSystemPrompt: 'Score the rep against the rubric.',
          personaSnapshot: {},
          scenarioSnapshot: {},
          modelSettings: {},
        }),
        [`GET /ai/scenarios/${IDS.scenario}/prompt-versions/diff`]: () => ({
          from: promptVersions().items[1],
          to: promptVersions().items[0],
          changes: [],
        }),
      });
      await user.click(await screen.findByRole('tab', { name: /Prompt versions/ }));
      await user.click(await screen.findByRole('button', { name: /View version 1/ }));
      const sheet = await screen.findByRole('dialog', { name: 'Version 1' });
      expect(await within(sheet).findByText('You are a homeowner in Plano.')).toBeInTheDocument();
      expect(within(sheet).getByText('Score the rep against the rubric.')).toBeInTheDocument();
      expect(
        within(sheet).getByText(/Versions never change after they are saved/),
      ).toBeInTheDocument();
    });
  });

  describe('test run', () => {
    it('starts a test session through the real API and opens it', async () => {
      const user = userEvent.setup();
      const started = session({ isTest: true });
      const api = setup(EDIT, scenario(), {
        [`POST /ai/scenarios/${IDS.scenario}/test-sessions`]: () => started,
      });
      await user.click(await screen.findByRole('tab', { name: 'Test run' }));
      expect(
        screen.getByText(/left out of learner history, analytics and lesson progress/),
      ).toBeInTheDocument();
      expect(
        screen.getByText(/development simulator answers with scripted replies/),
      ).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'Start test run' }));
      await screen.findByText(`Elsewhere: /ai-coach/sessions/${started.id}`);
      expect(api.callsTo(`POST /ai/scenarios/${IDS.scenario}/test-sessions`)).toHaveLength(1);
    });

    it('cannot run an archived scenario', async () => {
      const user = userEvent.setup();
      setup(EDIT, scenario({ status: 'archived' }));
      await user.click(await screen.findByRole('tab', { name: 'Test run' }));
      expect(screen.getByRole('button', { name: 'Start test run' })).toBeDisabled();
    });

    it('names the provider the scenario is pinned to', async () => {
      const user = userEvent.setup();
      setup(EDIT, scenario({ provider: 'dev_simulator' }));
      await user.click(await screen.findByRole('tab', { name: 'Test run' }));
      expect(screen.getByText(/uses the development simulator/)).toBeInTheDocument();
    });
  });
});

describe('new scenario', () => {
  it('requires ai_scenarios.create', async () => {
    mockApi({ 'GET /auth/me': meHandler(VIEW) });
    renderRoute(<ScenarioCreatePage />, {
      route: '/content/ai-scenarios/new',
      path: '/content/ai-scenarios/new',
    });
    await screen.findByText("You don't have access to this page");
  });

  it('lists every problem at once and creates nothing until the form is valid', async () => {
    const user = userEvent.setup();
    const api = mockApi({
      'GET /auth/me': meHandler(ALL),
      'GET /ai/personas': () => page([persona()]),
      'GET /ai/rubrics': () => page([]),
    });
    renderRoute(<ScenarioCreatePage />, {
      route: '/content/ai-scenarios/new',
      path: '/content/ai-scenarios/new',
    });
    await user.click(await screen.findByRole('button', { name: 'Create scenario' }));
    expect(
      await screen.findByText('Some fields need attention. They are marked below.'),
    ).toBeInTheDocument();
    expect(screen.getAllByText('Required').length).toBeGreaterThan(5);
    expect(api.callsTo('POST /ai/scenarios')).toHaveLength(0);
  });

  it('creates a draft and opens it', async () => {
    const user = userEvent.setup();
    const created = scenario({ id: '00000000-0000-4000-8000-000000000999' });
    const api = mockApi({
      'GET /auth/me': meHandler(ALL),
      'GET /ai/personas': () => page([persona()]),
      'GET /ai/rubrics': () => page([{ ...rubric(), currentVersion: rubric().versions[0] }]),
      'POST /ai/scenarios': () => created,
    });
    renderRoute(<ScenarioCreatePage />, {
      route: '/content/ai-scenarios/new',
      path: '/content/ai-scenarios/new',
    });
    const fill = async (label: RegExp, value: string) =>
      user.type(await screen.findByLabelText(label), value);
    await fill(/^Title/, 'Three Estimates');
    await fill(/^Category/, 'Comparison');
    await fill(/^Objection/, 'I already have two other quotes.');
    await fill(/^Brief for the learner/, 'Early evening in Plano.');
    await fill(/^Background/, 'You are comparing roofers.');
    await fill(/^Property context/, 'A 2012 build.');
    await fill(/^What triggered the visit/, 'The representative knocked.');
    await fill(/^Hidden concern/, 'Burned by a roofer who disappeared.');
    await fill(/^Opening line/, 'I already have two other quotes.');
    await fill(/^Expected behaviors/, 'Asks what matters most\nOffers a written scope');
    await waitFor(() =>
      expect(screen.getByRole('option', { name: 'Comparison shopper' })).toBeInTheDocument(),
    );
    await user.selectOptions(screen.getByLabelText(/^Persona/), IDS.persona);
    await waitFor(() =>
      expect(screen.getByRole('option', { name: 'A5 objection handling' })).toBeInTheDocument(),
    );
    await user.selectOptions(screen.getByLabelText(/^Rubric/), IDS.rubric);

    await user.click(screen.getByRole('button', { name: 'Create scenario' }));
    await screen.findByText(`Elsewhere: /content/ai-scenarios/${created.id}`);
    expect(api.callsTo('POST /ai/scenarios')[0]!.body).toMatchObject({
      title: 'Three Estimates',
      personaId: IDS.persona,
      rubricId: IDS.rubric,
      difficulty: 'intermediate',
      passingScore: 75,
      maxTurns: 10,
      expectedBehaviors: ['Asks what matters most', 'Offers a written scope'],
      provider: null,
      modelSettings: {},
    });
  });
});
