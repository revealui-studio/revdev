import { PGlite } from '@electric-sql/pglite';
import { expect, it, vi } from 'vitest';

const kernel = vi.hoisted(() => ({ start: '100', queued: () => {} }));
const pid = 424242;
vi.mock('node:fs', async (importActual) => {
  const actual = await importActual<typeof import('node:fs')>();
  return {
    ...actual,
    readFileSync: (...args: Parameters<typeof actual.readFileSync>) => {
      if (String(args[0]) === '/proc/424242/stat') {
        const fields = ['S', ...Array(18).fill('0'), kernel.start];
        return `424242 (queued process) ${fields.join(' ')}`;
      }
      if (String(args[0]) === '/proc/sys/kernel/random/boot_id') return 'synthetic-boot';
      return actual.readFileSync(...args);
    },
  };
});
vi.mock('../session-registration.js', async (importActual) => {
  const actual = await importActual<typeof import('../session-registration.js')>();
  const run = actual.sessionRegistrations.run.bind(actual.sessionRegistrations);
  return {
    ...actual,
    sessionRegistrations: {
      ...actual.sessionRegistrations,
      run: (...args: Parameters<typeof run>) => {
        kernel.queued();
        return run(...args);
      },
    },
  };
});

vi.mock('../work-services.js', () => ({
  enterWorkServices: vi.fn(),
  leaveWorkServices: vi.fn(),
}));

import { notifyDaemonStarted } from '../eviction.js';
import { dispatchRpc, type SocketContext } from '../server.js';
import { sessionRegistrations } from '../session-registration.js';
import { sessionWork } from '../session-work.js';
import { migrate } from '../storage/migrate.js';
import { enterWorkServices } from '../work-services.js';

it('the RPC handler captures process birth before the stable-ID queue wait', async () => {
  const db = new PGlite();
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered!: () => void;
  const held = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const blocker = sessionRegistrations.run('queued', async () => {
    entered();
    await waiting;
  });
  try {
    await migrate(db);
    await held;
    let queued!: () => void;
    const enqueued = new Promise<void>((resolve) => {
      queued = resolve;
    });
    kernel.start = '100';
    kernel.queued = queued;
    const ctx: SocketContext = {
      agentId: null,
      agentName: null,
      boundVia: null,
      keyOrigin: null,
      verifiedSignature: null,
      preSignatureAgentId: null,
      preSignatureAgentName: null,
      preSignatureBoundVia: null,
    };
    const registration = dispatchRpc(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'session.register',
        params: { agentId: 'queued', agentName: 'queued', workDir: '/tmp', pid },
      },
      db,
      ctx,
    );
    await enqueued;
    kernel.start = '200'; // The kernel reused the caller PID while it was queued.
    release();
    await blocker;
    const response = await registration;
    expect(response).not.toHaveProperty('error');
    expect(enterWorkServices).not.toHaveBeenCalled();
    expect(
      (await db.query('SELECT pid, process_birth FROM agent_sessions WHERE id = $1', ['queued']))
        .rows,
    ).toEqual([{ pid, process_birth: null }]);
    sessionWork.clear();
    await notifyDaemonStarted(db);
    expect(sessionWork.isBusy()).toBe(false);
  } finally {
    release();
    await blocker;
    kernel.queued = () => {};
    sessionWork.clear();
    await db.close();
  }
}, 60_000);
