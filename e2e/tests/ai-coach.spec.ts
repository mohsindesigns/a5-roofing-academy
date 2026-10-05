import { expect, test, type Page } from '@playwright/test';
import { accounts, signIn } from './support';

/**
 * AI objection trainer, end to end against the development simulator (no AI provider keys):
 * the simulator answers with scripted replies and scores, which is what these tests rely on.
 * Needs the seeded stack (`pnpm dev` after `pnpm db:seed`); the AI service must not have
 * ANTHROPIC_API_KEY / OPENAI_API_KEY set, or the "Simulated homeowner" assertions fail.
 */

const SCENARIO = 'Just Leave Your Card'; // beginner, 8 turns
const conversation = (page: Page) => page.getByRole('list', { name: 'Conversation' });
const messages = (page: Page) => conversation(page).getByRole('listitem');

async function say(page: Page, text: string) {
  const before = await messages(page).count();
  await page.getByLabel('Your response to the homeowner').fill(text);
  await page.getByRole('button', { name: 'Send message' }).click();
  // The learner's message, then the homeowner's saved reply.
  await expect(messages(page)).toHaveCount(before + 2);
}

/** Ends the conversation from the chat, whether the learner or the homeowner closes it. */
async function finish(page: Page) {
  const end = page.getByRole('button', { name: 'End session' });
  if (await end.isVisible()) {
    await end.click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'End and score' }).click();
  } else {
    await page.getByRole('link', { name: 'View scorecard' }).click();
  }
  await expect(page).toHaveURL(/\/scorecard$/);
}

async function startScenario(page: Page, title: string) {
  await page.goto('/ai-coach');
  await expect(page.getByRole('heading', { name: 'AI Coach' })).toBeVisible();
  const row = page.getByRole('listitem').filter({ hasText: title });
  await row.getByRole('button', { name: /^(Start|Practice again)$/ }).click();
  const dialog = page.getByRole('dialog', { name: title });
  await expect(dialog.getByText('The situation')).toBeVisible();
  await dialog.getByRole('button', { name: 'Start conversation' }).click();
  await expect(page).toHaveURL(/\/ai-coach\/sessions\/[0-9a-f-]{36}$/);
}

test.describe('AI coach: learner', () => {
  test('practices an objection and reads the scorecard', async ({ page }) => {
    await signIn(page, accounts.rep);
    await startScenario(page, SCENARIO);

    await expect(page.getByRole('heading', { name: SCENARIO })).toBeVisible();
    await expect(page.getByText('Simulated homeowner')).toBeVisible();
    await expect(page.getByText('Turn 0 of 8')).toBeVisible();
    // The homeowner opens the conversation.
    await expect(messages(page)).toHaveCount(1);

    await say(
      page,
      "Hi, I'm with A5 Roofing. I know you're short on time, so I'll be quick: would a two minute chat about your roof work, or is there a better time today?",
    );
    await expect(page.getByText('Turn 1 of 8')).toBeVisible();
    await say(page, 'What have you noticed on the roof since the April hailstorm?');
    await say(
      page,
      'That makes sense. Could I take pictures of the exterior Thursday after 6 and show you what I find?',
    );
    await expect(page.getByText('Turn 3 of 8')).toBeVisible();

    await finish(page);
    await expect(page.getByRole('heading', { name: 'Scorecard' })).toBeVisible();
    // Scoring is asynchronous: the page waits and swaps in the result.
    const result = page.getByRole('region', { name: 'Overall score' });
    await expect(result).toBeVisible({ timeout: 60_000 });
    const score = Number(
      await result.getByRole('meter', { name: 'Overall score' }).getAttribute('aria-valuenow'),
    );
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(100);
    await expect(result.getByText(/Pass mark \d+\./)).toBeVisible();
    await expect(result.getByText(/^(Passed|Below the pass mark)$/)).toBeVisible();
    await expect(page.getByText('Scored by the development simulator')).toBeVisible();

    // Criteria show their reasoning on demand.
    const criteria = page
      .getByRole('heading', { name: 'How you scored' })
      .locator('xpath=ancestor::section');
    const first = criteria.locator('details').first();
    await first.locator('summary').click();
    await expect(first.locator('p').first()).toBeVisible();
    await expect(criteria.getByRole('meter')).not.toHaveCount(0);

    // The transcript is on the page and holds what the learner said.
    await expect(page.getByRole('list', { name: 'Transcript' })).toContainText(
      'What have you noticed',
    );

    // Try again starts a fresh conversation on the same scenario.
    await result.getByRole('button', { name: 'Try again' }).click();
    await expect(page).toHaveURL(/\/ai-coach\/sessions\/[0-9a-f-]{36}$/);
    await expect(page.getByRole('heading', { name: SCENARIO })).toBeVisible();
    await expect(page.getByText('Turn 0 of 8')).toBeVisible();

    // The finished conversation is in the history with its score.
    await page.goto('/ai-coach?tab=history');
    const history = page.getByRole('table', { name: /practice conversations/ });
    await expect(history).toBeVisible();
    await expect(
      history
        .getByRole('row')
        .filter({ hasText: SCENARIO })
        .filter({ hasText: /Passed|Below pass mark|Scoring/ })
        .first(),
    ).toBeVisible();
    // The conversation started by "Try again" is still open and can be continued.
    await expect(history.getByRole('row').filter({ hasText: 'In progress' }).first()).toContainText(
      'Continue',
    );
  });

  test('keeps the conversation when the connection drops mid-reply', async ({ page }) => {
    await signIn(page, accounts.rep);
    await startScenario(page, SCENARIO);

    // The server completes and saves the turn, but the browser never receives the stream.
    let intercepted = 0;
    await page.route(
      '**/api/v1/ai/sessions/*/messages',
      async (route) => {
        intercepted++;
        await route.fetch();
        await route.abort('connectionreset');
      },
      { times: 1 },
    );
    const text = 'Quick question before I go: what is the best time today?';
    const before = await messages(page).count();
    await page.getByLabel('Your response to the homeowner').fill(text);
    await page.getByRole('button', { name: 'Send message' }).click();

    // Recovery reads the saved session: the reply appears and the message is not sent twice.
    await expect(messages(page)).toHaveCount(before + 2, { timeout: 20_000 });
    await expect(conversation(page).getByText(text)).toHaveCount(1);
    await expect(page.getByText('Turn 1 of 8')).toBeVisible();
    expect(intercepted).toBe(1);

    // And the conversation carries on normally afterwards.
    await say(page, 'I appreciate you hearing me out.');
  });

  test('sending works from a phone-sized screen with the composer above the tab bar', async ({
    browser,
  }) => {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      isMobile: true,
    });
    const page = await context.newPage();
    await signIn(page, accounts.rep);
    await startScenario(page, SCENARIO);

    const input = page.getByLabel('Your response to the homeowner');
    const bar = page.getByRole('navigation', { name: 'Primary' });
    const inputBox = (await input.boundingBox())!;
    const barBox = (await bar.boundingBox())!;
    expect(inputBox.y + inputBox.height).toBeLessThanOrEqual(barBox.y);

    // On touch screens Enter adds a line; only the send button sends.
    await input.fill('First line');
    await input.press('Enter');
    await expect(messages(page)).toHaveCount(1);
    await input.pressSequentially('second line');
    await page.getByRole('button', { name: 'Send message' }).tap();
    await expect(messages(page)).toHaveCount(3);
    await expect(conversation(page).getByText(/First line\s+second line/)).toBeVisible();
    await context.close();
  });

  test('cannot open someone else’s conversation', async ({ page }) => {
    await signIn(page, accounts.rep);
    await page.goto('/ai-coach/sessions/00000000-0000-7000-8000-000000000000/scorecard');
    await expect(page.getByText('This scorecard is not available')).toBeVisible();
  });
});

