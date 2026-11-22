import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import {
  isDaemonBusy,
  notifyAgentEnded,
  notifyDaemonStarted,
  notifyDaemonStopping,
} from '../src/eviction.ts';
import { createSessionWork, sessionProcessIdentity, sessionWork } from '../src/session-work.ts';

afterEach(() => sessionWork.clear());

test('restores a surviving process across daemon stop/start and releases it at session end', async () => {
  // The persisted row is synthetic; the kernel process is real.
  const birth = sessionWork.hold('surviving-session', process.pid);
  assert.equal(isDaemonBusy(), true);
  await notifyDaemonStopping();
  assert.equal(isDaemonBusy(), false);
  let queries = 0;
  await notifyDaemonStarted({
    query: async () => {
      queries++;
      return { rows: [{ id: 'surviving-session', pid: process.pid, process_birth: birth }] };
    },
  });
  assert.equal(isDaemonBusy(), true, 'live session must survive daemon restart');
  assert.equal(queries, 1);
  notifyAgentEnded('surviving-session', {});
  assert.equal(isDaemonBusy(), false);
});

test('persisted identity includes the current boot and process start time', () => {
  assert.match(sessionProcessIdentity(process.pid), /^[0-9a-f-]+:\d+$/);
  assert.equal(sessionProcessIdentity(null), null);
  assert.equal(sessionProcessIdentity(-1), null);
});

test('does not restore a reused PID or a process from an earlier boot', async () => {
  const birth = sessionProcessIdentity(process.pid);
  for (const stale of ['earlier-boot:' + birth.split(':')[1], birth.split(':')[0] + ':0']) {
    await notifyDaemonStarted({
      query: async () => ({ rows: [{ id: 'stale', pid: process.pid, process_birth: stale }] }),
    });
    assert.equal(isDaemonBusy(), false);
  }
});

test('does not adopt legacy sessions without a captured process identity', async () => {
  await notifyDaemonStarted({
    query: async () => ({ rows: [{ id: 'legacy', pid: process.pid, process_birth: null }] }),
  });
  assert.equal(isDaemonBusy(), false);
});

test('does not bind registration to a PID reused while registration is pending', () => {
  let birth = 'boot:first-process';
  const work = createSessionWork(() => birth);
  const captured = birth;
  birth = 'boot:replacement-process';
  assert.equal(work.hold('registration', 123, captured), null);
  assert.equal(work.isBusy(), false);
});

test('restoration database errors fail startup instead of declaring the daemon idle', async () => {
  await assert.rejects(
    notifyDaemonStarted({
      query: async () => {
        throw new Error('database unavailable');
      },
    }),
    /database unavailable/,
  );
});
