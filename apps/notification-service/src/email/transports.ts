import nodemailer, { type Transporter } from 'nodemailer';
import type { Logger } from '@a5/observability';
import { uuidv7 } from '@a5/observability';

export interface OutgoingEmail {
  from: string;
  replyTo: string | null;
  to: string;
  toName: string | null;
  subject: string;
  text: string;
  html: string;
  headers: Record<string, string>;
}

export interface SendResult {
  messageId: string | null;
}

/** Delivery mechanism for rendered emails. Implementations must throw on failure so the job retries. */
export interface EmailTransport {
  readonly name: string;
  send(message: OutgoingEmail): Promise<SendResult>;
  close?(): Promise<void> | void;
}

export const EMAIL_TRANSPORT = Symbol('EMAIL_TRANSPORT');

/** SMTP via nodemailer (Mailpit in development, a relay such as SES/Postmark SMTP in production). */
export class SmtpTransport implements EmailTransport {
  readonly name = 'smtp';
  private readonly transporter: Transporter;

  constructor(smtpUrl: string) {
    this.transporter = nodemailer.createTransport(smtpUrl);
  }

  async send(message: OutgoingEmail): Promise<SendResult> {
    const info = await this.transporter.sendMail({
      from: message.from,
      to: message.toName ? { name: message.toName, address: message.to } : message.to,
      replyTo: message.replyTo ?? undefined,
      subject: message.subject,
      text: message.text,
      html: message.html,
      headers: message.headers,
    });
    return { messageId: info.messageId ?? null };
  }

  close(): void {
    this.transporter.close();
  }
}

/** Development without SMTP: the message is written to the service log. Refused in production. */
export class ConsoleTransport implements EmailTransport {
  readonly name = 'console';

  constructor(private readonly logger: Logger) {}

  async send(message: OutgoingEmail): Promise<SendResult> {
    const messageId = `<console-${uuidv7()}@a5-notification>`;
    this.logger.info(
      { email: { messageId, to: message.to, subject: message.subject, text: message.text } },
      'email written to log (console transport; set SMTP_URL to send real email)',
    );
    return { messageId };
  }
}

/** In-memory transport for tests: records messages and can simulate provider failures. */
export class MemoryTransport implements EmailTransport {
  readonly name = 'memory';
  readonly sent: Array<OutgoingEmail & { messageId: string }> = [];
  private failures: Error[] = [];

  /** Make the next `count` sends fail with `message`. */
  failNext(count: number, message = 'SMTP 421 Service not available'): void {
    for (let i = 0; i < count; i++) this.failures.push(new Error(message));
  }

  async send(message: OutgoingEmail): Promise<SendResult> {
    const failure = this.failures.shift();
    if (failure) throw failure;
    const messageId = `<memory-${this.sent.length + 1}-${uuidv7()}@a5-notification>`;
    this.sent.push({ ...message, messageId });
    return { messageId };
  }

  to(address: string): Array<OutgoingEmail & { messageId: string }> {
    return this.sent.filter((m) => m.to === address);
  }
}
