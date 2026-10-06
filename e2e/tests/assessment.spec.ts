import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { accounts, apiAs, signIn, unique } from './support';

/**
 * Assessment flows against a running stack.
 *
 * Each run builds its own learner, question set, assessment and program through the API, so the
 * seeded learners' attempts and progress are never touched and the spec can be repeated on the
 * same database. The assessment has unlimited attempts and no wait between them, which is what
 * lets one learner pass and fail in the same run.
 */

const LEARNER_PASSWORD = 'Valley-Flashing-77';

type Api = Awaited<ReturnType<typeof apiAs>>;

interface Fixture {
  learner: { id: string; email: string };
  programId: string;
  lessonId: string;
  assessmentId: string;
  assessmentTitle: string;
  questionIds: string[];
}

const id = (prefix: string, n: number) => `${prefix}${n}x${Math.random().toString(36).slice(2, 8)}`;

async function build(api: Api, tag: string): Promise<{ fixture: Fixture; activationUrl: string }> {
  const banks = await api.get<{ items: Array<{ id: string; archived: boolean }> }>(
    '/question-banks',
  );
  const bank = banks.items.find((b) => !b.archived);
  if (!bank) throw new Error('Seed a question bank first (pnpm db:seed)');

  const prompts = {
    choice: `${tag}: Who must say yes before a photo report is shared?`,
    select: `${tag}: Which of these are signs of hail damage?`,
    trueFalse: `${tag}: A contractor may waive a homeowner's deductible.`,
    short: `${tag}: What is the document that shows inspection photos called?`,
    ordering: `${tag}: Put the A5 customer journey in order.`,
    matching: `${tag}: Match each roof component to its job.`,
  };
  const optionId = (n: number) => id('o', n);
  const definitions = [
    {
      type: 'multiple_choice',
      prompt: prompts.choice,
      config: {
        options: [
          { id: optionId(1), text: 'The homeowner', correct: true },
          { id: optionId(2), text: 'The sales manager', correct: false },
          { id: optionId(3), text: 'The insurance adjuster', correct: false },
        ],
      },
    },
    {
      type: 'multiple_select',
      prompt: prompts.select,
      config: {
        scoring: 'all_or_nothing',
        options: [
          { id: optionId(1), text: 'Bruised shingles', correct: true },
          { id: optionId(2), text: 'Granule loss in a random pattern', correct: true },
          { id: optionId(3), text: 'Moss on the north slope', correct: false },
        ],
      },
    },
    { type: 'true_false', prompt: prompts.trueFalse, config: { correctAnswer: false } },
    {
      type: 'short_answer',
      prompt: prompts.short,
      config: {
        grading: 'auto',
        acceptedAnswers: ['Photo report'],
        caseSensitive: false,
        normalizeWhitespace: true,
        maxLength: 60,
      },
    },
    {
      type: 'ordering',
      prompt: prompts.ordering,
      config: {
        scoring: 'all_or_nothing',
        items: [
          { id: id('i', 1), text: 'Inspect' },
          { id: id('i', 2), text: 'Estimate' },
          { id: id('i', 3), text: 'Install' },
        ],
      },
    },
    {
      type: 'matching',
      prompt: prompts.matching,
      config: {
        scoring: 'all_or_nothing',
        pairs: [
          {
            leftId: id('l', 1),
            left: 'Underlayment',
            rightId: id('r', 1),
            right: 'Secondary water barrier',
          },
          {
            leftId: id('l', 2),
            left: 'Flashing',
            rightId: id('r', 2),
            right: 'Directs water at joints',
          },
        ],
      },
    },
  ];
  const questionIds: string[] = [];
  for (const def of definitions) {
    const q = await api.post<{ id: string }>('/questions', {
      ...def,
      bankId: bank.id,
      points: 1,
      difficulty: 'easy',
      tags: ['e2e'],
    });
    questionIds.push(q.id);
  }

  const assessmentTitle = `${tag} Knowledge Check`;
  const assessment = await api.post<{ id: string }>('/assessments', {
    title: assessmentTitle,
    kind: 'quiz',
    config: {
      passingPercent: 70,
      maxAttempts: null,
      timeLimitSeconds: 1800,
      retryCooldownMinutes: 0,
      randomizeQuestions: false,
      randomizeOptions: false,
      revealCorrectAnswers: 'after_submit',
      revealScore: true,
      notifyManagerOn: [],
      allowStandalone: false,
    },
  });
  for (const questionId of questionIds)
    await api.post(`/assessments/${assessment.id}/items`, { kind: 'question', questionId });
  await api.post(`/assessments/${assessment.id}/publish`);

  const program = await api.post<{ id: string }>('/programs', {
    title: `${tag} Program`,
    summary: 'End-to-end assessment fixture.',
  });
  const withPhase = await api.post<{ phases: Array<{ id: string; title: string }> }>(
    `/programs/${program.id}/phases`,
    { title: 'Week 1' },
  );
  const phase = withPhase.phases.find((p) => p.title === 'Week 1')!;
  const withModule = await api.post<{
    phases: Array<{ id: string; modules: Array<{ id: string; title: string }> }>;
  }>(`/programs/${program.id}/modules`, {
    phaseId: phase.id,
    title: 'Customer trust',
  });
  const module = withModule.phases
    .find((p) => p.id === phase.id)!
    .modules.find((m) => m.title === 'Customer trust')!;
  const lesson = await api.post<{ id: string }>('/lessons', {
    moduleId: module.id,
    type: 'quiz',
    title: `${tag} Quiz`,
    config: { assessmentId: assessment.id },
    isRequired: true,
    estimatedMinutes: 5,
  });
  await api.post(`/programs/${program.id}/publish`, {
    changeNote: 'Assessment end-to-end fixture',
  });

  const roles = await api.get<{ items: Array<{ id: string; key: string }> }>('/roles');
  const salesRep = roles.items.find((r) => r.key === 'sales_rep')!;
  const firstName = 'Quinn';
  const lastName = unique('Taker');
  const email = `${firstName}.${lastName}@a5roofing.example`.toLowerCase();
  const created = await api.post<{ user: { id: string }; activationUrl: string | null }>('/users', {
    email,
    firstName,
    lastName,
    roleIds: [salesRep.id],
    sendInvitation: true,
  });
  if (!created.activationUrl)
    throw new Error(
      'The stack must expose activation links (EXPOSE_ACTIVATION_LINKS=true in development)',
    );
  await api.post('/enrollments', { programId: program.id, userIds: [created.user.id] });

  return {
    fixture: {
      learner: { id: created.user.id, email },
      programId: program.id,
      lessonId: lesson.id,
      assessmentId: assessment.id,
      assessmentTitle,
      questionIds,
    },
    activationUrl: created.activationUrl,
  };
}

