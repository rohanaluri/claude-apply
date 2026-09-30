import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ensureChrome,
  chromeLaunchArgs,
  ChromeLaunchError,
} from '../../src/apply/chrome-launcher.mjs';

const quiet = () => {};

function fakeChild() {
  const handlers = {};
  return {
    on: (event, fn) => {
      handlers[event] = fn;
    },
    unref: () => {},
    emit: (event, arg) => handlers[event]?.(arg),
  };
}

test('chromeLaunchArgs — same flags as the chrome-apply alias', () => {
  assert.deepEqual(chromeLaunchArgs({ port: 9222, userDataDir: '/tmp/profile' }), [
    '--user-data-dir=/tmp/profile',
    '--remote-debugging-port=9222',
    '--disable-gpu',
    '--disable-software-rasterizer',
  ]);
});

test('ensureChrome — does nothing when Chrome already answers', async () => {
  let spawned = false;
  const r = await ensureChrome({
    port: 9222,
    probe: async () => true,
    spawnFn: () => {
      spawned = true;
    },
    log: quiet,
  });
  assert.deepEqual(r, { launched: false });
  assert.equal(spawned, false);
});

test('ensureChrome — launches detached and waits until the port answers', async () => {
  let probes = 0;
  const calls = [];
  const r = await ensureChrome({
    port: 9333,
    bin: '/opt/chrome',
    userDataDir: '/tmp/p',
    probe: async () => ++probes >= 3,
    spawnFn: (bin, args, opts) => {
      calls.push({ bin, args, opts });
      return fakeChild();
    },
    pollMs: 1,
    log: quiet,
  });
  assert.deepEqual(r, { launched: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].bin, '/opt/chrome');
  assert.ok(calls[0].args.includes('--remote-debugging-port=9333'));
  assert.equal(calls[0].opts.detached, true);
  assert.equal(calls[0].opts.stdio, 'ignore');
});

test('ensureChrome — ChromeLaunchError when the binary fails to start', async () => {
  const child = fakeChild();
  await assert.rejects(
    () =>
      ensureChrome({
        port: 9222,
        bin: '/missing/chrome',
        probe: async () => false,
        spawnFn: () => {
          setTimeout(() => child.emit('error', new Error('spawn ENOENT')), 0);
          return child;
        },
        pollMs: 5,
        timeoutMs: 1000,
        log: quiet,
      }),
    (err) => err instanceof ChromeLaunchError && /ENOENT/.test(err.message)
  );
});

test('ensureChrome — ChromeLaunchError when the port never opens', async () => {
  await assert.rejects(
    () =>
      ensureChrome({
        port: 9222,
        probe: async () => false,
        spawnFn: () => fakeChild(),
        pollMs: 5,
        timeoutMs: 30,
        log: quiet,
      }),
    (err) => err instanceof ChromeLaunchError && /did not open port 9222/.test(err.message)
  );
});
