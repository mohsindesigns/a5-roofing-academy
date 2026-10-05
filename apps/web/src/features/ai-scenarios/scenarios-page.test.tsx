import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { PermissionKey } from '@a5/permissions';
import { json, meHandler, mockApi, renderRoute } from '@/test/render';
import { AiScenariosPage } from './scenarios-page';
import { IDS, persona, rubric, scenarioSummary } from './test-fixtures';

afterEach(() => vi.restoreAllMocks());

const page = <T,>(items: T[]) => ({
  items,
  page: 1,
  pageSize: 25,
  total: items.length,
  pageCount: 1,
});
const VIEW: PermissionKey[] = ['ai_scenarios.view'];
const ALL: PermissionKey[] = ['ai_scenarios.view', 'ai_scenarios.update', 'ai_scenarios.create'];

function setup(
  perms: PermissionKey[],
  extra: Parameters<typeof mockApi>[0] = {},
  route = '/content/ai-scenarios',
) {
  const api = mockApi({
    'GET /auth/me': meHandler(perms),
    'GET /ai/scenarios': () =>
      page([
        scenarioSummary({ status: 'published' }),
        scenarioSummary({
          id: '00000000-0000-4000-8000-000000000202',
          title: 'Spouse Needs To Decide',
          status: 'draft',
          difficulty: 'advanced',
          currentPromptVersion: null,
        }),
      ]),
    'GET /ai/personas': () =>
      page([
        persona(),
        persona({ id: '00000000-0000-4000-8000-000000000203', name: 'Skeptic', archived: true }),
      ]),
    'GET /ai/rubrics': () => page([{ ...rubric(), currentVersion: rubric().versions[0] }]),
    ...extra,
  });
  renderRoute(<AiScenariosPage />, { route, path: '/content/ai-scenarios' });
  return api;
}

describe('AI scenarios list', () => {
  it('lists scenarios with status, difficulty, pass mark, version and sessions', async () => {
    setup(ALL);
    const table = await screen.findByRole('table', { name: 'AI scenarios' });
    const rows = within(table).getAllByRole('row');
    expect(within(rows[1]!).getByRole('link', { name: 'Three Estimates' })).toHaveAttribute(
      'href',
      `/content/ai-scenarios/${IDS.scenario}`,
    );
    expect(within(rows[1]!).getByText('Published')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('Intermediate')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('v2')).toBeInTheDocument();
    expect(within(rows[2]!).getByText('Draft')).toBeInTheDocument();
    expect(within(rows[2]!).getByText('—')).toBeInTheDocument();
  });

  it('filters on the server', async () => {
    const user = userEvent.setup();
    const api = setup(ALL);
    await screen.findByRole('table', { name: 'AI scenarios' });
    await user.selectOptions(screen.getByLabelText('Status'), 'draft');
    await waitFor(() =>
      expect(api.callsTo('GET /ai/scenarios').some((c) => c.query.get('status') === 'draft')).toBe(
        true,
      ),
    );
  });

  it('shows New scenario only to people who can create', async () => {
    setup(ALL);
    expect(await screen.findAllByRole('link', { name: 'New scenario' })).not.toHaveLength(0);
  });

  it('hides creation controls from viewers', async () => {
    setup(VIEW);
    await screen.findByRole('table', { name: 'AI scenarios' });
    expect(screen.queryByRole('link', { name: 'New scenario' })).not.toBeInTheDocument();
  });

  it('requires ai_scenarios.view', async () => {
    setup(['ai_practice.use']);
    await screen.findByText("You don't have access to this page");
  });

  it('shows an error with a retry', async () => {
    const user = userEvent.setup();
    let fail = true;
    setup(VIEW, {
      'GET /ai/scenarios': () =>
        fail
          ? json(400, { error: { code: 'BAD', message: 'Scenarios are unavailable.' } })
          : page([scenarioSummary()]),
    });
    await screen.findByText('Scenarios are unavailable.');
    fail = false;
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    await screen.findByRole('table', { name: 'AI scenarios' });
  });
});

