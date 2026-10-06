import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { accounts, signIn } from './support';

/** Press the shortcut once the shell (and so its key listener) has mounted; retry if the first press was early. */
async function openPalette(page: Page) {
  await expect(
    page.locator('button[aria-keyshortcuts="Control+K Meta+K"]:visible').first(),
  ).toBeVisible();
  const dialog = page.getByRole('dialog', { name: 'Search' });
  await expect(async () => {
    await page.keyboard.press('Control+k');
    await expect(dialog).toBeVisible({ timeout: 1500 });
  }).toPass({ timeout: 10_000 });
  return dialog;
}

// These checks only read data, so they are safe to run against a shared seeded stack.

test.describe('content administration', () => {
  test('a training administrator opens a program and reaches its structure with the keyboard', async ({
    page,
  }) => {
    await signIn(page, accounts.trainingAdmin);
    await page.goto('/content/programs');
    await expect(page.getByRole('heading', { name: 'Programs', exact: true })).toBeVisible();

    const programs = page.getByRole('table', { name: 'Programs' });
    await expect(programs).toBeVisible();
    await programs.getByRole('link').first().click();
    await expect(page).toHaveURL(/\/content\/programs\/[0-9a-f-]+/);

    // The builder shows the week and lesson tree, and every row has a button alternative to dragging.
    await expect(page.getByRole('tab', { name: 'Structure' })).toBeVisible();
    const weeks = page.getByRole('region', { name: /^Week \d+/ });
    await expect(weeks.first()).toBeVisible();
    // The first item cannot move up, so that button is disabled rather than hidden.
    const moveButtons = weeks.first().getByRole('button', { name: /^Move .+ (up|down)$/ });
    await expect(moveButtons.first()).toBeVisible();
    await expect(moveButtons.first()).toBeDisabled();
    const movable = moveButtons.and(page.locator(':enabled')).first();
    await movable.focus();
    await expect(movable).toBeFocused();

    // The other tabs load their own data.
    await page.getByRole('tab', { name: 'Versions' }).click();
    await expect(page.getByRole('tab', { name: 'Versions' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await page.getByRole('tab', { name: 'Audience and enrollment' }).click();
    await expect(page.getByRole('tab', { name: 'Audience and enrollment' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });

  test('the media library lists assets with their processing state', async ({ page }) => {
    await signIn(page, accounts.trainingAdmin);
    await page.goto('/content/media');
    await expect(page.getByRole('heading', { name: 'Media library', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: /Upload/ }).first()).toBeVisible();
    // An empty library is a valid state on a fresh stack; either way the page explains itself.
    await expect(
      page.getByRole('table', { name: 'Media library' }).or(page.getByText('The library is empty')),
    ).toBeVisible();
  });

  test('an administrator reaches the notification templates, rules and delivery log', async ({
    page,
  }) => {
    await signIn(page, accounts.admin);
    await page.goto('/admin/notifications');
    await expect(page.getByRole('heading', { name: 'Notifications', exact: true })).toBeVisible();
    for (const name of ['Templates', 'Rules', 'Delivery log']) {
      await page.getByRole('tab', { name }).click();
      await expect(page.getByRole('tab', { name })).toHaveAttribute('aria-selected', 'true');
    }
  });
});

test.describe('global search', () => {
  test('Ctrl+K opens the palette, filters pages and navigates with the keyboard', async ({
    page,
  }) => {
    await signIn(page, accounts.manager);
    const dialog = await openPalette(page);
    await dialog.getByRole('combobox').fill('team');
    await expect(dialog.getByRole('option', { name: 'Team', exact: true })).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/team/);
    await expect(dialog).toBeHidden();
  });

  test('the palette only offers pages the role may open', async ({ page }) => {
    await signIn(page, accounts.rep);
    const dialog = await openPalette(page);
    await expect(dialog.getByRole('option', { name: 'Audit log' })).toHaveCount(0);
    await expect(dialog.getByRole('option', { name: 'Reports' })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  });
});
