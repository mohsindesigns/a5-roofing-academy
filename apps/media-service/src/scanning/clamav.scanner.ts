import { createReadStream } from 'node:fs';
import { createConnection, type Socket } from 'node:net';
import { MalwareScannerError, type MalwareScanner, type ScanVerdict } from './malware-scanner.js';

export interface ClamAvOptions {
  host: string;
  port: number;
  timeoutMs: number;
  /** INSTREAM chunk size; must stay below clamd's StreamMaxLength. */
  chunkSize?: number;
}

/** Write one buffer; settles when it was flushed, or fails if the connection is gone. */
function writeAll(socket: Socket, data: Buffer | string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (socket.destroyed || !socket.writable) {
      reject(new MalwareScannerError('clamd closed the connection'));
      return;
    }
    socket.write(data, (err) => (err ? reject(new MalwareScannerError(`clamd connection failed: ${err.message}`)) : resolve()));
  });
}

/**
 * clamd client using the INSTREAM command: the file is streamed as length-prefixed chunks
 * (4-byte big-endian size + data) terminated by a zero-length chunk; clamd answers
 * `stream: OK`, `stream: <signature> FOUND` or `... ERROR`. Every failure (unreachable, timeout,
 * hang-up, error reply) throws, so the processing job is retried instead of passing unscanned.
 */
export class ClamAvScanner implements MalwareScanner {
  readonly name = 'clamav';

  constructor(private readonly options: ClamAvOptions) {}

  private connect(): Promise<Socket> {
    return new Promise((resolve, reject) => {
      const socket = createConnection({ host: this.options.host, port: this.options.port });
      socket.setTimeout(this.options.timeoutMs);
      socket.once('timeout', () => socket.destroy(new MalwareScannerError('clamd did not respond in time')));
      socket.once('error', (err) => reject(new MalwareScannerError(`clamd is unreachable: ${err.message}`)));
      socket.once('connect', () => resolve(socket));
    });
  }

  /** Run a command and collect clamd's NUL-terminated reply. */
  private async exchange(write: (socket: Socket) => Promise<void>): Promise<string> {
    const socket = await this.connect();
    const chunks: Buffer[] = [];
    let failure: Error | null = null;
    const reply = new Promise<string>((resolve, reject) => {
      socket.on('data', (data: Buffer) => chunks.push(data));
      // Later errors must not become uncaught exceptions.
      socket.on('error', (err) => {
        failure ??= err instanceof MalwareScannerError ? err : new MalwareScannerError(`clamd connection failed: ${err.message}`);
      });
      socket.once('close', () => {
        if (chunks.length) resolve(Buffer.concat(chunks).toString('utf8').replace(/\0/g, '').trim());
        else reject(failure ?? new MalwareScannerError('clamd closed the connection without a reply'));
      });
    });
    // The outcome is read below; this only prevents an unhandled rejection while writing.
    reply.catch(() => undefined);
    try {
      await write(socket);
    } catch (err) {
      // clamd may answer and close early (e.g. size limit); its reply then explains why.
      if (!chunks.length) {
        socket.destroy();
        throw err instanceof MalwareScannerError ? err : new MalwareScannerError(`clamd connection failed: ${(err as Error).message}`);
      }
    }
    return reply;
  }

  async scanFile(path: string): Promise<ScanVerdict> {
    const chunkSize = this.options.chunkSize ?? 64 * 1024;
    const reply = await this.exchange(async (socket) => {
      await writeAll(socket, 'zINSTREAM\0');
      for await (const chunk of createReadStream(path, { highWaterMark: chunkSize }) as AsyncIterable<Buffer>) {
        const header = Buffer.alloc(4);
        header.writeUInt32BE(chunk.length, 0);
        await writeAll(socket, Buffer.concat([header, chunk]));
      }
      await new Promise<void>((resolve) => socket.end(Buffer.alloc(4), resolve));
    });
    return parseClamdReply(reply);
  }

  async ping(): Promise<void> {
    const reply = await this.exchange(async (socket) => {
      await new Promise<void>((resolve) => socket.end('zPING\0', resolve));
    });
    if (reply !== 'PONG') throw new MalwareScannerError(`Unexpected clamd reply to PING: ${reply || '(empty)'}`);
  }
}

export function parseClamdReply(reply: string): ScanVerdict {
  const body = reply.replace(/^stream:\s*/, '');
  if (body === 'OK') return { status: 'clean', engine: 'clamav' };
  const found = /^(.+) FOUND$/.exec(body);
  if (found) return { status: 'infected', engine: 'clamav', signature: found[1]!.trim() };
  throw new MalwareScannerError(`clamd could not scan the file: ${reply || '(empty reply)'}`);
}
