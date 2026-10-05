import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { ArrowUp, RotateCw } from 'lucide-react';
import { Avatar, Button, IconButton } from '@/components/ui';
import { cn } from '@/lib/cn';
import type { ChatMessage } from './chat-state';

export const MAX_MESSAGE_LENGTH = 2000;

const timeFmt = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' });

function formatTime(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : timeFmt.format(d);
}

/** Dots shown between sending a message and the first word of the reply. */
function TypingDots() {
  return (
    <span aria-hidden className="flex h-6 items-center gap-1">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="size-1.5 animate-pulse rounded-full bg-text-tertiary"
          style={{ animationDelay: `${i * 160}ms` }}
        />
      ))}
    </span>
  );
}

const bubbleBase =
  'rounded-lg px-3.5 py-2.5 text-base leading-[22px] break-words whitespace-pre-wrap';

export function HomeownerBubble({
  personaName,
  children,
  time,
  hiddenFromAssistiveTech,
  pending,
}: {
  personaName: string;
  children?: ReactNode;
  time?: string | null;
  /** Streaming text is announced once when complete, not word by word. */
  hiddenFromAssistiveTech?: boolean;
  pending?: boolean;
}) {
  return (
    <li
      className="flex max-w-[92%] items-end gap-2 sm:max-w-[80%]"
      aria-hidden={hiddenFromAssistiveTech}
    >
      <Avatar name={personaName} size={28} className="mb-5" />
      <div className="min-w-0">
        <p className="mb-1 text-xs text-text-secondary">
          <span className="sr-only">Homeowner </span>
          {personaName}
          {time ? <span aria-hidden> · {formatTime(time)}</span> : null}
        </p>
        <div className={cn(bubbleBase, 'border border-border bg-surface text-text-primary')}>
          {pending ? <TypingDots /> : children}
        </div>
      </div>
    </li>
  );
}

export function RepBubble({
  message,
  onResend,
  onDiscard,
  canResend,
}: {
  message: ChatMessage;
  onResend: (m: ChatMessage) => void;
  onDiscard: () => void;
  canResend: boolean;
}) {
  return (
    <li className="ml-auto flex max-w-[92%] flex-col items-end sm:max-w-[80%]">
      <p className="mb-1 text-xs text-text-secondary">
        <span className="sr-only">You </span>
        {message.delivery === 'sent' && formatTime(message.createdAt)}
        {message.delivery === 'sending' && 'Sending…'}
      </p>
      <div
        className={cn(
          bubbleBase,
          'bg-brand-primary text-text-inverse',
          message.delivery === 'failed' && 'bg-surface text-text-primary ring-1 ring-danger',
        )}
      >
        {message.content}
      </div>
      {message.delivery === 'failed' && (
        <p className="mt-1.5 flex flex-wrap items-center justify-end gap-x-3 gap-y-1 text-sm text-danger">
          <span className="font-medium">Not sent</span>
          {canResend && (
            <button
              type="button"
              onClick={() => onResend(message)}
              className="inline-flex items-center gap-1 font-medium underline underline-offset-2"
            >
              <RotateCw aria-hidden className="size-3.5" />
              Send again
            </button>
          )}
          <button
            type="button"
            onClick={onDiscard}
            className="font-medium underline underline-offset-2"
          >
            Edit message
          </button>
        </p>
      )}
    </li>
  );
}

const coarsePointer = () =>
  typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches === true;

/**
 * Message input. Enter sends on devices with a keyboard; on touch screens Enter adds a line and
 * the Send button sends. The field stays editable while the homeowner answers so the learner
 * keeps focus and can prepare the next message; only sending is held back. `extraActions` is the
 * slot for a voice control once voice is available.
 */
export function Composer({
  blockedReason,
  disabled = false,
  onSend,
  restore,
  extraActions,
}: {
  /** Why sending is paused right now (shown as the hint). */
  blockedReason?: string;
  /** No input at all (the conversation is over). */
  disabled?: boolean;
  onSend: (text: string) => void;
  /** Put text back into the field and focus it, for example after "Edit message". */
  restore?: { token: number; text: string };
  extraActions?: ReactNode;
}) {
  const [value, setValue] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);
  const id = useId();
  const trimmed = value.trim();
  const touch = coarsePointer();
  const blocked = disabled || Boolean(blockedReason);

  useEffect(() => {
    if (!restore) return;
    setValue(restore.text);
    ref.current?.focus();
  }, [restore]);

  // Grow with the content, up to about six lines.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 144)}px`;
  }, [value]);

  const submit = () => {
    if (blocked || !trimmed) return;
    onSend(trimmed);
    setValue('');
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && !touch) {
      e.preventDefault();
      submit();
    }
  };

  const nearLimit = value.length >= MAX_MESSAGE_LENGTH * 0.8;
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <label htmlFor={`${id}-input`} className="sr-only">
        Your response to the homeowner
      </label>
      <div className="flex items-end gap-2">
        <textarea
          id={`${id}-input`}
          ref={ref}
          rows={1}
          value={value}
          maxLength={MAX_MESSAGE_LENGTH}
          disabled={disabled}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Say what you would say at the door"
          aria-describedby={`${id}-hint`}
          enterKeyHint={touch ? 'enter' : 'send'}
          className="block max-h-36 min-h-11 min-w-0 flex-1 resize-none rounded border border-border-strong bg-surface px-3 py-2.5 text-base leading-[22px] text-text-primary transition-colors placeholder:text-text-tertiary hover:border-text-tertiary focus:border-information focus:ring-2 focus:ring-information/20 focus:outline-none disabled:cursor-not-allowed disabled:bg-surface-sunken disabled:text-text-tertiary"
        />
        {extraActions}
        <IconButton
          type="submit"
          label="Send message"
          variant="primary"
          size="lg"
          disabled={blocked || !trimmed}
        >
          <ArrowUp aria-hidden className="size-5" />
        </IconButton>
      </div>
      <p id={`${id}-hint`} className="mt-1.5 min-h-4 text-xs text-text-secondary">
        {blockedReason ? (
          blockedReason
        ) : nearLimit ? (
          <span className="tabular">
            {value.length.toLocaleString()} of {MAX_MESSAGE_LENGTH.toLocaleString()} characters
          </span>
        ) : touch ? (
          'Tap send when you are ready.'
        ) : (
          'Enter sends. Shift+Enter adds a line.'
        )}
      </p>
    </form>
  );
}

export function RetryReplyBar({
  message,
  retryable,
  onRetry,
}: {
  message: string;
  retryable: boolean;
  onRetry: () => void;
}) {
  return (
    <div
      role="alert"
      className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-danger/25 bg-danger-soft px-4 py-3"
    >
      <p className="min-w-0 flex-1 text-sm text-text-primary">{message}</p>
      {retryable && (
        <Button size="sm" onClick={onRetry} leading={<RotateCw className="size-3.5" />}>
          Get reply
        </Button>
      )}
    </div>
  );
}