describe('personas', () => {
  it('lets editors edit and archive, and not archived personas', async () => {
    const user = userEvent.setup();
    setup(ALL, {}, '/content/ai-scenarios?tab=personas');
    const table = await screen.findByRole('table', { name: 'Personas' });
    const rows = within(table).getAllByRole('row');
    expect(
      within(rows[1]!).getByRole('button', { name: 'Edit Comparison shopper' }),
    ).toBeInTheDocument();
    expect(within(rows[2]!).getByText('Archived')).toBeInTheDocument();
    expect(within(rows[2]!).queryByRole('button', { name: /Edit/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'New persona' }));
    expect(await screen.findByRole('dialog', { name: 'New persona' })).toBeInTheDocument();
  });

  it('is read-only for viewers', async () => {
    setup(VIEW, {}, '/content/ai-scenarios?tab=personas');
    await screen.findByRole('table', { name: 'Personas' });
    expect(screen.queryByRole('button', { name: /Edit/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New persona' })).not.toBeInTheDocument();
  });

  it('validates a new persona and creates it', async () => {
    const user = userEvent.setup();
    const api = setup(
      ALL,
      { 'POST /ai/personas': () => persona({ name: 'Retired contractor' }) },
      '/content/ai-scenarios?tab=personas',
    );
    await user.click(await screen.findByRole('button', { name: 'New persona' }));
    const dialog = await screen.findByRole('dialog', { name: 'New persona' });
    await user.click(within(dialog).getByRole('button', { name: 'Create persona' }));
    expect((await within(dialog).findAllByText('Required')).length).toBeGreaterThanOrEqual(4);
    expect(api.callsTo('POST /ai/personas')).toHaveLength(0);

    await user.type(within(dialog).getByLabelText(/^Name/), 'Retired contractor');
    await user.type(
      within(dialog).getByLabelText(/^Description/),
      'Knows roofs better than the rep.',
    );
    await user.type(within(dialog).getByLabelText(/^Temperament/), 'Blunt');
    await user.type(within(dialog).getByLabelText(/^Speaking style/), 'Short, technical');
    await user.type(within(dialog).getByLabelText(/^Background/), 'Thirty years in the trade.');
    await user.type(within(dialog).getByLabelText(/^Traits/), 'Tests the rep\nRespects specifics');
    await user.click(within(dialog).getByRole('button', { name: 'Create persona' }));
    await waitFor(() => expect(api.callsTo('POST /ai/personas')).toHaveLength(1));
    expect(api.callsTo('POST /ai/personas')[0]!.body).toMatchObject({
      name: 'Retired contractor',
      traits: ['Tests the rep', 'Respects specifics'],
    });
  });
});

describe('rubrics', () => {
  it('lists rubrics with their version, criteria and the scenarios using them', async () => {
    setup(ALL, {}, '/content/ai-scenarios?tab=rubrics');
    const table = await screen.findByRole('table', { name: 'Rubrics' });
    const row = within(table).getAllByRole('row')[1]!;
    expect(within(row).getByRole('link', { name: 'A5 objection handling' })).toHaveAttribute(
      'href',
      `/content/ai-scenarios/rubrics/${IDS.rubric}`,
    );
    expect(within(row).getByText('3 scenarios')).toBeInTheDocument();
  });

  it('creates a rubric from the default criteria and opens it', async () => {
    const user = userEvent.setup();
    const api = setup(
      ALL,
      { 'POST /ai/rubrics': () => rubric() },
      '/content/ai-scenarios?tab=rubrics',
    );
    await user.click(await screen.findByRole('button', { name: 'New rubric' }));
    const dialog = await screen.findByRole('dialog', { name: 'New rubric' });
    await user.type(within(dialog).getByLabelText(/^Title/), 'Storm damage objections');
    await user.click(within(dialog).getByRole('button', { name: 'Create rubric' }));
    await screen.findByText(`Elsewhere: /content/ai-scenarios/rubrics/${IDS.rubric}`);
    expect(api.callsTo('POST /ai/rubrics')[0]!.body).toEqual({
      title: 'Storm damage objections',
      description: null,
      passingScore: 75,
    });
  });
});
