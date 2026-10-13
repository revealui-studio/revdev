import { PGlite } from '@electric-sql/pglite';
import { afterEach, expect, it } from 'vitest';
import { notifyDaemonStarted } from '../eviction.js';
import { createSessionRegistrations } from '../session-registration.js';
import { sessionProcessIdentity, sessionWork } from '../session-work.js';
import { migrate } from '../storage/migrate.js';

afterEach(() => sessionWork.clear());

it('preserves the newer stable registration when an older conditional write completes last', async () => {
  const db = new PGlite();
  const registrations = createSessionRegistrations();
  const olderPid = process.pid;
  const newerPid = process.ppid;
  const olderBirth = sessionProcessIdentity(olderPid);
  const newerBirth = sessionProcessIdentity(newerPid);
  expect(olderBirth).not.toBeNull();
  expect(newerBirth).not.toBeNull();
  try {
    await migrate(db);
    const older = registrations.begin('stable');
    await db.query(
      'INSERT INTO agent_sessions (id, pid, registration_generation) VALUES ($1, $2, $3)',
      ['stable', olderPid, older],
    );
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const delayed = {
      query: async (...args: Parameters<PGlite['query']>) => {
        entered();
        await waiting;
        return db.query(...args);
      },
    } as PGlite;
    const oldFinalization = registrations.finalize(delayed, 'stable', older, olderPid, olderBirth);
    await started;
    const newer = registrations.begin('stable');
    await db.query(
      'UPDATE agent_sessions SET pid = $2, process_birth = NULL, registration_generation = $3 WHERE id = $1',
      ['stable', newerPid, newer],
    );
    expect(await registrations.finalize(db, 'stable', newer, newerPid, newerBirth)).toBe(true);
    registrations.finish('stable', newer);
    release();
    expect(await oldFinalization).toBe(false);
    registrations.finish('stable', older);
    const rows = await db.query('SELECT pid, process_birth FROM agent_sessions WHERE id = $1', [
      'stable',
    ]);
    expect(rows.rows).toEqual([{ pid: newerPid, process_birth: newerBirth }]);
    sessionWork.clear();
    await notifyDaemonStarted(db);
    expect(sessionWork.isBusy()).toBe(true);
  } finally {
    await db.close();
  }
}, 60_000);
