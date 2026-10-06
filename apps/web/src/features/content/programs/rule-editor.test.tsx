import { useState } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { RuleEditor, type RuleContext } from './rule-editor';
import { emptyGroup, fromDraft, validateDraft, type DraftGroup } from './rule-model';
import type { Phase } from './tree';

afterEach(cleanup);

const ASSESSMENT = '0192f7a0-0000-7000-8000-0000000000a1';
const ctx: RuleContext = {
  phases: [
    {
      id: 'P1',
      label: 'Week 1',
      title: 'Basics',
      position: 1,
      status: 'published',
      modules: [
        {
          id: 'M1',
          title: 'Start',
          position: 1,
          status: 'published',
          lessons: [{ id: 'L1', title: 'Welcome', position: 1, status: 'published' }],
        },
      ],
    },
  ] as unknown as Phase[],
  assessments: [{ id: ASSESSMENT, title: 'Week 1 Knowledge Check', passingPercent: 80 }],
  scenarios: [],
  programs: [],
  certifications: [],
};

function Harness({ onChange }: { onChange?: (rule: unknown) => void }) {
  const [draft, setDraft] = useState<DraftGroup>(emptyGroup());
  const problems = validateDraft(draft);
  return (
    <>
      <RuleEditor
        draft={draft}
        ctx={ctx}
        problems={problems}
        onChange={(d) => {
          setDraft(d);
          onChange?.(fromDraft(d));
        }}
      />
      <output aria-label="valid">{problems.size === 0 ? 'yes' : 'no'}</output>
    </>
  );
}

describe('RuleEditor', () => {
  it('starts with no requirements and says what that means', () => {
    render(<Harness />);
    expect(screen.getByText('No requirements yet.')).toBeInTheDocument();
    expect(
      screen.getByText(/available as soon as the rest of the program allows/),
    ).toBeInTheDocument();
  });

  it('builds a requirement whose limits and starting value come from the data', async () => {
    const user = userEvent.setup();
    let last: unknown = null;
    render(<Harness onChange={(r) => (last = r)} />);
    await user.click(screen.getByRole('button', { name: 'Add requirement' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Score on an assessment' }));

    // The number box carries the schema's limits; nothing is pre-filled until a choice is made.
    const score = screen.getByLabelText(/Minimum score/);
    expect(score).toHaveAttribute('min', '0');
    expect(score).toHaveAttribute('max', '100');
    expect(score).toHaveValue(null);
    expect(screen.getByLabelText('valid')).toHaveTextContent('no');

    // Choosing an assessment offers its own pass mark as the threshold.
    await user.selectOptions(screen.getByLabelText(/^Assessment/), ASSESSMENT);
    expect(score).toHaveValue(80);
    expect(screen.getByLabelText('valid')).toHaveTextContent('yes');
    expect(last).toEqual({ type: 'assessment_score', assessmentId: ASSESSMENT, minPercent: 80 });
    expect(screen.getByText(/Score 80% or higher on "Week 1 Knowledge Check"/)).toBeInTheDocument();
  });

  it('explains an out-of-range threshold using the schema limits', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Add requirement' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Score on an assessment' }));
    await user.selectOptions(screen.getByLabelText(/^Assessment/), ASSESSMENT);
    const score = screen.getByLabelText(/Minimum score/);
    await user.clear(score);
    await user.type(score, '140');
    expect(
      await screen.findByText('Minimum score must be between 0% and 100%.'),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('valid')).toHaveTextContent('no');
  });

  it('offers lessons from the program tree and lets a requirement be removed', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Add requirement' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Complete a lesson' }));
    expect(screen.getByRole('option', { name: 'Week 1 › Start › Welcome' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Remove requirement: Complete a lesson' }));
    expect(screen.getByText('No requirements yet.')).toBeInTheDocument();
  });
});
