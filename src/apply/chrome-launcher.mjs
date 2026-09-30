// Starts the CDP Chrome that capply drives, if it isn't already running —
// the same browser the `chrome-apply` alias launches (see docs/cdp-setup.md):
// a dedicated, non-default profile with remote debugging on the given port.
// Launching it here removes the "start chrome-apply first" step, including
// for the desktop shortcut that runs `capply --queue`.
//
// Overrides: CAPPLY_CHROME_BIN (default /usr/bin/google-chrome) and
// CAPPLY_CHROME_USER_DATA_DIR (default ~/.config/google-chrome-claude-apply).

import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

export class ChromeLaunchError extends Error {
  constructor(message, { cause } = {}) {
    super(message);
    this.name = 'ChromeLaunchError';
    if (cause) this.cause = cause;
  }
}

export function defaultChromeBin() {
  return process.env.CAPPLY_CHROME_BIN || '/usr/bin/google-chrome';
}

export function defaultUserDataDir() {
  return (
    process.env.CAPPLY_CHROME_USER_DATA_DIR ||
    path.join(os.homedir(), '.config', 'google-chrome-claude-apply')
  );
}

// Same flags as the chrome-apply alias. --disable-gpu /
// --disable-software-rasterizer stop the WebGL error flood under WSL2
// (pipeline-architecture.md, Section 1).
export function chromeLaunchArgs({ port, userDataDir }) {
  return [
    `--user-data-dir=${userDataDir}`,
    `--remote-debugging-port=${port}`,
    '--disable-gpu',
    '--disable-software-rasterizer',
  ];
}

export async function isCdpUp(port, fetchFn = fetch) {
  try {
    const res = await fetchFn(`http://localhost:${port}/json/version`, {
      signal: AbortSignal.timeout(1500),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// Resolves { launched: false } if Chrome already answers on `port`, or
// { launched: true } once a newly spawned Chrome does. The child is
// detached so it outlives capply (and the terminal/shortcut window).
export async function ensureChrome({
  port,
  bin = defaultChromeBin(),
  userDataDir = defaultUserDataDir(),
  probe = (p) => isCdpUp(p),
  spawnFn = spawn,
  timeoutMs = 20_000,
  pollMs = 500,
  log = (msg) => process.stderr.write(`${msg}\n`),
} = {}) {
  if (await probe(port)) return { launched: false };

  log(`→ Chrome isn't running on port ${port} — starting it...`);
  let spawnError = null;
  let child;
  try {
    child = spawnFn(bin, chromeLaunchArgs({ port, userDataDir }), {
      detached: true,
      stdio: 'ignore',
    });
  } catch (err) {
    throw new ChromeLaunchError(`could not start ${bin}: ${err.message}`, { cause: err });
  }
  child.on?.('error', (err) => {
    spawnError = err;
  });
  child.unref?.();

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (spawnError) {
      throw new ChromeLaunchError(`could not start ${bin}: ${spawnError.message}`, {
        cause: spawnError,
      });
    }
    if (await probe(port)) {
      log('✓ Chrome started');
      return { launched: true };
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new ChromeLaunchError(
    `Chrome did not open port ${port} within ${timeoutMs / 1000}s (started ${bin}). ` +
      'If Chrome was already open with this profile but without remote debugging, close it and retry.'
  );
}
