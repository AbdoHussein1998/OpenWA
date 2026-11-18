/** Root development runner: starts NestJS --watch and Vite HMR in parallel. */
import { spawn } from 'node:child_process';

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const children = new Map();
let shuttingDown = false;

for (const [name, prefix, script] of [
  ['backend', 'backend', 'start:dev'],
  ['frontend', 'frontend', 'dev'],
]) {
  const args = ['--prefix', prefix, 'run', script];
  const child = spawn(npm, args, {
    cwd: process.cwd(),
    shell: process.platform === 'win32',
    env: { ...process.env, ...(name === 'backend' ? { SERVE_DASHBOARD: 'false' } : {}) },
    stdio: ['inherit', 'pipe', 'pipe'],
  });
  children.set(name, child);
  for (const [stream, destination] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
    let pending = '';
    stream?.on('data', bytes => {
      pending += bytes.toString();
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) destination.write(`[${name}] ${line}\n`);
    });
    stream?.on('end', () => { if (pending) destination.write(`[${name}] ${pending}\n`); });
  }
  child.on('error', e => { console.error(`[${name}] ${e.message}`); stop(1); });
  child.on('exit', code => {
    if (!shuttingDown) {
      console.error(`[${name}] exited (code ${code ?? 'signal'}); stopping both servers`);
      stop(code || 1);
    }
  });
}

function stop(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  process.exitCode = code;
  for (const child of children.values()) {
    if (!child.killed && child.exitCode === null) child.kill('SIGTERM');
  }
}
process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));
