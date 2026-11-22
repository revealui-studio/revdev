import { PGlite } from '@electric-sql/pglite';
import { afterEach, expect, it } from 'vitest';
import { notifyDaemonStarted } from '../eviction.js';
import { createSessionRegistrations } from '../session-registration.js';
import { sessionProcessIdentity, sessionWork } from '../session-work.js';
import { migrate } from '../storage/migrate.js';

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

afterEach(() => sessionWork.clear());

it.each([
  ['before-write', false],
  ['after-write', false],
  ['before-write', true],
  ['after-write', true],
] as const)(
  'serializes %s finalization with same PID=%s and admits work before replacement starts',
  async (delay, samePid) => {
    const db = new PGlite();
    const registrations = createSessionRegistrations();
    const paused = gate();
    const resume = gate();
    const events: string[] = [];
    const newerPid = samePid ? process.pid : process.ppid;
    const olderBirth = sessionProcessIdentity(process.pid);
    const newerBirth = sessionProcessIdentity(newerPid);
    expect(olderBirth).not.toBeNull();
    expect(newerBirth).not.toBeNull();
    try {
      await migrate(db);
      const older = registrations.run('stable', async (generation) => {
        await db.query(
          'INSERT INTO agent_sessions (id, pid, registration_generation) VALUES ($1, $2, $3)',
          ['stable', process.pid, generation],
        );
        const delayed = {
          query: async (...args: Parameters<PGlite['query']>) => {
            if (delay === 'before-write') {
              paused.release();
              await resume.promise;
            }
            const result = await db.query(...args);
            if (delay === 'after-write') {
              paused.release();
              await resume.promise;
            }
            return result;
          },
        } as PGlite;
        expect(
          await registrations.finalize(
            delayed,
            'stable',
            generation,
            process.pid,
            olderBirth,
            () => {
              events.push('older-entry');
            },
          ),
        ).toBe(true);
      });
      await paused.promise;
      const newer = registrations.run('stable', async (generation) => {
        events.push('newer-start');
        await db.query(
          'UPDATE agent_sessions SET pid = $2, process_birth = NULL, registration_generation = $3 WHERE id = $1',
          ['stable', newerPid, generation],
        );
        expect(
          await registrations.finalize(db, 'stable', generation, newerPid, newerBirth, () => {
            events.push('newer-entry');
          }),
        ).toBe(true);
      });
      await Promise.resolve();
      expect(events).toEqual([]);
      resume.release();
      await Promise.all([older, newer]);
      expect(events).toEqual(['older-entry', 'newer-start', 'newer-entry']);
      expect(
        (await db.query('SELECT pid, process_birth FROM agent_sessions WHERE id = $1', ['stable']))
          .rows,
      ).toEqual([{ pid: newerPid, process_birth: newerBirth }]);
      sessionWork.clear();
      await notifyDaemonStarted(db);
      expect(sessionWork.isBusy()).toBe(true);
    } finally {
      await db.close();
    }
  },
  60_000,
);

it('retains the valid admission when a queued replacement initial write fails and releases the queue', async () => {
  const db = new PGlite();
  const registrations = createSessionRegistrations();
  const entered = gate();
  const resume = gate();
  const birth = sessionProcessIdentity(process.pid);
  try {
    await migrate(db);
    const older = registrations.run('stable', async (generation) => {
      await db.query(
        'INSERT INTO agent_sessions (id, pid, registration_generation) VALUES ($1, $2, $3)',
        ['stable', process.pid, generation],
      );
      entered.release();
      await resume.promise;
      await registrations.finalize(db, 'stable', generation, process.pid, birth);
    });
    await entered.promise;
    const failed = registrations.run('stable', async () => {
      await db.query('INSERT INTO missing_registration_table VALUES (1)');
    });
    const rejection = expect(failed).rejects.toThrow();
    resume.release();
    await older;
    await rejection;
    expect(
      (await db.query('SELECT pid, process_birth FROM agent_sessions WHERE id = $1', ['stable']))
        .rows,
    ).toEqual([{ pid: process.pid, process_birth: birth }]);
    expect(sessionWork.isBusy()).toBe(true);
    sessionWork.clear();
    await notifyDaemonStarted(db);
    expect(sessionWork.isBusy()).toBe(true);
    expect(await registrations.run('stable', async () => 'queue-released')).toBe('queue-released');
  } finally {
    await db.close();
  }
}, 60_000);

it('does not block registrations for other stable IDs', async () => {
  const registrations = createSessionRegistrations();
  const entered = gate();
  const resume = gate();
  const blocked = registrations.run('one', async () => {
    entered.release();
    await resume.promise;
  });
  await entered.promise;
  expect(await registrations.run('two', async () => 'independent')).toBe('independent');
  resume.release();
  await blocked;
});
