import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { AttentionFlags, sortFlags } from './attention';

const flags = [
  { code: 'awaiting_approval', message: 'Waiting for a sign-off or assignment review' },
  { code: 'inactive', message: 'No activity in 11 days' },
  { code: 'overdue', message: 'Overdue by 7 days' },
] as const;

afterEach(cleanup);

describe('AttentionFlags', () => {
  it('orders flags by urgency', () => {
    expect(sortFlags([...flags]).map((f) => f.code)).toEqual([
      'overdue',
      'inactive',
      'awaiting_approval',
    ]);
  });

  it('says a person is on track when nothing is flagged', () => {
    render(<AttentionFlags flags={[]} />);
    expect(screen.getByText('On track')).toBeInTheDocument();
  });

  it('shows label and message for every flag in the full view', () => {
    render(<AttentionFlags flags={[...flags]} />);
    const items = screen.getAllByRole('listitem');
    expect(items).toHaveLength(3);
    expect(within(items[0]!).getByText('Overdue')).toBeInTheDocument();
    expect(within(items[0]!).getByText('Overdue by 7 days')).toBeInTheDocument();
  });

  it('collapses to the most urgent flag with a count in the compact view', () => {
    render(<AttentionFlags flags={[...flags]} compact />);
    expect(screen.getByText('Overdue')).toBeInTheDocument();
    expect(screen.queryByText('Inactive')).not.toBeInTheDocument();
    expect(screen.getByText('+2 more')).toBeInTheDocument();
  });
});
