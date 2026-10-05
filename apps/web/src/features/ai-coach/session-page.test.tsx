import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  controlledSse,
  event,
  json,
  meHandler,
  mockApi,
  renderRoute,
  sseResponse,
} from '@/test/render';
import { SessionPage } from './session-page';
import { message, session } from './test-fixtures';

beforeAll(() => {
  // jsdom does not implement scrolling.
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => vi.restoreAllMocks());

const opening = message(1, 'homeowner', "Oh, hi. Look, I really don't have time right now.");
const sentText = 'I know you are short on time. Is there a better time today?';
const rep = message(2, 'rep', sentText);
const reply = message(3, 'homeowner', 'Look, just leave your card.');

function brief(scenarioId: string) {
  return {
    id: scenarioId,
    title: 'The Busy Homeowner',
    category: 'Brush-off',
    difficulty: 'beginner',
    objection: "I don't have time.",
    persona: { name: 'Busy homeowner', description: 'Always mid-task.' },
    passingScore: 75,
    maxTurns: 10,
    myStats: { attempts: 0, bestScore: null, passed: false, lastPracticedAt: null },
    repBrief: 'It is a weekday around 5:15 p.m.',
    scoredOn: [{ key: 'discovery', label: 'Discovery' }],
  };
}

function setup(
  initial = session({ messages: [opening] }),
  extra: Parameters<typeof mockApi>[0] = {},
) {
  const api = mockApi({
    'GET /auth/me': meHandler(['ai_practice.use']),
    [`GET /ai/sessions/${initial.id}`]: () => initial,
    [`GET /ai/practice/scenarios/${initial.scenario.id}`]: () => brief(initial.scenario.id),
    ...extra,
  });
  const view = renderRoute(<SessionPage />, {
    route: `/ai-coach/sessions/${initial.id}`,
    path: '/ai-coach/sessions/:id',
  });
  return { api, initial, ...view };
}

const input = () => screen.findByLabelText('Your response to the homeowner');
const announcer = () => screen.getByTestId('chat-announcer');
const doneEvent = (over = {}) =>
  event('done', {
    messageId: reply.id,
    message: reply,
    sessionEnded: false,
    endReason: null,
    status: 'active',
    turnCount: 1,
    turnsRemaining: 9,
    ...over,
  });

describe('practice conversation', () => {
  it('shows the sent message at once, streams the reply and announces it only when complete', async () => {
    const user = userEvent.setup();
    const stream = controlledSse();
    const s = session({ messages: [opening] });
    const { api } = setup(s, { [`POST /ai/sessions/${s.id}/messages`]: () => stream.response });

    await user.type(await input(), sentText);
    await user.click(screen.getByRole('button', { name: 'Send message' }));

    // Optimistic: visible before the server has said anything.
    expect(screen.getByText(sentText)).toBeInTheDocument();
    await waitFor(() => expect(api.callsTo(`POST /ai/sessions/${s.id}/messages`)).toHaveLength(1));
    const body = api.callsTo(`POST /ai/sessions/${s.id}/messages`)[0]!.body as {
      text: string;
      clientMessageId: string;
    };
    expect(body.text).toBe(sentText);
    expect(body.clientMessageId).toMatch(/^[0-9a-f-]{36}$/);

    stream.push(event('accepted', { repMessage: rep, retried: false }));
    await waitFor(() => expect(screen.getByText('Turn 1 of 10')).toBeInTheDocument());
    stream.push(event('delta', { text: 'Look, ' }));
    stream.push(event('delta', { text: 'just leave' }));
    await screen.findByText('Look, just leave');
    // Words are not read out one at a time.
    expect(announcer()).toHaveTextContent('The homeowner is replying.');
    expect(announcer()).not.toHaveTextContent('just leave');

    stream.push(event('delta', { text: ' your card.' }));
    stream.push(doneEvent());
    stream.close();

    await waitFor(() =>
      expect(announcer()).toHaveTextContent('Busy homeowner said: Look, just leave your card.'),
    );
    // The reply is now a saved message in the conversation list.
    const list = screen.getByRole('list', { name: 'Conversation' });
    expect(within(list).getByText('Look, just leave your card.')).toBeInTheDocument();
    expect(screen.getByText('Turn 1 of 10')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'End session' })).toBeEnabled();
  });

  it('holds back sending while the homeowner is replying, but keeps the field editable', async () => {
    const user = userEvent.setup();
    const stream = controlledSse();
    const s = session({ messages: [opening] });
    setup(s, { [`POST /ai/sessions/${s.id}/messages`]: () => stream.response });

    const field = await input();
    await user.type(field, sentText);
    await user.click(screen.getByRole('button', { name: 'Send message' }));
    stream.push(event('accepted', { repMessage: rep, retried: false }));

    await screen.findByText('Wait for the homeowner to finish replying.');
    expect(field).toBeEnabled();
    await user.type(field, 'Next message');
    expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'End session' })).toBeDisabled();
    stream.close();
  });

  it('recovers the saved reply after the connection drops, without sending anything twice', async () => {
    const user = userEvent.setup();
    const stream = controlledSse();
    const s = session({ messages: [opening] });
    let reads = 0;
    const { api } = setup(s, {
      [`POST /ai/sessions/${s.id}/messages`]: () => stream.response,
      [`GET /ai/sessions/${s.id}`]: () =>
        ++reads === 1
          ? s
          : session({ ...s, messages: [opening, rep, reply], turnCount: 1, awaitingReply: false }),
    });

    await user.type(await input(), sentText);
    await user.click(screen.getByRole('button', { name: 'Send message' }));
    stream.push(event('accepted', { repMessage: rep, retried: false }));
    stream.push(event('delta', { text: 'Look, ju' }));
    await screen.findByText('Look, ju');
    stream.fail(new TypeError('network error'));

    await screen.findByText(/Connection interrupted/);
    const list = screen.getByRole('list', { name: 'Conversation' });
    await waitFor(
      () => expect(within(list).getByText('Look, just leave your card.')).toBeInTheDocument(),
      { timeout: 4000 },
    );
    expect(screen.queryByText(/Connection interrupted/)).not.toBeInTheDocument();
    expect(within(list).queryByText('Look, ju')).not.toBeInTheDocument();
    expect(api.callsTo(`POST /ai/sessions/${s.id}/messages`)).toHaveLength(1);
  });

  it('offers to fetch the reply when the homeowner could not answer, then asks only for the reply', async () => {
    const user = userEvent.setup();
    const s = session({ messages: [opening] });
    const responses = [
      () =>
        sseResponse([
          event('accepted', { repMessage: rep, retried: false }),
          event('error', {
            code: 'AI_TURN_FAILED',
            message: 'The homeowner simulator is unavailable. Your conversation is saved — retry.',
            retryable: true,
          }),
        ]),
      () => sseResponse([event('accepted', { repMessage: rep, retried: true }), doneEvent()]),
    ];
    const { api } = setup(s, {
      [`POST /ai/sessions/${s.id}/messages`]: () => responses.shift()!(),
    });

    await user.type(await input(), sentText);
    await user.click(screen.getByRole('button', { name: 'Send message' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Your conversation is saved');
    // The learner's message stays, marked as delivered.
    expect(screen.getByText(sentText)).toBeInTheDocument();
    expect(screen.queryByText('Not sent')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Get reply' }));
    await screen.findByText('Look, just leave your card.');
    const calls = api.callsTo(`POST /ai/sessions/${s.id}/messages`);
    expect(calls.map((c) => c.body)).toEqual([
      { text: sentText, clientMessageId: expect.any(String) },
      { retry: true },
    ]);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('marks a message that was rejected as not sent and lets the learner edit it', async () => {
    const user = userEvent.setup();
    const s = session({ messages: [opening] });
    setup(s, {
      [`POST /ai/sessions/${s.id}/messages`]: () =>
        json(429, {
          error: { code: 'RATE_LIMITED', message: 'Too many requests. Wait a moment.' },
        }),
    });

    const field = await input();
    await user.type(field, sentText);
    await user.click(screen.getByRole('button', { name: 'Send message' }));

    await screen.findByText('Not sent');
    expect(screen.getByRole('alert')).toHaveTextContent('Too many requests');
    await user.click(screen.getByRole('button', { name: 'Edit message' }));
    expect(field).toHaveValue(sentText);
    expect(screen.queryByText('Not sent')).not.toBeInTheDocument();
  });

  it('shows the conversation ending when the homeowner closes it', async () => {
    const user = userEvent.setup();
    const s = session({ messages: [opening] });
    setup(s, {
      [`POST /ai/sessions/${s.id}/messages`]: () =>
        sseResponse([
          event('accepted', { repMessage: rep, retried: false }),
          doneEvent({ sessionEnded: true, endReason: 'objective_reached', status: 'ended' }),
        ]),
    });
    await user.type(await input(), sentText);
    await user.click(screen.getByRole('button', { name: 'Send message' }));

    await screen.findByText('Conversation ended');
    expect(screen.getByText(/homeowner agreed to a next step/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'View scorecard' })).toHaveAttribute(
      'href',
      `/ai-coach/sessions/${s.id}/scorecard`,
    );
    expect(screen.queryByLabelText('Your response to the homeowner')).not.toBeInTheDocument();
  });

  it('waits for a reply that was still being written when the page opened, without asking again', async () => {
    const s = session({ messages: [opening, rep], turnCount: 1, awaitingReply: true });
    let reads = 0;
    const { api } = setup(s, {
      [`GET /ai/sessions/${s.id}`]: () =>
        ++reads <= 1 ? s : session({ ...s, messages: [opening, rep, reply], awaitingReply: false }),
    });
    await screen.findByText(/Connection interrupted/);
    await waitFor(
      () => expect(screen.getByText('Look, just leave your card.')).toBeInTheDocument(),
      {
        timeout: 4000,
      },
    );
    expect(api.callsTo(`POST /ai/sessions/${s.id}/messages`)).toHaveLength(0);
  });

  it('ends the session after confirmation and opens the scorecard', async () => {
    const user = userEvent.setup();
    const s = session({ messages: [opening, rep, reply], turnCount: 1 });
    const { api } = setup(s, {
      [`POST /ai/sessions/${s.id}/end`]: () =>
        session({ ...s, status: 'ended', endReason: 'rep_ended' }),
    });

    await user.click(await screen.findByRole('button', { name: 'End session' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('You will get a scorecard for what you have said so far');
    await user.click(within(dialog).getByRole('button', { name: 'End and score' }));

    await screen.findByText(`Elsewhere: /ai-coach/sessions/${s.id}/scorecard`);
    expect(api.callsTo(`POST /ai/sessions/${s.id}/end`)).toHaveLength(1);
  });

  it('explains why a conversation cannot be ended while the reply is still being written', async () => {
    const user = userEvent.setup();
    const s = session({ messages: [opening, rep, reply], turnCount: 1 });
    setup(s, {
      [`POST /ai/sessions/${s.id}/end`]: () =>
        json(409, {
          error: {
            code: 'TURN_IN_PROGRESS',
            message: 'The homeowner is still answering. End the session once the reply arrives.',
          },
        }),
    });
    await user.click(await screen.findByRole('button', { name: 'End session' }));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'End and score' }));
    await within(dialog).findByText(/still answering/);
  });

  it('opens an ended conversation on its scorecard', async () => {
    const s = session({ status: 'ended', messages: [opening, rep, reply] });
    setup(s);
    await screen.findByText(`Elsewhere: /ai-coach/sessions/${s.id}/scorecard`);
  });

  it('does not offer a microphone: voice is not available from the API', async () => {
    setup();
    await input();
    expect(
      screen.queryByRole('button', { name: /mic|voice|record|dictate/i }),
    ).not.toBeInTheDocument();
  });

  it('sends with Enter on a keyboard device and adds a line with Shift+Enter', async () => {
    const user = userEvent.setup();
    const s = session({ messages: [opening] });
    const { api } = setup(s, {
      [`POST /ai/sessions/${s.id}/messages`]: () =>
        sseResponse([event('accepted', { repMessage: rep, retried: false }), doneEvent()]),
    });
    const field = await input();
    await user.type(field, 'First line{Shift>}{Enter}{/Shift}second line');
    expect(field).toHaveValue('First line\nsecond line');
    await user.keyboard('{Enter}');
    await waitFor(() => expect(api.callsTo(`POST /ai/sessions/${s.id}/messages`)).toHaveLength(1));
    expect(
      (api.callsTo(`POST /ai/sessions/${s.id}/messages`)[0]!.body as { text: string }).text,
    ).toBe('First line\nsecond line');
    expect(field).toHaveValue('');
  });
});
