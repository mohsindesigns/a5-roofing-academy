import { expect, type APIRequestContext, type Page } from '@playwright/test';

export const PASSWORD = process.env.SEED_PASSWORD ?? 'RidgeLine-2026!';

export const accounts = {
  superAdmin: 'priya.raman@a5roofing.example',
  admin: 'grant.holloway@a5roofing.example',
  trainingAdmin: 'shelby.hartman@a5roofing.example',
  manager: 'danielle.okafor@a5roofing.example',
  trainer: 'hector.villanueva@a5roofing.example',
  rep: 'marcus.delgado@a5roofing.example',
  auditor: 'ruth.abernathy@a5roofing.example',
} as const;

export async function signIn(page: Page, email: string, password = PASSWORD) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.locator('input[type="password"]').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).not.toHaveURL(/\/login/);
}

export function unique(prefix: string) {
  return `${prefix}${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
}

/**
 * Call the API directly for setup/teardown. Uses the isolated `request` fixture so the browser
 * page's cookies are not touched.
 */
export async function apiAs(request: APIRequestContext, email: string) {
  const res = await request.post('/api/v1/auth/login', { data: { email, password: PASSWORD } });
  const { accessToken } = (await res.json()) as { accessToken: string };
  const headers = { authorization: `Bearer ${accessToken}` };
  return {
    get: async <T>(path: string) => (await (await request.get(`/api/v1${path}`, { headers })).json()) as T,
    post: async <T>(path: string, data: unknown = {}) => (await (await request.post(`/api/v1${path}`, { headers, data })).json()) as T,
  };
}
