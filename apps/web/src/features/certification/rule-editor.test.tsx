import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Rule } from '@a5/rules';
import { RuleEditor } from './rule-editor';
import { json, mockApi, renderApp } from './test-utils';

const PROGRAM = '0190aaaa-0000-7000-8000-0000000000a1';
const ASSESSMENT = '0190aaaa-0000-7000-8000-0000000000a2';
const SCENARIO = '0190aaaa-0000-7000-8000-0000000000a3';

const page = (items: unknown[]) =>
  json(200, { items, page: 1, pageSize: 100, total: items.length, pageCount: 1 });

function lookups(overrides: Record<string, () => Response> = {}) {
  return mockApi({
    'GET /api/v1/programs': () => page([{ id: PROGRAM, title: 'A5 New Hire Sales Academy' }]),
    'GET /api/v1/assessments': () =>
      page([{ id: ASSESSMENT, title: 'Final Sales Readiness Assessment' }]),
    'GET /api/v1/ai/scenarios': () => page([{ id: SCENARIO, title: 'Price objection' }]),
    'GET /api/v1/certifications': () => page([]),
    ...overrides,
  });
}

function Harness({ initial, onChange }: { initial: Rule; onChange?: (r: Rule) => void }) {
  const [rule, setRule] = useState(initial);
  return (
    <RuleEditor
      ariaLabel="Eligibility requirements"
      value={rule}
      programIds={[]}
      showProblems
      onChange={(r) => {
        setRule(r);
        onChange?.(r);
      }}
    />
  );
}

const existing: Rule = {
  type: 'all',
  rules: [
    { type: 'program_completed', programId: PROGRAM, minPercent: 100 },
    { type: 'assessment_score', assessmentId: ASSESSMENT, minPercent: 85 },
    { type: 'ai_sessions_count', minCount: 5 },
    { type: 'approval', kind: 'manager' },
  ],
};

describe('RuleEditor', () => {
  it('shows the thresholds stored in the rule and never invents its own', async () => {
    lookups();
    renderApp(<Harness initial={existing} />);
    const editor = screen.getByRole('group', { name: 'Eligibility requirements' });
    expect(await within(editor).findByDisplayValue('85')).toBeInTheDocument();
    expect(within(editor).getByLabelText('Sessions required')).toHaveValue(5);
    expect(within(editor).getByLabelText('Minimum completion')).toHaveValue(100);
    expect(within(editor).getByText(/This follows the approval policy above/)).toBeInTheDocument();
  });

  it('changes a threshold in the rule it hands back', async () => {
    lookups();
    let latest: Rule = existing;
    renderApp(<Harness initial={existing} onChange={(r) => (latest = r)} />);
    const field = await screen.findByLabelText('Passing score');
    await userEvent.clear(field);
    await userEvent.type(field, '72');
    expect((latest as { rules: Array<{ minPercent?: number }> }).rules[1]).toMatchObject({
      type: 'assessment_score',
      minPercent: 72,
    });
    expect((latest as { rules: Rule[] }).rules).toHaveLength(4);
  });

  it('adds a requirement with every threshold blank and reports it until it is filled in', async () => {
    lookups();
    let latest: Rule = { type: 'all', rules: [] };
    renderApp(<Harness initial={latest} onChange={(r) => (latest = r)} />);
    expect(screen.getByText('No requirements yet.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Add requirement/ }));
    await userEvent.click(
      await screen.findByRole('menuitem', { name: 'Average AI practice score' }),
    );
    const leaf = (latest as { rules: Array<{ type: string; minScore: number }> }).rules[0]!;
    expect(leaf.type).toBe('ai_average_score');
    expect(Number.isNaN(leaf.minScore)).toBe(true);
    expect(screen.getByLabelText('Minimum average')).toHaveValue(null);
    expect(screen.getByText('Enter an average score between 0 and 100.')).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Minimum average'), '80');
    expect(screen.queryByText('Enter an average score between 0 and 100.')).toBeNull();
  });

  it('can switch a group between "every" and "any one" and remove a requirement', async () => {
    lookups();
    let latest: Rule = existing;
    renderApp(<Harness initial={existing} onChange={(r) => (latest = r)} />);
    await userEvent.selectOptions(
      screen.getByRole('combobox', { name: 'The person must meet' }),
      'any',
    );
    expect(latest.type).toBe('any');
    await userEvent.click(
      screen.getByRole('button', { name: 'Remove requirement: Complete a program' }),
    );
    expect((latest as { rules: Rule[] }).rules.map((r) => r.type)).toEqual([
      'assessment_score',
      'ai_sessions_count',
      'approval',
    ]);
  });

  it('lets optional parts be switched on and keeps them out of the rule when off', async () => {
    lookups();
    let latest: Rule = existing;
    renderApp(<Harness initial={existing} onChange={(r) => (latest = r)} />);
    await userEvent.click(
      screen.getByRole('checkbox', { name: 'Only count sessions above a score' }),
    );
    const sessions = (latest as { rules: Array<Record<string, unknown>> }).rules[2]!;
    expect('minScore' in sessions).toBe(true);
    await userEvent.type(screen.getByLabelText('Minimum session score'), '70');
    expect((latest as { rules: Array<Record<string, unknown>> }).rules[2]!['minScore']).toBe(70);
    await userEvent.click(
      screen.getByRole('checkbox', { name: 'Only count sessions above a score' }),
    );
    expect(
      (latest as { rules: Array<Record<string, unknown>> }).rules[2]!['minScore'],
    ).toBeUndefined();
  });

  it('keeps an existing choice when the person cannot list that kind of item', async () => {
    lookups({
      'GET /api/v1/assessments': () =>
        json(403, {
          error: { code: 'FORBIDDEN', message: 'You do not have permission to do this.' },
        }),
    });
    renderApp(<Harness initial={existing} />);
    expect(
      await screen.findByText(/You can't list assessments with your current permissions/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('option', { name: 'Selected assessment (not in the list)' }),
    ).toBeInTheDocument();
  });

  it('does not offer editing controls when disabled', async () => {
    lookups();
    renderApp(
      <RuleEditor
        ariaLabel="Eligibility requirements"
        value={existing}
        programIds={[]}
        disabled
        onChange={() => undefined}
      />,
    );
    expect(screen.queryByRole('button', { name: /Add requirement/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Remove requirement/ })).toBeNull();
    expect(await screen.findByLabelText('Passing score')).toBeDisabled();
  });
});