async function activate(page: Page, activationUrl: string) {
  await page.goto(activationUrl);
  await page.getByLabel('New password').fill(LEARNER_PASSWORD);
  await page.getByLabel('Confirm password').fill(LEARNER_PASSWORD);
  await page.getByRole('button', { name: 'Activate and continue' }).click();
  await expect(page.getByRole('heading', { name: /Welcome back/ })).toBeVisible();
}

async function cleanup(api: Api, f: Fixture) {
  const quietly = async (run: () => Promise<unknown>) => {
    try {
      await run();
    } catch {
      // Cleanup is best effort: a leftover draft never affects another run.
    }
  };
  await quietly(() => api.post(`/programs/${f.programId}/archive`));
  await quietly(() => api.post(`/assessments/${f.assessmentId}/archive`));
  for (const questionId of f.questionIds)
    await quietly(() => api.post(`/questions/${questionId}/archive`));
  await quietly(() =>
    api.post(`/users/${f.learner.id}/deactivate`, { reason: 'End-to-end fixture cleanup' }),
  );
}

// ------------------------------------------------------------------ learner

async function openAssessment(page: Page, f: Fixture) {
  await signIn(page, f.learner.email, LEARNER_PASSWORD);
  await page.goto(`/training/${f.programId}/lessons/${f.lessonId}`);
  await page.getByRole('link', { name: /^(Start|Open)$/ }).click();
  await expect(page.getByRole('heading', { name: f.assessmentTitle })).toBeVisible();
}

