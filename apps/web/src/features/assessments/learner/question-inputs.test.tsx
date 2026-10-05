import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '../test-cleanup';
import { learnerQuestions } from '../test-fixtures';
import { QuestionInput, questionHint, type ChangeOptions } from './question-inputs';
import type { Answer, Question } from './quiz-state';

const questions = learnerQuestions();
const byType = (type: Question['type']) => questions.find((q) => q.type === type)!;

function Harness({
  question,
  initial = null,
  onChange = () => undefined,
  disabled,
  problem,
}: {
  question: Question;
  initial?: Answer | null;
  onChange?: (value: Answer | null, options?: ChangeOptions) => void;
  disabled?: boolean;
  problem?: string;
}) {
  const [value, setValue] = useState<Answer | null>(initial);
  return (
    <div>
      <p id="prompt">{question.prompt}</p>
      <QuestionInput
        question={question}
        promptId="prompt"
        value={value}
        disabled={disabled}
        problem={problem}
        onChange={(v, o) => {
          setValue(v);
          onChange(v, o);
        }}
      />
    </div>
  );
}

describe('multiple choice', () => {
  it('is a radio group named by the prompt and saves immediately', async () => {
    const onChange = vi.fn();
    render(<Harness question={byType('multiple_choice')} onChange={onChange} />);
    const group = screen.getByRole('radiogroup', { name: /photo report/i });
    expect(within(group).getAllByRole('radio')).toHaveLength(3);
    await userEvent.click(screen.getByRole('radio', { name: 'The homeowner' }));
    expect(onChange).toHaveBeenLastCalledWith(
      { type: 'multiple_choice', optionId: 'a' },
      { immediate: true },
    );
    expect(screen.getByRole('radio', { name: 'The homeowner' })).toBeChecked();
  });

  it('can be answered from the keyboard', async () => {
    const onChange = vi.fn();
    render(<Harness question={byType('multiple_choice')} onChange={onChange} />);
    await userEvent.tab();
    expect(screen.getByRole('radio', { name: 'The homeowner' })).toHaveFocus();
    await userEvent.keyboard('{ArrowDown}');
    expect(onChange).toHaveBeenLastCalledWith(
      { type: 'multiple_choice', optionId: 'b' },
      { immediate: true },
    );
  });

  it('shows the saved answer when resuming', () => {
    render(
      <Harness
        question={byType('multiple_choice')}
        initial={{ type: 'multiple_choice', optionId: 'c' }}
      />,
    );
    expect(screen.getByRole('radio', { name: 'The insurance adjuster' })).toBeChecked();
  });
});

describe('multiple select', () => {
  it('toggles options and clears the answer when nothing is selected', async () => {
    const onChange = vi.fn();
    render(<Harness question={byType('multiple_select')} onChange={onChange} />);
    await userEvent.click(screen.getByRole('checkbox', { name: 'Bruised shingles' }));
    await userEvent.click(screen.getByRole('checkbox', { name: /Granule loss/ }));
    expect(onChange).toHaveBeenLastCalledWith(
      { type: 'multiple_select', optionIds: ['a', 'b'] },
      { immediate: true },
    );
    await userEvent.click(screen.getByRole('checkbox', { name: 'Bruised shingles' }));
    await userEvent.click(screen.getByRole('checkbox', { name: /Granule loss/ }));
    expect(onChange).toHaveBeenLastCalledWith(null, { immediate: true });
  });
});

describe('true / false', () => {
  it('records false as an answer', async () => {
    const onChange = vi.fn();
    render(<Harness question={byType('true_false')} onChange={onChange} />);
    await userEvent.click(screen.getByRole('radio', { name: 'False' }));
    expect(onChange).toHaveBeenLastCalledWith(
      { type: 'true_false', value: false },
      { immediate: true },
    );
  });
});

describe('short answer', () => {
  it('limits length, counts characters and clears when emptied', async () => {
    const onChange = vi.fn();
    render(<Harness question={byType('short_answer')} onChange={onChange} />);
    const input = screen.getByRole('textbox', { name: /What does the A/ });
    expect(input).toHaveAttribute('maxlength', '20');
    await userEvent.type(input, 'Alpine');
    expect(onChange).toHaveBeenLastCalledWith({ type: 'short_answer', text: 'Alpine' }, undefined);
    expect(screen.getByText('6 of 20 characters')).toBeInTheDocument();
    await userEvent.clear(input);
    expect(onChange).toHaveBeenLastCalledWith(null, undefined);
  });
});

describe('long answer', () => {
  it('shows word count against the limit and flags an answer that is too long', async () => {
    render(<Harness question={byType('long_answer')} />);
    const area = screen.getByRole('textbox', { name: /door-knock/ });
    await userEvent.type(area, 'one two three');
    expect(screen.getByText(/3 words/)).toHaveTextContent('suggested at least 5');
    expect(screen.getByText(/3 words/)).toHaveTextContent('limit 12');
    await userEvent.type(area, ' four five six seven eight nine ten eleven twelve thirteen');
    expect(area).toHaveAttribute('aria-invalid', 'true');
  });
});

