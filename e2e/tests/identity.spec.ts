import { expect, test } from '@playwright/test';
import { PASSWORD, accounts, apiAs, signIn, unique } from './support';

test.describe('authentication', () => {
  test('signs in and out', async ({ page }) => {
    await signIn(page, accounts.manager);
    await expect(page.getByRole('heading', { name: /Welcome back, Danielle/ })).toBeVisible();
    await page.getByRole('button', { name: 'Account menu' }).first().click();
    await page.getByRole('menuitem', { name: 'Sign out' }).click();
    await expect(page).toHaveURL(/\/login/);
    // The session cookie is gone: protected pages redirect to sign-in.
    await page.goto('/people');
    await expect(page).toHaveURL(/\/login\?next=%2Fpeople/);
  });

  test('explains a wrong password without revealing which field was wrong', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('Email').fill(accounts.rep);
    await page.locator('input[type="password"]').fill('not-the-password');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('alert')).toHaveText('The email or password is incorrect.');
  });

  test('keeps the session across a reload', async ({ page }) => {
    await signIn(page, accounts.admin);
    await page.goto('/people');
    await page.reload();
    await expect(page.getByRole('heading', { name: 'People' })).toBeVisible();
  });
});

test.describe('people administration', () => {
  test('an administrator invites a representative who activates their account', async ({ page, browser }) => {
    const first = 'Wesley';
    const last = unique('Tran');
    const email = `${first}.${last}@a5roofing.example`.toLowerCase();
    await signIn(page, accounts.admin);
    await page.goto('/people/new');
    await page.getByLabel('First name').fill(first);
    await page.getByLabel('Last name').fill(last);
    await page.getByLabel('Work email').fill(email);
    await page.getByLabel('Location').selectOption({ label: 'Dallas' });
    await page.getByText('Sales Representative', { exact: true }).click();
    await page.getByRole('button', { name: 'Add person' }).click();

    const link = page.getByLabel('Activation link');
    await expect(link).toBeVisible();
    const activationUrl = await link.inputValue();

    const invitee = await browser.newPage();
    await invitee.goto(activationUrl);
    await expect(invitee.getByRole('heading', { name: 'Activate your account' })).toBeVisible();
    await invitee.getByLabel('New password').fill('Valley-Flashing-77');
    await invitee.getByLabel('Confirm password').fill('Valley-Flashing-77');
    await invitee.getByRole('button', { name: 'Activate and continue' }).click();
    await expect(invitee.getByRole('heading', { name: `Welcome back, ${first}` })).toBeVisible();
    await invitee.close();

    await page.getByRole('button', { name: 'Done' }).click();
    await expect(page.getByRole('heading', { name: `${first} ${last}` })).toBeVisible();
    await page.reload();
    await expect(page.getByText('Active', { exact: true }).first()).toBeVisible();
  });

  test('validates duplicate email addresses inline', async ({ page }) => {
    await signIn(page, accounts.admin);
    await page.goto('/people/new');
    await page.getByLabel('First name').fill('Marcus');
    await page.getByLabel('Last name').fill('Duplicate');
    await page.getByLabel('Work email').fill(accounts.rep);
    await page.getByText('Sales Representative', { exact: true }).click();
    await page.getByRole('button', { name: 'Add person' }).click();
    await expect(page.getByRole('alert')).toContainText('Someone already uses this email address.');
  });
});

test.describe('authorization', () => {
  test('a manager only sees their own team', async ({ page }) => {
    await signIn(page, accounts.manager);
    await page.goto('/people');
    await expect(page.getByRole('link', { name: /Marcus Delgado/ })).toBeVisible();
    await expect(page.getByRole('link', { name: /Naomi Fischer/ })).toHaveCount(0);
    await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Roles & permissions' })).toHaveCount(0);
    await page.goto('/admin/roles');
    await expect(page.getByText("You don't have access to this page")).toBeVisible();
  });

  test('a representative cannot open administration pages', async ({ page }) => {
    await signIn(page, accounts.rep);
    for (const path of ['/people', '/admin/permissions', '/admin/settings']) {
      await page.goto(path);
      await expect(page.getByText("You don't have access to this page")).toBeVisible();
    }
  });

  test('removing a permission takes effect on the next request', async ({ page, browser, request }) => {
    const api = await apiAs(request, accounts.superAdmin);
    const roles = await api.get<{ items: Array<{ id: string; key: string; modifiedFromDefault: boolean }> }>('/roles');
    const auditorRole = roles.items.find((r) => r.key === 'auditor')!;
    if (auditorRole.modifiedFromDefault) await api.post(`/roles/${auditorRole.id}/reset`);
    await signIn(page, accounts.superAdmin);
    await page.goto('/admin/roles');
    await page.getByRole('link', { name: 'Auditor / Viewer' }).click();
    const viewUsers = page.getByRole('checkbox', { name: /View users/ }).first();

    const auditor = await browser.newPage();
    await signIn(auditor, accounts.auditor);
    await auditor.goto('/people');
    await expect(auditor.getByRole('heading', { name: 'People' })).toBeVisible();

    await page.getByText('View users', { exact: true }).click();
    await page.getByRole('button', { name: 'Save permissions' }).click();
    await expect(page.getByText('Permissions saved', { exact: true })).toBeVisible();

    await auditor.reload();
    await expect(auditor.getByText("You don't have access to this page")).toBeVisible();

    // Restore the default for other tests.
    await page.getByRole('button', { name: 'More actions' }).click();
    await page.getByRole('menuitem', { name: 'Reset to default' }).click();
    await page.getByRole('button', { name: 'Reset role' }).click();
    await expect(viewUsers).toBeChecked();
    await auditor.close();
  });
});

test('wrong passwords never echo the password', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Email').fill(accounts.trainer);
  await page.locator('input[type="password"]').fill(`${PASSWORD}x`);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.locator('body')).not.toContainText(`${PASSWORD}x`);
});