test.describe('AI scenarios: authoring', () => {
  test('a trainer test-runs a scenario and sees it marked as a test', async ({ page }) => {
    await signIn(page, accounts.trainingAdmin);
    await page.goto('/content/ai-scenarios');
    await expect(page.getByRole('heading', { name: 'AI scenarios' })).toBeVisible();
    await page.getByRole('link', { name: 'Three Estimates' }).first().click();
    await expect(page.getByRole('heading', { name: 'Three Estimates' })).toBeVisible();

    await page.getByRole('tab', { name: 'Test run' }).click();
    await page.getByRole('button', { name: 'Start test run' }).click();

    await expect(page).toHaveURL(/\/ai-coach\/sessions\/[0-9a-f-]{36}$/);
    await expect(page.getByText('Test run', { exact: true })).toBeVisible();
    await say(page, 'Totally fair to compare. What matters most to you in a written estimate?');
    await finish(page);
    await expect(page.getByText('Test run', { exact: true })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Overall score' })).toBeVisible({
      timeout: 60_000,
    });
    await page.getByRole('link', { name: 'Back to scenario' }).click();
    await expect(page.getByRole('heading', { name: 'Three Estimates' })).toBeVisible();
  });

  test('compares prompt versions and reads the rubric editor', async ({ page }) => {
    await signIn(page, accounts.trainingAdmin);
    await page.goto('/content/ai-scenarios');
    await page.getByRole('link', { name: 'Three Estimates' }).first().click();
    await page.getByRole('tab', { name: /Prompt versions/ }).click();
    await expect(page.getByRole('heading', { name: 'History' })).toBeVisible();
    await expect(page.getByText('Current', { exact: true }).first()).toBeVisible();

    await page.goto('/content/ai-scenarios?tab=rubrics');
    await page.getByRole('table', { name: 'Rubrics' }).getByRole('link').first().click();
    await expect(page.getByRole('heading', { name: 'Criteria' })).toBeVisible();
    const weight = page.getByLabel(/^Weight/).first();
    await weight.fill('15');
    // Editing shows what publishing will do; nothing is saved until then.
    await expect(page.getByRole('region', { name: 'Unsaved changes' })).toContainText(
      'Publishing creates version',
    );
    await page.getByRole('button', { name: 'Discard' }).click();
    await expect(page.getByRole('region', { name: 'Unsaved changes' })).toHaveCount(0);
  });

  test('representatives cannot reach scenario authoring', async ({ page }) => {
    await signIn(page, accounts.rep);
    await expect(
      page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'AI scenarios' }),
    ).toHaveCount(0);
    await page.goto('/content/ai-scenarios');
    await expect(page.getByText("You don't have access to this page")).toBeVisible();
  });
});
