import { spawn } from 'node:child_process';

export class ProcessError extends Error {
  constructor(
    message: string,
    readonly exitCode: number | null,
    readonly stderrTail: string,
  ) {
    super(message);
    this.name = 'ProcessError';
  }
}

export interface RunOptions {
  timeoutMs: number;
  /** Keep at most this many bytes of stderr for diagnostics. */
  stderrLimit?: number;
}

/**
 * Run an executable without a shell (arguments are never interpolated) and collect stdout.
 * The process is killed when it exceeds the timeout.
 */
export function runProcess(command: string, args: string[], options: RunOptions): Promise<{ stdout: string; stderr: string }> {
  const stderrLimit = options.stderrLimit ?? 16 * 1024;
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, options.timeoutMs);
    child.stdout.on('data', (d: Buffer) => stdout.push(d));
    child.stderr.on('data', (d: Buffer) => {
      stderr = (stderr + d.toString('utf8')).slice(-stderrLimit);
    });
    child.once('error', (err) => {
      clearTimeout(timer);
      const missing = (err as NodeJS.ErrnoException).code === 'ENOENT';
      reject(new ProcessError(missing ? `${command} is not installed or not on PATH` : `${command} failed to start: ${err.message}`, null, ''));
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new ProcessError(`${command} exceeded the time limit of ${Math.round(options.timeoutMs / 1000)} s`, code, stderr));
      } else if (code !== 0) {
        reject(new ProcessError(`${command} exited with code ${code}`, code, stderr));
      } else {
        resolve({ stdout: Buffer.concat(stdout).toString('utf8'), stderr });
      }
    });
  });
}

/** Last meaningful line of a tool's stderr, for readable error messages. */
export function lastLine(stderr: string): string {
  const lines = stderr
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  return lines[lines.length - 1] ?? '';
}
