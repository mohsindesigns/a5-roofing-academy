import { describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { IssueDialog, RevokeDialog, revokeFormSchema } from './certificate-dialogs';
import { json, mockApi, renderApp } from '../test-utils';

const CERT_ID = '0190aaaa-0000-7000-8000-0000000000c1';
const DEF_ID = '0190aaaa-0000-7000-8000-0000000000d1';
const USER_ID = '0190aaaa-0000-7000-8000-0000000000f2';
const NUMBER = 'A5-SALES-2026-000007';

const certificate = {
  id: CERT_ID,
  certificateNumber: NUMBER,
  recipient: { id: USER_ID, displayName: 'Wesley Tran' },
};

describe('revokeFormSchema', () => {
  const schema = revokeFormSchema(`REVOKE ${NUMBER}`);
  it('needs a real reason and the exact confirmation phrase, in any letter case', () => {
    expect(
      schema.safeParse({ reason: 'short', publicNote: '', confirmation: `REVOKE ${NUMBER}` })
        .success,
    ).toBe(false);
    expect(
      schema.safeParse({
        reason: 'Issued to the wrong person.',
        publicNote: '',
        confirmation: 'REVOKE',
      }).success,
    ).toBe(false);
    expect(
      schema.safeParse({
        reason: 'Issued to the wrong person.',
        publicNote: '',
        confirmation: ` revoke ${NUMBER.toLowerCase()} `,
      }).success,
    ).toBe(true);
  });
  it('keeps the public note short', () => {
    expect(
      schema.safeParse({
        reason: 'Issued to the wrong person.',
        publicNote: 'x'.repeat(301),
        confirmation: `REVOKE ${NUMBER}`,
      }).success,
    ).toBe(false);
  });
});

describe('RevokeDialog', () => {
  it('requires a reason and the typed phrase before anything is sent', async () => {
    const calls = mockApi({});
    renderApp(<RevokeDialog certificate={certificate} open onOpenChange={() => undefined} />);
    const dialog = screen.getByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Revoke certificate' }));
    expect(
      await within(dialog).findByText(/Explain why the certificate is revoked/),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByText(`Type REVOKE ${NUMBER} exactly to confirm`),
    ).toBeInTheDocument();
    expect(calls).toHaveLength(0);
  });

  it('sends the reason, public note and confirmation, then closes', async () => {
    const onOpenChange = vi.fn();
    const calls = mockApi({
      [`POST /api/v1/certificates/${CERT_ID}/revoke`]: () =>
        json(200, { id: CERT_ID, certificateNumber: NUMBER }),
    });
    renderApp(<RevokeDialog certificate={certificate} open onOpenChange={onOpenChange} />);
    const dialog = screen.getByRole('dialog');
    await userEvent.type(
      within(dialog).getByLabelText(/^Reason/),
      'Issued to the wrong person by mistake.',
    );
    await userEvent.type(within(dialog).getByLabelText(/^Public note/), 'Withdrawn by the issuer.');
    await userEvent.type(within(dialog).getByLabelText(/to confirm/), `REVOKE ${NUMBER}`);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Revoke certificate' }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.body).toEqual({
      reason: 'Issued to the wrong person by mistake.',
      publicNote: 'Withdrawn by the issuer.',
      confirmation: `REVOKE ${NUMBER}`,
    });
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it('shows a server refusal inside the dialog and keeps it open', async () => {
    const onOpenChange = vi.fn();
    mockApi({
      [`POST /api/v1/certificates/${CERT_ID}/revoke`]: () =>
        json(409, {
          error: { code: 'ALREADY_REVOKED', message: 'This certificate is already revoked.' },
        }),
    });
    renderApp(<RevokeDialog certificate={certificate} open onOpenChange={onOpenChange} />);
    const dialog = screen.getByRole('dialog');
    await userEvent.type(
      within(dialog).getByLabelText(/^Reason/),
      'Issued to the wrong person by mistake.',
    );
    await userEvent.type(within(dialog).getByLabelText(/to confirm/), `REVOKE ${NUMBER}`);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Revoke certificate' }));
    expect(
      await within(dialog).findByText('This certificate is already revoked.'),
    ).toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });
});

describe('IssueDialog', () => {
  const definitions = {
    items: [
      {
        id: DEF_ID,
        name: 'A5 Roofing Certified Sales Representative',
        code: 'SALES',
        status: 'active',
      },
    ],
    page: 1,
    pageSize: 100,
    total: 1,
    pageCount: 1,
  };
  const notEligible = () =>
    json(422, {
      error: {
        code: 'NOT_ELIGIBLE',
        message: 'Requirements are not met yet.',
        details: { unmet: ['Complete A5 New Hire Sales Academy', 'Manager approval'] },
      },
    });
  const preset = { definitionId: DEF_ID, userId: USER_ID, userName: 'Wesley Tran' };

  it('lists what is missing and lets only people who may update certifications override it', async () => {
    mockApi({
      'GET /api/v1/certifications': () => json(200, definitions),
      'POST /api/v1/certificates': notEligible,
    });
    renderApp(<IssueDialog open onOpenChange={() => undefined} preset={preset} />, {
      permissions: { 'certificates.issue': 'organization' },
    });
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Issue certificate' }));
    expect(await within(dialog).findByText('Requirements are not met yet')).toBeInTheDocument();
    expect(within(dialog).getByText('Complete A5 New Hire Sales Academy')).toBeInTheDocument();
    expect(within(dialog).getByText('Manager approval')).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: /override/ })).toBeNull();
    expect(
      within(dialog).getByText(/Only administrators who can update certifications/),
    ).toBeInTheDocument();
  });

  it('issues with a recorded override reason for administrators', async () => {
    const calls = mockApi({
      'GET /api/v1/certifications': () => json(200, definitions),
      'POST /api/v1/certificates': (_url, init) =>
        JSON.parse(String(init?.body)).override
          ? json(200, { id: CERT_ID, certificateNumber: NUMBER })
          : notEligible(),
    });
    renderApp(<IssueDialog open onOpenChange={() => undefined} preset={preset} />, {
      permissions: {
        'certificates.issue': 'organization',
        'certifications.update': 'organization',
      },
    });
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Issue certificate' }));
    await userEvent.click(
      await within(dialog).findByRole('button', { name: 'Issue anyway with an override' }),
    );
    const submit = within(dialog).getByRole('button', { name: 'Issue with override' });
    expect(submit).toBeDisabled();
    await userEvent.type(
      within(dialog).getByLabelText(/Override reason/),
      'Completed in person at the Dallas office.',
    );
    expect(submit).toBeEnabled();
    await userEvent.click(submit);
    await waitFor(() => expect(calls.filter((c) => c.method === 'POST')).toHaveLength(2));
    expect(calls.filter((c) => c.method === 'POST')[1]!.body).toEqual({
      definitionId: DEF_ID,
      userId: USER_ID,
      override: { reason: 'Completed in person at the Dallas office.' },
    });
  });
});
