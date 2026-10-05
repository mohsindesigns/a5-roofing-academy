import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { PermissionKey } from '@a5/permissions';
import { json, meHandler, mockApi, renderRoute } from '@/test/render';
import { RubricPage } from './rubric-page';
import { IDS, rubric } from './test-fixtures';

afterEach(() => vi.restoreAllMocks());

const EDIT: PermissionKey[] = ['ai_scenarios.view', 'ai_scenarios.update'];

function setup(
  perms: PermissionKey[],
  current = rubric(),
  extra: Parameters<typeof mockApi>[0] = {},
) {
  const api = mockApi({
    'GET /auth/me': meHandler(perms),
    [`GET /ai/rubrics/${IDS.rubric}`]: () => current,
    ...extra,
  });
  renderRoute(<RubricPage />, {
    route: `/content/ai-scenarios/rubrics/${IDS.rubric}`,
    path: '/content/ai-scenarios/rubrics/:id',
  });
  return api;
}

const card = (n: number) =>
  screen.getByRole('textbox', { name: `Criterion ${n} name` }).closest('li')!;

describe('rubric editor', () => {
  it('shows each criterion with its share of the score', async () => {
    setup(EDIT);
    await screen.findByRole('heading', { name: 'A5 objection handling' });
    expect(card(1)).toHaveTextContent('25% of score');
    expect(card(2)).toHaveTextContent('75% of score');
    expect(within(card(2)).getByLabelText(/^Weight/)).toHaveValue(30);
    expect(within(card(2)).getByLabelText(/^Scoring guidance/)).toHaveValue('A day and a time.');
    expect(screen.getByText(/Weights are relative/)).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Unsaved changes' })).not.toBeInTheDocument();
  });

  it('locks the key of a criterion that past scorecards already use', async () => {
    setup(EDIT);
    await screen.findByRole('heading', { name: 'A5 objection handling' });
    expect(within(card(1)).getByLabelText(/^Key/)).toBeDisabled();
  });

  it('recomputes shares as weights change and offers to publish the next version', async () => {
    const user = userEvent.setup();
    setup(EDIT);
    await screen.findByRole('heading', { name: 'A5 objection handling' });
    const weight = within(card(1)).getByLabelText(/^Weight/);
    await user.clear(weight);
    await user.type(weight, '30');
    expect(card(1)).toHaveTextContent('50% of score');
    const bar = await screen.findByRole('region', { name: 'Unsaved changes' });
    expect(bar).toHaveTextContent('Publishing creates version 3');
    expect(within(bar).getByRole('button', { name: 'Publish version 3' })).toBeInTheDocument();
  });

  it('publishes the edited criteria as a new version', async () => {
    const user = userEvent.setup();
    const next = rubric();
    next.currentVersion = {
      ...next.currentVersion,
      id: '00000000-0000-4000-8000-0000000001ff',
      version: 3,
    };
    const api = setup(EDIT, rubric(), {
      [`POST /ai/rubrics/${IDS.rubric}/versions`]: () => next,
    });
    await screen.findByRole('heading', { name: 'A5 objection handling' });
    const weight = within(card(1)).getByLabelText(/^Weight/);
    await user.clear(weight);
    await user.type(weight, '30');
    await user.type(screen.getByLabelText(/Note for this version/), 'Equal weight');
    await user.click(screen.getByRole('button', { name: 'Publish version 3' }));

    await waitFor(() =>
      expect(api.callsTo(`POST /ai/rubrics/${IDS.rubric}/versions`)).toHaveLength(1),
    );
    const body = api.callsTo(`POST /ai/rubrics/${IDS.rubric}/versions`)[0]!.body as {
      categories: Array<{ key: string; weight: number }>;
      passingScore: number;
      changeNote: string;
    };
    expect(body.passingScore).toBe(75);
    expect(body.changeNote).toBe('Equal weight');
    expect(body.categories.map((c) => [c.key, c.weight])).toEqual([
      ['discovery', 30],
      ['next_step_closing', 30],
    ]);
    await waitFor(() =>
      expect(screen.queryByRole('region', { name: 'Unsaved changes' })).not.toBeInTheDocument(),
    );
  });

  it('adds a criterion with a key made from its name, and removes one', async () => {
    const user = userEvent.setup();
    setup(EDIT);
    await screen.findByRole('heading', { name: 'A5 objection handling' });
    await user.click(screen.getByRole('button', { name: 'Add criterion' }));
    const added = card(3);
    await user.type(
      within(added).getByRole('textbox', { name: 'Criterion 3 name' }),
      'Trust building',
    );
    expect(within(added).getByLabelText(/^Key/)).toHaveValue('trust_building');
    expect(within(added).getByLabelText(/^Key/)).toBeEnabled();
    expect(card(1)).toHaveTextContent('22% of score');

    await user.click(screen.getByRole('button', { name: 'Remove criterion 3' }));
    expect(screen.queryByRole('textbox', { name: 'Criterion 3 name' })).not.toBeInTheDocument();
  });

  it('reorders criteria', async () => {
    const user = userEvent.setup();
    setup(EDIT);
    await screen.findByRole('heading', { name: 'A5 objection handling' });
    await user.click(screen.getByRole('button', { name: 'Move criterion 2 up' }));
    expect(screen.getByRole('textbox', { name: 'Criterion 1 name' })).toHaveValue(
      'Next-step closing',
    );
    expect(screen.getByRole('button', { name: 'Move criterion 1 up' })).toBeDisabled();
  });

  it('does not publish an invalid rubric and marks what to fix', async () => {
    const user = userEvent.setup();
    const api = setup(EDIT);
    await screen.findByRole('heading', { name: 'A5 objection handling' });
    await user.clear(within(card(2)).getByRole('textbox', { name: 'Criterion 2 name' }));
    await user.click(await screen.findByRole('button', { name: 'Publish version 3' }));
    expect(await within(card(2)).findByText('Required')).toBeInTheDocument();
    expect(screen.getByText('Fix the marked fields to publish.')).toBeInTheDocument();
    expect(api.callsTo(`POST /ai/rubrics/${IDS.rubric}/versions`)).toHaveLength(0);
  });

  it('shows a server refusal in the bar', async () => {
    const user = userEvent.setup();
    setup(EDIT, rubric(), {
      [`POST /ai/rubrics/${IDS.rubric}/versions`]: () =>
        json(409, {
          error: {
            code: 'RUBRIC_ARCHIVED',
            message: 'This rubric is archived. Create a new rubric instead.',
          },
        }),
    });
    await screen.findByRole('heading', { name: 'A5 objection handling' });
    const weight = within(card(1)).getByLabelText(/^Weight/);
    await user.clear(weight);
    await user.type(weight, '20');
    await user.click(await screen.findByRole('button', { name: 'Publish version 3' }));
    await screen.findByText('This rubric is archived. Create a new rubric instead.');
  });

  it('loads an earlier version into the editor as the basis for a new one', async () => {
    const user = userEvent.setup();
    setup(EDIT, rubric(), {
      [`GET /ai/rubrics/${IDS.rubric}/versions/${IDS.rubricVersion1}`]: () => ({
        ...rubric().versions[1],
        rubricId: IDS.rubric,
        categories: [
          {
            key: 'discovery',
            label: 'Discovery (v1)',
            description: 'Older wording.',
            weight: 20,
            guidance: '',
          },
        ],
      }),
    });
    await screen.findByRole('heading', { name: 'A5 objection handling' });
    await user.click(screen.getByRole('button', { name: /Use as starting point v1/ }));
    await waitFor(() =>
      expect(screen.getByRole('textbox', { name: 'Criterion 1 name' })).toHaveValue(
        'Discovery (v1)',
      ),
    );
    expect(screen.queryByRole('textbox', { name: 'Criterion 2 name' })).not.toBeInTheDocument();
    expect(screen.getByLabelText(/Note for this version/)).toHaveValue('Based on version 1');
    expect(await screen.findByRole('region', { name: 'Unsaved changes' })).toBeInTheDocument();
  });

  it('lists the version history with the current version marked', async () => {
    setup(EDIT);
    const table = await screen.findByRole('table', { name: 'Rubric versions' });
    const rows = within(table).getAllByRole('row');
    expect(within(rows[1]!).getByText('Current')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('Raised closing weight')).toBeInTheDocument();
    expect(within(rows[2]!).getByText('Initial version')).toBeInTheDocument();
    expect(within(rows[2]!).queryByText('Current')).not.toBeInTheDocument();
  });

  it('is read-only for viewers', async () => {
    setup(['ai_scenarios.view']);
    await screen.findByRole('heading', { name: 'A5 objection handling' });
    expect(screen.getByRole('textbox', { name: 'Criterion 1 name' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Add criterion' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Move criterion/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Rename' })).not.toBeInTheDocument();
    expect(screen.queryByText('Versions are permanent')).not.toBeInTheDocument();
  });

  it('requires ai_scenarios.view', async () => {
    setup(['ai_practice.use']);
    await screen.findByText("You don't have access to this page");
  });
});
