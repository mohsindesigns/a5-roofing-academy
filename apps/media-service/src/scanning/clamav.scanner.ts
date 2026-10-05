import { createReadStream } from 'node:fs';
import { once } from 'node:events';
import { createConnection, type Socket } from 'node:net';
import { MalwareScannerError, type MalwareScanner, type ScanVerdict } from './malware-scanner.js';

export interface ClamAvOptions {
  host: string;
  port: number;
  timeoutMs: number;
  /** INSTREAM chunk size; must stay below clamd's StreamMaxLength. */
  chunkSize?: number;
}

/**
 * clamd client using the INSTREAM command: the file is streamed as length-prefixed chunks
 * (4-byte big-endian size + data) terminated by a zero-length chunk; clamd answers
 * `stream: OK`, `stream: <signature> FOUND` or `... ERROR`.
 */
export class ClamAvScanner implements MalwareScanner {
  readonly name = 'clamav';

  constructor(private readonly options: ClamAvOptions) {}

  private connect(): Promise<Socket> {
    return new Promise((resolve, reject) => {
      const socket = createConnection({ host: this.options.host, port: this.options.port });
      socket.setTimeout(this.options.timeoutMs);
      socket.once('timeout', () => socket.destroy(new MalwareScannerError('clamd did not respond in time')));
      socket.once('connect', () => {
        socket.off('error', reject);
        resolve(socket);
      });
      socket.once('error', (err) => reject(new MalwareScannerError(`clamd is unreachable: ${err.message}`)));
    });
  }

  /** Send a command and collect the NUL-terminated reply. */
  private async exchange(write: (socket: Socket) => Promise<void>): Promise<string> {
    const socket = await this.connect();
    const chunks: Buffer[] = [];
    const reply = new Promise<string>((resolve, reject) => {
      socket.on('data', (data: Buffer) => chunks.push(data));
      socket.once('error', (err) => reject(err instanceof MalwareScannerError ? err : new MalwareScannerError(`clamd connection failed: ${err.message}`)));
      socket.once('close', () => resolve(Buffer.concat(chunks).toString('utf8').replace(/\0/g, '').trim()));
    });
    // Observed below; this only prevents an unhandled rejection when writing fails first.
    reply.catch(() => undefined);
    try {
      await write(socket);
    } catch (err) {
      // clamd may close the connection early (e.g. size limit); its reply explains why.
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
      socket.write('zINSTREAM\0');
      const file = createReadStream(path, { highWaterMark: chunkSize });
      for await (const chunk of file as AsyncIterable<Buffer>) {
        const header = Buffer.alloc(4);
        header.writeUInt32BE(chunk.length, 0);
        if (!socket.write(Buffer.concat([header, chunk]))) await once(socket, 'drain');
      }
      socket.end(Buffer.alloc(4));
    });
    return parseClamdReply(reply);
  }

  async ping(): Promise<void> {
    const reply = await this.exchange(async (socket) => {
      socket.end('zPING\0');
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
