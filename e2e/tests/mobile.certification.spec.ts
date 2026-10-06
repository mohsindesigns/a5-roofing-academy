import { expect, test } from '@playwright/test';
import { signIn } from './support';

async function expectNoHorizontalScroll(page: import('@playwright/test').Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow, 'the page does not scroll sideways').toBeLessThanOrEqual(1);
}

test('the public verification page fits a phone', async ({ page }) => {
  await page.goto(`/verify/${'x'.repeat(43)}`);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expectNoHorizontalScroll(page);
});

test('a representative reads their certifications on a phone', async ({ page }) => {
  await signIn(page, 'marcus.delgado@a5roofing.example');
  await page.goto('/certifications');
  await expect(page.getByRole('heading', { level: 1, name: 'Certifications' })).toBeVisible();
  await expect(page.getByText(/\d+ of \d+ complete/)).toBeVisible();
  await expectNoHorizontalScroll(page);
});

test('an administrator reaches the certification center on a phone', async ({ page }) => {
  await signIn(page, 'grant.holloway@a5roofing.example');
  await page.goto('/certification-center/issued');
  await expect(page.getByRole('heading', { level: 1, name: 'Issued certificates' })).toBeVisible();
  await expectNoHorizontalScroll(page);
});
