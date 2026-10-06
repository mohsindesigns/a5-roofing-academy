import { expect, test } from '@playwright/test';
import { accounts, apiAs, signIn, unique } from './support';

const CERTIFICATION = 'A5 Roofing Certified Sales Representative';

test.describe('certification lifecycle', () => {
  test('issue, verify publicly, revoke, and see the revocation on the verification page', async ({
    page,
    browser,
    request,
  }) => {
    // A fresh person each run, so the test never depends on (or disturbs) seeded certificates.
    const admin = await apiAs(request, accounts.admin);
    const roles = await admin.get<{ items: Array<{ id: string; key: string }> }>('/roles');
    const repRole = roles.items.find((r) => r.key === 'sales_rep');
    expect(repRole, 'the sales_rep role exists').toBeTruthy();
    const first = 'Wesley';
    const last = unique('Tran');
    const fullName = `${first} ${last}`;
    await admin.post('/users', {
      email: `${first}.${last}@a5roofing.example`.toLowerCase(),
      firstName: first,
      lastName: last,
      roleIds: [repRole!.id],
      sendInvitation: false,
    });

    // 1. Issue. The new person has not met the requirements, so an administrator overrides with a reason.
    await signIn(page, accounts.admin);
    await page.goto('/certification-center/issued');
    await page.getByRole('button', { name: 'Issue certificate' }).click();
    const issue = page.getByRole('dialog');
    await issue.getByLabel('Certification').selectOption({ label: CERTIFICATION });
    await issue.getByRole('combobox', { name: 'Person' }).fill(last);
    await page.getByRole('option', { name: new RegExp(last) }).click();
    await issue.getByRole('button', { name: 'Issue certificate' }).click();
    await expect(issue.getByText('Requirements are not met yet')).toBeVisible();
    await issue.getByRole('button', { name: 'Issue anyway with an override' }).click();
    await issue
      .getByLabel(/Override reason/)
      .fill('End-to-end test: issuing without completed training.');
    await issue.getByRole('button', { name: 'Issue with override' }).click();

    await expect(page).toHaveURL(/\/certification-center\/issued\/[0-9a-f-]{36}$/);
    await expect(page.getByRole('heading', { level: 1, name: fullName })).toBeVisible();
    const number = (
      await page
        .getByText(/^A5-SALES-\d{4}-\d{6}$/)
        .first()
        .textContent()
    )?.trim();
    expect(number).toMatch(/^A5-SALES-\d{4}-\d{6}$/);
    const link = await page.getByRole('textbox', { name: 'Verification link' }).inputValue();
    const verifyPath = new URL(link).pathname;
    expect(verifyPath).toMatch(/^\/verify\/[A-Za-z0-9_-]{32,64}$/);

    // 2. Anyone can verify it, without signing in, and only public details are shown.
    const visitor = await browser.newContext();
    const verify = await visitor.newPage();
    await verify.goto(verifyPath);
    await expect(
      verify.getByRole('heading', { level: 1, name: 'Valid certificate' }),
    ).toBeVisible();
    await expect(verify.getByText(fullName)).toBeVisible();
    await expect(verify.getByText(number!)).toBeVisible();
    await expect(verify.getByText(CERTIFICATION)).toBeVisible();
    await expect(verify.getByText('Employee ID')).toHaveCount(0);
    await expect(verify.getByRole('navigation')).toHaveCount(0);

    // 3. Revoke with a reason and the typed confirmation phrase.
    await page.getByRole('button', { name: 'Revoke', exact: true }).click();
    const revoke = page.getByRole('dialog');
    const confirm = revoke.getByRole('button', { name: 'Revoke certificate' });
    await confirm.click();
    await expect(revoke.getByText(/Explain why the certificate is revoked/)).toBeVisible();
    await revoke
      .getByLabel(/^Reason/)
      .fill('End-to-end test: certificate issued only to exercise revocation.');
    await revoke.getByLabel(/^Public note/).fill('Withdrawn by the issuer.');
    await revoke.getByLabel(/to confirm/).fill('REVOKE nothing');
    await confirm.click();
    await expect(revoke.getByText(/Type REVOKE .* exactly to confirm/)).toBeVisible();
    await revoke.getByLabel(/to confirm/).fill(`REVOKE ${number}`);
    await confirm.click();
    await expect(page.getByText(`Revoked`).first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Revoke', exact: true })).toHaveCount(0);

    // 4. The same link now says the certificate is revoked, with the public note.
    await verify.reload();
    await expect(
      verify.getByRole('heading', { level: 1, name: 'Revoked certificate' }),
    ).toBeVisible();
    await expect(verify.getByText('Withdrawn by the issuer.')).toBeVisible();
    await visitor.close();
  });

  test('an unknown verification link explains itself without revealing anything', async ({
    browser,
  }) => {
    const visitor = await browser.newContext();
    const page = await visitor.newPage();
    await page.goto(`/verify/${'x'.repeat(43)}`);
    await expect(
      page.getByRole('heading', { level: 1, name: 'We could not verify this certificate' }),
    ).toBeVisible();
    await page.goto('/verify/too-short');
    await expect(
      page.getByRole('heading', { level: 1, name: 'We could not verify this certificate' }),
    ).toBeVisible();
    await visitor.close();
  });
});

test.describe('certification access', () => {
  test('a certified representative sees their certificate and can share its verification link', async ({
    page,
  }) => {
    await signIn(page, 'ashlyn.pierce@a5roofing.example');
    await page.goto('/certifications');
    await expect(page.getByRole('heading', { level: 1, name: 'Certifications' })).toBeVisible();
    await expect(page.getByText(CERTIFICATION).first()).toBeVisible();
    await page.getByRole('button', { name: 'Share' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('textbox', { name: 'Verification link' })).toHaveValue(
      /\/verify\/[A-Za-z0-9_-]{32,64}$/,
    );
    await expect(dialog.getByRole('img', { name: /QR code/ })).toBeVisible();
  });

  test('a representative has no certification center', async ({ page }) => {
    await signIn(page, accounts.rep);
    await page.goto('/certification-center');
    await expect(page.getByText("You don't have access")).toBeVisible();
  });

  test('a manager sees their team and approvals but not the template designer', async ({
    page,
  }) => {
    await signIn(page, accounts.manager);
    await page.goto('/certification-center/team');
    await expect(
      page.getByRole('heading', { level: 1, name: 'Team certifications' }),
    ).toBeVisible();
    const nav = page.getByRole('navigation', { name: 'Certification center' });
    await expect(nav.getByRole('link', { name: /Approvals/ })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Templates' })).toHaveCount(0);
    await page.goto('/certification-center/templates');
    await expect(page.getByText("You don't have access to this page")).toBeVisible();
  });
});