describe('scenario', () => {
  it('shows the scenario and a multiple choice follow-up', async () => {
    const onChange = vi.fn();
    render(<Harness question={byType('scenario')} onChange={onChange} />);
    expect(screen.getByText(/talk to their spouse first/)).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole('radio', { name: 'Offer to return when both are home' }),
    );
    expect(onChange).toHaveBeenLastCalledWith(
      { type: 'scenario', optionId: 'x' },
      { immediate: true },
    );
  });

  it('takes a written response for open scenarios', async () => {
    const open: Question = {
      ...(byType('scenario') as Extract<Question, { type: 'scenario' }>),
      subQuestion: { kind: 'open_response', prompt: 'What would you say?', maxLength: 100 },
    };
    const onChange = vi.fn();
    render(<Harness question={open} onChange={onChange} />);
    await userEvent.type(screen.getByRole('textbox', { name: /What would you say/ }), 'Hi');
    expect(onChange).toHaveBeenLastCalledWith({ type: 'scenario', text: 'Hi' }, undefined);
  });
});

describe('ordering', () => {
  const itemTexts = () =>
    screen.getAllByRole('listitem').map((li) =>
      li.textContent
        ?.replace(/Position \d of \d: /, '')
        .replace(/^\d/, '')
        .replace(/Move.*$/, '')
        .trim(),
    );

  it('lists the items in the drawn order and says the question is not answered yet', () => {
    render(<Harness question={byType('ordering')} />);
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
    expect(screen.getByRole('button', { name: 'Keep this order' })).toBeInTheDocument();
    expect(screen.getByText(/Not answered yet/)).toBeInTheDocument();
  });

  it('moves items with buttons and saves the whole order', async () => {
    const onChange = vi.fn();
    render(<Harness question={byType('ordering')} onChange={onChange} />);
    await userEvent.click(screen.getByRole('button', { name: 'Move Inspect up' }));
    expect(onChange).toHaveBeenLastCalledWith(
      { type: 'ordering', order: ['i1', 'i3', 'i2'] },
      { immediate: true },
    );
    expect(itemTexts()[0]).toContain('Inspect');
    expect(screen.queryByRole('button', { name: 'Keep this order' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Move Estimate up' }));
    expect(onChange).toHaveBeenLastCalledWith(
      { type: 'ordering', order: ['i1', 'i2', 'i3'] },
      { immediate: true },
    );
  });

  it('keeps keyboard focus on the item that moved', async () => {
    render(<Harness question={byType('ordering')} />);
    const down = screen.getByRole('button', { name: 'Move Install down' });
    down.focus();
    await userEvent.keyboard('{Enter}');
    expect(screen.getByRole('button', { name: 'Move Install down' })).toHaveFocus();
  });

  it('announces moves and disables impossible ones', async () => {
    render(<Harness question={byType('ordering')} />);
    expect(screen.getByRole('button', { name: 'Move Install up' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Move Estimate down' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Move Estimate up' }));
    expect(screen.getByRole('status')).toHaveTextContent('Estimate moved to position 2 of 3.');
  });

  it('lets the learner confirm the order shown as their answer', async () => {
    const onChange = vi.fn();
    render(<Harness question={byType('ordering')} onChange={onChange} />);
    await userEvent.click(screen.getByRole('button', { name: 'Keep this order' }));
    expect(onChange).toHaveBeenLastCalledWith(
      { type: 'ordering', order: ['i3', 'i1', 'i2'] },
      { immediate: true },
    );
  });
});

describe('matching', () => {
  it('matches each prompt with a choice and keeps a choice from being used twice', async () => {
    const onChange = vi.fn();
    render(<Harness question={byType('matching')} onChange={onChange} />);
    const underlayment = screen.getByRole('combobox', { name: 'Underlayment' });
    const flashing = screen.getByRole('combobox', { name: 'Flashing' });
    await userEvent.selectOptions(underlayment, 'Secondary water barrier');
    expect(onChange).toHaveBeenLastCalledWith(
      { type: 'matching', matches: { p1: 'c1' } },
      { immediate: true },
    );
    expect(
      within(flashing).getByRole('option', { name: 'Secondary water barrier (used)' }),
    ).toBeDisabled();
    expect(
      within(underlayment).getByRole('option', { name: 'Secondary water barrier' }),
    ).not.toBeDisabled();
    await userEvent.selectOptions(flashing, 'Redirects water at joints');
    expect(onChange).toHaveBeenLastCalledWith(
      { type: 'matching', matches: { p1: 'c1', p2: 'c2' } },
      { immediate: true },
    );
  });

  it('clears a match', async () => {
    const onChange = vi.fn();
    render(
      <Harness
        question={byType('matching')}
        initial={{ type: 'matching', matches: { p1: 'c1' } }}
        onChange={onChange}
      />,
    );
    await userEvent.selectOptions(
      screen.getByRole('combobox', { name: 'Underlayment' }),
      'Choose a match',
    );
    expect(onChange).toHaveBeenLastCalledWith(null, { immediate: true });
  });
});

describe('shared behaviour', () => {
  it('disables every control when the attempt is closed', () => {
    render(<Harness question={byType('multiple_choice')} disabled />);
    for (const r of screen.getAllByRole('radio')) expect(r).toBeDisabled();
  });

  it('shows why an answer was not saved', () => {
    render(
      <Harness
        question={byType('short_answer')}
        problem="Keep your answer to 20 characters or fewer."
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Keep your answer to 20 characters or fewer.',
    );
  });

  it('gives every type an instruction', () => {
    for (const q of questions) expect(questionHint(q).length).toBeGreaterThan(5);
  });
});
