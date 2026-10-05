#!/usr/bin/env node
// Development runner: incremental TypeScript build in watch mode, every service with
// `node --watch` (restarts when its build output changes) and the Vite dev server.
//
//   pnpm dev                 # everything
//   pnpm dev identity gateway  # only matching apps (web always starts unless --no-web)
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('../..', import.meta.url).pathname;
const args = process.argv.slice(2);
const noWeb = args.includes('--no-web');
const filters = args.filter((a) => !a.startsWith('--'));

const apps = readdirSync(join(root, 'apps'))
  .filter((name) => name !== 'web' && existsSync(join(root, 'apps', name, 'tsconfig.json')))
  .filter((name) => filters.length === 0 || filters.some((f) => name.includes(f)));
const packages = readdirSync(join(root, 'packages')).filter((n) =>
  existsSync(join(root, 'packages', n, 'tsconfig.json')),
);
const projects = [...packages.map((p) => `packages/${p}`), ...apps.map((a) => `apps/${a}`)];

const colors = [36, 32, 33, 35, 34, 96, 92, 93, 95, 94, 91];
const children = [];

function run(name, cmd, cmdArgs, cwd, color) {
  const child = spawn(cmd, cmdArgs, {
    cwd,
    env: { ...process.env, FORCE_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const prefix = `\x1b[${color}m${name.padEnd(22)}\x1b[0m│ `;
  const pipe = (stream, out) => {
    let buffer = '';
    stream.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) out.write(`${prefix}${line}\n`);
    });
  };
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);
  child.on('exit', (code) => process.stdout.write(`${prefix}exited with ${code}\n`));
  children.push(child);
  return child;
}

console.log(`Building ${projects.length} projects…`);
const initial = spawnSync('pnpm', ['exec', 'tsc', '-b', ...projects], {
  cwd: root,
  stdio: 'inherit',
});
if (initial.status !== 0) {
  console.error('Initial build failed. Fix the errors above and run pnpm dev again.');
  process.exit(initial.status ?? 1);
}

run('tsc', 'pnpm', ['exec', 'tsc', '-b', '-w', '--preserveWatchOutput', ...projects], root, 90);
apps.forEach((app, i) => {
  const cwd = join(root, 'apps', app);
  run(
    app,
    'node',
    [
      '--env-file-if-exists=../../.env',
      '--env-file-if-exists=.env.development',
      '--watch',
      'dist/main.js',
    ],
    cwd,
    colors[i % colors.length],
  );
});
if (!noWeb) run('web', 'pnpm', ['exec', 'vite'], join(root, 'apps', 'web'), 97);

const stop = () => {
  for (const c of children) c.kill('SIGTERM');
  setTimeout(() => process.exit(0), 1500);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