async function saved(page: Page) {
  await expect(page.getByText('Saved', { exact: true })).toBeVisible();
}

async function next(page: Page, n: number) {
  await page.getByRole('button', { name: /Next/ }).click();
  await expect(page.getByRole('heading', { name: `Question ${n} of 6` })).toBeVisible();
}

/**
 * Answer all six questions, correctly or with the wrong choice for every one.
 *
 * Choices are native radios and checkboxes hidden visually behind a styled label, so they are
 * checked with `force` (the label receives the click for a real person).
 */
async function answerAll(page: Page, correct: boolean) {
  await expect(page.getByRole('heading', { name: 'Question 1 of 6' })).toBeVisible();
  await page
    .getByRole('radio', { name: correct ? 'The homeowner' : 'The sales manager' })
    .check({ force: true });
  await saved(page);

  await next(page, 2);
  await page.getByRole('checkbox', { name: 'Bruised shingles' }).check({ force: true });
  await page
    .getByRole('checkbox', {
      name: correct ? 'Granule loss in a random pattern' : 'Moss on the north slope',
    })
    .check({ force: true });
  await saved(page);

  await next(page, 3);
  await page.getByRole('radio', { name: correct ? 'False' : 'True' }).check({ force: true });
  await saved(page);

  await next(page, 4);
  await page.getByRole('textbox').fill(correct ? 'photo report' : 'brochure');
  await saved(page);

  await next(page, 5);
  const target = correct ? ['Inspect', 'Estimate', 'Install'] : ['Install', 'Estimate', 'Inspect'];
  for (const [position, text] of target.entries()) {
    const items = await page
      .getByRole('listitem')
      .filter({ has: page.getByRole('button', { name: /^Move .* up$/ }) })
      .allTextContents();
    const current = items.findIndex((t) => t.includes(text));
    for (let i = 0; i < current - position; i += 1)
      await page.getByRole('button', { name: `Move ${text} up` }).click();
  }
  await saved(page);

  await next(page, 6);
  await page
    .getByRole('combobox', { name: 'Underlayment' })
    .selectOption({ label: correct ? 'Secondary water barrier' : 'Directs water at joints' });
  await page
    .getByRole('combobox', { name: 'Flashing' })
    .selectOption({ label: correct ? 'Directs water at joints' : 'Secondary water barrier' });
  await saved(page);
}

