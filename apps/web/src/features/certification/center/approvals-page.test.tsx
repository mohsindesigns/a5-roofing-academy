import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ApprovalRow } from './approvals-page';
import { ME_ID, json, mockApi, renderApp } from '../test-utils';
import type { Approval } from '../types';

const DEF = '0190aaaa-0000-7000-8000-0000000000d1';
const APPROVAL_ID = '0190aaaa-0000-7000-8000-0000000000e1';
const OTHER = '0190aaaa-0000-7000-8000-0000000000f2';

function approval(overrides: Partial<Approval> = {}): Approval {
  return {
    id: APPROVAL_ID,
    status: 'pending',
    kind: 'manager',
    requestedAt: new Date(Date.now() - 2 * 3600_000).toISOString(),
    decidedAt: null,
    decidedBy: null,
    comment: null,
    definition: { id: DEF, name: 'A5 Roofing Certified Sales Representative', code: 'SALES' },
    user: {
      id: OTHER,
      displayName: 'Brianna Castillo',
      employeeId: 'A5-1205',
      jobTitle: 'Sales Representative',
    },
    progress: {
      metCount: 5,
      totalCount: 6,
      requirements: [
        {
          key: '0',
          type: 'program_completed',
          description: 'Complete A5 New Hire Sales Academy',
          satisfied: true,
          unknown: false,
          progress: { current: 100, target: 100, unit: 'percent' },
        },
        {
          key: '1',
          type: 'approval',
          description: 'Manager approval',
          satisfied: false,
          unknown: false,
          progress: { current: 0, target: 1, unit: 'boolean' },
        },
      ],
    },
    certificateId: null,
    ...overrides,
  };
}

const manager = { 'certificate_approvals.decide': 'managed' } as const;
const admin = { 'certificate_approvals.decide': 'organization' } as const;

describe('ApprovalRow', () => {
  it('shows who is waiting, for what, and how far they are', () => {
    renderApp(
      <ul>
        <ApprovalRow approval={approval()} />
      </ul>,
      { permissions: manager },
    );
    expect(screen.getByText('Brianna Castillo')).toBeInTheDocument();
    expect(screen.getByText('A5 Roofing Certified Sales Representative')).toBeInTheDocument();
    expect(screen.getByText(/Manager approval/)).toBeInTheDocument();
    expect(screen.getByText('5 of 6')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Approve' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Decline' })).toBeEnabled();
  });

  it('reveals the requirement checklist on request', async () => {
    renderApp(
      <ul>
        <ApprovalRow approval={approval()} />
      </ul>,
      { permissions: manager },
    );
    await userEvent.click(screen.getByRole('button', { name: 'Review requirements' }));
    expect(screen.getByText('Complete A5 New Hire Sales Academy')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Hide requirements' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
  });

  it('blocks deciding your own certification and says why', () => {
    renderApp(
      <ul>
        <ApprovalRow approval={approval({ user: { ...approval().user, id: ME_ID } })} />
      </ul>,
      { permissions: admin },
    );
    expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Decline' })).toBeDisabled();
    expect(screen.getByRole('note')).toHaveTextContent(
      'You cannot decide your own certification. Ask another approver.',
    );
  });

  it('keeps manual review for people with organization-wide access', () => {
    renderApp(
      <ul>
        <ApprovalRow approval={approval({ kind: 'manual_review' })} />
      </ul>,
      { permissions: manager },
    );
    expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled();
    expect(screen.getByRole('note')).toHaveTextContent('organization-wide approval access');
  });

  it('approves with an optional comment', async () => {
    const calls = mockApi({
      [`POST /api/v1/certificates/approvals/${APPROVAL_ID}/decision`]: () =>
        json(200, approval({ status: 'approved' })),
    });
    renderApp(
      <ul>
        <ApprovalRow approval={approval()} />
      </ul>,
      { permissions: manager },
    );
    await userEvent.click(screen.getByRole('button', { name: 'Approve' }));
    const dialog = await screen.findByRole('alertdialog');
    await userEvent.type(within(dialog).getByRole('textbox'), 'Ready for the field.');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Approve certification' }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.body).toEqual({ decision: 'approved', comment: 'Ready for the field.' });
  });

  it('will not decline without saying what is missing', async () => {
    renderApp(
      <ul>
        <ApprovalRow approval={approval()} />
      </ul>,
      { permissions: manager },
    );
    await userEvent.click(screen.getByRole('button', { name: 'Decline' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByRole('button', { name: 'Decline request' })).toBeDisabled();
    await userEvent.type(
      within(dialog).getByRole('textbox'),
      'One more supervised appointment first.',
    );
    expect(within(dialog).getByRole('button', { name: 'Decline request' })).toBeEnabled();
  });

  it('shows the API’s own words when it refuses, including the anti self-approval message', async () => {
    mockApi({
      [`POST /api/v1/certificates/approvals/${APPROVAL_ID}/decision`]: () =>
        json(403, {
          error: {
            code: 'FORBIDDEN',
            message:
              'Only this person’s trainer or an administrator can approve this certification.',
          },
        }),
    });
    renderApp(
      <ul>
        <ApprovalRow approval={approval({ kind: 'trainer' })} />
      </ul>,
      { permissions: manager },
    );
    await userEvent.click(screen.getByRole('button', { name: 'Approve' }));
    const dialog = await screen.findByRole('alertdialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Approve certification' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Only this person’s trainer or an administrator can approve this certification.',
    );
  });

  it('shows the outcome of a request that is already decided and offers no actions', () => {
    renderApp(
      <ul>
        <ApprovalRow
          approval={approval({
            status: 'rejected',
            decidedAt: '2026-10-04T15:00:00.000Z',
            decidedBy: { id: OTHER, displayName: 'Danielle Okafor' },
            comment: 'One more supervised appointment first.',
          })}
        />
      </ul>,
      { permissions: manager },
    );
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(screen.getByText('Not approved')).toBeInTheDocument();
    expect(screen.getByText(/Danielle Okafor/)).toHaveTextContent(
      'One more supervised appointment first.',
    );
  });
});
