import { expect, test } from '@playwright/test';
import { accounts, signIn } from './support';

test.describe('team progress for a manager', () => {
  test('a manager sees their team, narrows it down and opens a person', async ({ page }) => {
    await signIn(page, accounts.manager);

    // Home carries the manager section next to the learner view.
    await expect(page.getByRole('heading', { name: 'Your team' })).toBeVisible();

    await page.getByRole('link', { name: 'Trainees', exact: true }).click();
    await expect(page).toHaveURL(/\/team/);
    await expect(page.getByRole('heading', { name: 'Team', exact: true })).toBeVisible();

    const table = page.getByRole('table', { name: 'Team progress' });
    await expect(table).toBeVisible();
    const people = table.getByRole('button', { name: /, open progress details$/ });
    await expect(people.first()).toBeVisible();
    const total = await people.count();
    expect(total).toBeGreaterThan(0);

    // Filters live in the URL, so a filtered view can be shared and survives a reload.
    await page.getByRole('switch', { name: 'Needs attention only' }).click();
    await expect(page).toHaveURL(/attention=true/);
    await page.reload();
    await expect(page.getByRole('switch', { name: 'Needs attention only' })).toBeChecked();
    await page.getByRole('switch', { name: 'Needs attention only' }).click();
    await expect(page).not.toHaveURL(/attention=/);

    // Search narrows the list to one person, then clearing it brings the team back.
    const firstLabel = (await people.first().getAttribute('aria-label')) ?? '';
    const firstName = firstLabel.replace(/, open progress details$/, '');
    await page
      .getByRole('searchbox', { name: 'Search people' })
      .fill(firstName.split(' ')[0] ?? firstName);
    await expect(page).toHaveURL(/q=/);
    await expect(
      table.getByRole('button', { name: `${firstName}, open progress details` }),
    ).toBeVisible();

    // The person opens in a drawer, the table stays where it was, and Escape returns to it.
    await table.getByRole('button', { name: `${firstName}, open progress details` }).click();
    const drawer = page.getByRole('dialog');
    await expect(drawer).toBeVisible();
    await expect(drawer.getByText(firstName).first()).toBeVisible();
    await expect(page).toHaveURL(/learner=/);
    await page.keyboard.press('Escape');
    await expect(drawer).toBeHidden();
    await expect(page).not.toHaveURL(/learner=/);
    await expect(table).toBeVisible();
  });

  test('a manager can read reports but not the audit log', async ({ page }) => {
    await signIn(page, accounts.manager);

    await page.goto('/reports');
    await expect(page.getByRole('heading', { name: 'Reports', exact: true })).toBeVisible();

    // The audit log is not in a manager's navigation, and the page refuses a direct visit.
    await expect(page.getByRole('link', { name: 'Audit log' })).toHaveCount(0);
    await page.goto('/admin/audit');
    await expect(page.getByText("You don't have access to this page")).toBeVisible();
    await expect(page.getByRole('table', { name: /Audit log entries/ })).toHaveCount(0);
  });
});

test.describe('audit log for an auditor', () => {
  test('lists entries, filters them and shows what an entry changed, with nothing to edit', async ({
    page,
  }) => {
    await signIn(page, accounts.auditor);

    await page.getByRole('link', { name: 'Audit log' }).first().click();
    await expect(page).toHaveURL(/\/admin\/audit/);
    await expect(page.getByRole('heading', { name: 'Audit log', exact: true })).toBeVisible();
    await expect(page.getByText(/cannot be edited or deleted/).first()).toBeVisible();

    const table = page.getByRole('table', { name: /Audit log entries/ });
    await expect(table).toBeVisible();
    const entries = table.getByRole('button', { name: /^Open details:/ });
    await expect(entries.first()).toBeVisible();

    // The log is read-only: no control on the page edits or removes an entry.
    const labels = (await page.getByRole('button').allTextContents()).join(' ');
    expect(labels).not.toMatch(/\b(Edit|Delete|Remove)\b/);

    // Filters go to the URL and narrow the list to the chosen resource type.
    const typeFilter = page.getByRole('combobox', { name: 'Resource type' });
    const option = typeFilter.locator('option:not([value=""])').first();
    const value = await option.getAttribute('value');
    expect(value).toBeTruthy();
    await typeFilter.selectOption(value!);
    await expect(page).toHaveURL(new RegExp(`resourceType=${value}`));
    await expect(entries.first()).toBeVisible();

    // An entry opens in a drawer with who, when and where it came from.
    await entries.first().click();
    const drawer = page.getByRole('dialog');
    await expect(drawer).toBeVisible();
    await expect(drawer.getByText(/cannot be edited or deleted/)).toBeVisible();
    await expect(drawer.getByRole('button', { name: /^(Edit|Delete|Remove)/ })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(drawer).toBeHidden();
  });

  test('exports the filtered log as a CSV file', async ({ page }) => {
    await signIn(page, accounts.auditor);
    await page.goto('/admin/audit');
    await expect(page.getByRole('table', { name: /Audit log entries/ })).toBeVisible();

    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export CSV' }).click();
    const file = await download;
    expect(file.suggestedFilename()).toMatch(/^audit-log.*\.csv$/);
    await expect(page.getByText('Export downloaded', { exact: true })).toBeVisible();
  });
});