async function submit(page: Page) {
  await page.getByRole('button', { name: /Review and submit/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Submit your answers?' });
  await expect(dialog).toContainText('You have answered 6 of 6 questions');
  await dialog.getByRole('button', { name: 'Submit answers' }).click();
  await expect(page.getByRole('heading', { name: 'Your result' })).toBeVisible();
}

test.describe('assessments', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(120_000);

  let api: Api;
  let request: APIRequestContext;
  let fixture: Fixture;

  test.beforeAll(async ({ playwright, browser }, info) => {
    test.setTimeout(180_000);
    const baseURL = info.project.use.baseURL;
    request = await playwright.request.newContext({ baseURL });
    api = await apiAs(request, accounts.admin);
    const built = await build(api, unique('E2E'));
    fixture = built.fixture;
    const learnerPage = await browser.newPage({ baseURL });
    await activate(learnerPage, built.activationUrl);
    await learnerPage.close();
  });

  test.afterAll(async () => {
    if (api && fixture) await cleanup(api, fixture);
    await request?.dispose();
  });

  test('a learner takes the quiz, answers every question type, and passes', async ({ page }) => {
    await openAssessment(page, fixture);
    // The rules shown come from the assessment's configuration.
    const rules = page.getByRole('complementary').filter({ hasText: 'Before you begin' });
    await expect(rules).toContainText('70%');
    await expect(rules).toContainText('30 minutes');
    await expect(rules).toContainText('Unlimited');

    await page.getByRole('button', { name: 'Start attempt' }).click();
    await expect(page.getByRole('timer', { name: 'Time remaining' })).toBeVisible();
    await answerAll(page, true);
    await expect(
      page.getByRole('progressbar', { name: '6 of 6 questions answered' }),
    ).toBeVisible();
    await submit(page);

    await expect(page.getByText('Passed', { exact: true })).toBeVisible();
    await expect(page.getByRole('img', { name: 'Score 100%, pass mark 70%' })).toBeVisible();
    // Reveal policy "after submit": the key and the learner's own answers are shown.
    await expect(page.getByRole('list', { name: 'Question results' })).toContainText(
      'Secondary water barrier',
    );
    await expect(page.getByRole('button', { name: 'Try again' })).toHaveCount(0);
  });

  test('a failed attempt offers a retake, and the next attempt starts from scratch', async ({
    page,
  }) => {
    await openAssessment(page, fixture);
    // Attempt 1 is already on record from the previous test.
    await expect(page.getByRole('table', { name: 'Your attempts' })).toContainText('Passed');
    await page.getByRole('button', { name: 'Start another attempt' }).click();
    await answerAll(page, false);
    await submit(page);

    await expect(page.getByText('Not passed', { exact: true })).toBeVisible();
    await expect(page.getByText(/You did not reach the passing score of 70%/)).toBeVisible();
    await expect(page.getByText(/Unlimited attempts/)).toBeVisible();
    await page.getByRole('button', { name: 'Try again' }).click();
    await expect(page.getByRole('heading', { name: 'Question 1 of 6' })).toBeVisible();
    await expect(
      page.getByRole('progressbar', { name: '0 of 6 questions answered' }),
    ).toBeVisible();
  });

  test('answers survive a reload and the attempt resumes where the learner stopped', async ({
    page,
  }) => {
    await openAssessment(page, fixture);
    // The previous test left attempt 3 open.
    await expect(page.getByText(/Attempt 3 is in progress/)).toBeVisible();
    await page.getByRole('button', { name: /Resume attempt 3/ }).click();
    await expect(page.getByRole('heading', { name: 'Question 1 of 6' })).toBeVisible();
    await page.getByRole('radio', { name: 'The homeowner' }).check({ force: true });
    await saved(page);
    await page.reload();
    // Back on the first unanswered question, with the first answer still in place.
    await expect(page.getByRole('heading', { name: 'Question 2 of 6' })).toBeVisible();
    await page.getByRole('button', { name: 'Question 1, answered' }).click();
    await expect(page.getByRole('radio', { name: 'The homeowner' })).toBeChecked();
  });

  test('submitting asks for confirmation and lists what is still unanswered', async ({ page }) => {
    await openAssessment(page, fixture);
    await page.getByRole('button', { name: /Resume attempt 3/ }).click();
    await page.getByRole('button', { name: 'Submit answers' }).click();
    const dialog = page.getByRole('dialog', { name: 'Submit your answers?' });
    await expect(dialog).toContainText('You have answered 1 of 6 questions');
    await expect(dialog.getByRole('button', { name: /^Question \d$/ })).toHaveCount(5);
    await dialog.getByRole('button', { name: 'Question 4' }).click();
    await expect(page.getByRole('heading', { name: 'Question 4 of 6' })).toBeVisible();
  });
});

// ------------------------------------------------------------------ content management and review

test.describe('assessment content', () => {
  test.setTimeout(120_000);

  test('a training administrator filters the bank through the URL and saves a new question version', async ({
    page,
    playwright,
  }, info) => {
    const request = await playwright.request.newContext({ baseURL: info.project.use.baseURL });
    const api = await apiAs(request, accounts.admin);
    const tag = unique('Edit');
    const banks = await api.get<{ items: Array<{ id: string; archived: boolean }> }>(
      '/question-banks',
    );
    const bank = banks.items.find((b) => !b.archived)!;
    const created = await api.post<{ id: string }>('/questions', {
      bankId: bank.id,
      type: 'true_false',
      prompt: `${tag}: Every roof gets a photo report.`,
      config: { correctAnswer: true },
      points: 1,
      difficulty: 'hard',
      tags: ['e2e'],
    });
    try {
      await signIn(page, accounts.trainingAdmin);
      await page.goto('/content/questions?type=true_false&difficulty=hard');
      await expect(page.getByRole('combobox', { name: 'Question type' })).toHaveValue('true_false');
      await expect(page.getByRole('combobox', { name: 'Difficulty' })).toHaveValue('hard');
      await page.getByRole('searchbox', { name: 'Search questions' }).fill(tag);
      await expect(page).toHaveURL(new RegExp(`q=${tag}`));
      await page.getByRole('link', { name: new RegExp(tag) }).click();

      await expect(page.getByText('Version 1')).toBeVisible();
      await page
        .getByRole('textbox', { name: /Question text/ })
        .fill(`${tag}: Every roof inspection gets a photo report.`);
      await page.getByRole('textbox', { name: /What changed/ }).fill('Clearer wording');
      await page.getByRole('button', { name: 'Save as version 2' }).click();
      await expect(page.getByText('Saved as version 2', { exact: true })).toBeVisible();

      await page.getByRole('tab', { name: /Versions/ }).click();
      const versions = page.getByRole('list', { name: 'Versions' });
      await expect(versions.getByRole('listitem')).toHaveCount(2);
      await expect(versions).toContainText('Clearer wording');
      await expect(versions).toContainText('Current');
    } finally {
      await api.post(`/questions/${created.id}/archive`).catch(() => undefined);
      await request.dispose();
    }
  });

  test('the assessment builder lists a published assessment and never offers to publish it again', async ({
    page,
  }) => {
    await signIn(page, accounts.trainingAdmin);
    await page.goto('/content/assessments');
    await page
      .getByRole('link', { name: /Week 1 Knowledge Check/ })
      .first()
      .click();
    await expect(page.getByRole('heading', { name: 'Week 1 Knowledge Check' })).toBeVisible();
    await expect(page.getByText('Published', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Publish' })).toHaveCount(0);
    await page.getByRole('tab', { name: 'Settings' }).click();
    await expect(page.getByRole('spinbutton', { name: /Pass mark/ })).toHaveValue('80');
    await expect(page.getByRole('spinbutton', { name: /Minutes allowed/ })).toHaveValue('20');
  });

  test('a manager can follow attempts but not edit content, and a representative sees neither', async ({
    page,
    browser,
  }, info) => {
    await signIn(page, accounts.manager);
    await page.goto('/content/assessments');
    await expect(page).toHaveURL(/\/content\/assessments\/attempts$/);
    await expect(page.getByRole('heading', { name: 'Attempts' })).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'Assessment' })).toHaveCount(0);
    await page.goto('/content/questions');
    await expect(page.getByText("You don't have access to this page")).toBeVisible();

    const rep = await browser.newPage({ baseURL: info.project.use.baseURL });
    await signIn(rep, accounts.rep);
    for (const path of [
      '/content/assessments',
      '/content/questions',
      '/content/assessments/attempts',
    ]) {
      await rep.goto(path);
      await expect(rep.getByText("You don't have access to this page")).toBeVisible();
    }
    await rep.close();
  });
});
