import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { assertNativeRuntime } from './runtime-artifact.mjs';

// Opt-in real native acceptance: no daemon, database, agent, or interactive shell.
test('reviewed Node26 ABI loads node-pty and runs a noninteractive executable', {
  timeout: 15_000,
}, async () => {
  assertNativeRuntime();
  const require = createRequire(import.meta.url);
  const pty = require('node-pty');
  const child = pty.spawn('/usr/bin/printf', ['revealfleet-native-abi147'], {
    name: 'xterm',
    cols: 80,
    rows: 24,
    cwd: '/tmp',
    env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
  });
  let output = '';
  child.onData((data) => {
    output += data;
  });
  const status = await new Promise((resolve) => child.onExit(resolve));
  assert.equal(status.exitCode, 0);
  assert.equal(status.signal, 0);
  assert.equal(output, 'revealfleet-native-abi147');
});
