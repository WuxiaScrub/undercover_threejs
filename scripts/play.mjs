/**
 * Runs the game server and the client dev server together, so hosting a LAN
 * session is a single command. No dependency needed for this — it is just two
 * child processes sharing our stdout.
 */
import { spawn } from 'node:child_process';

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const children = [
  spawn(npm, ['run', 'server'], { stdio: 'inherit', shell: process.platform === 'win32' }),
  spawn(npm, ['run', 'dev'], { stdio: 'inherit', shell: process.platform === 'win32' }),
];

let shuttingDown = false;
function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) child.kill();
  process.exit(code);
}

for (const child of children) {
  child.on('exit', (code) => shutdown(code ?? 0));
  child.on('error', (err) => {
    console.error(err);
    shutdown(1);
  });
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
