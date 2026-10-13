import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { afterEach, expect, it } from 'vitest';
import {
  isDaemonBusy,
  notifyAgentEnded,
  notifyDaemonStarted,
  notifyDaemonStopping,
} from '../eviction.js';
import { MIGRATIONS } from '../migrations/index.js';
import { sessionProcessIdentity, sessionWork } from '../session-work.js';
import { migrate, migrationStatus } from '../storage/migrate.js';

afterEach(async () => {
  await notifyDaemonStopping();
  sessionWork.clear();
});

it.skipIf(process.platform !== 'linux')(
  'migrates existing sessions and restores holds from a reopened real database',
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'revdev-session-restart-'));
    let db = new PGlite(directory);
    try {
      await migrate(
        db,
        MIGRATIONS.filter((migration) => migration.version < 17),
      );
      await db.query('INSERT INTO agent_sessions (id, pid) VALUES ($1, $2)', [
        'legacy',
        process.pid,
      ]);
      const migration = await migrate(db);
      expect(migration.applied).toEqual([17, 18]);
      expect(await migrate(db)).toEqual({ current: 18, applied: [] });
      expect((await db.query('SELECT id, process_birth FROM agent_sessions')).rows).toEqual([
        { id: 'legacy', process_birth: null },
      ]);
      const birth = sessionProcessIdentity(process.pid);
      expect(birth).not.toBeNull();
      await db.query('INSERT INTO agent_sessions (id, pid, process_birth) VALUES ($1, $2, $3)', [
        'live',
        process.pid,
        birth,
      ]);
      await db.query('INSERT INTO agent_sessions (id, pid, process_birth) VALUES ($1, $2, $3)', [
        'stale',
        process.pid,
        'previous-boot:0',
      ]);
      await db.query(
        'INSERT INTO agent_sessions (id, pid, process_birth, ended_at) VALUES ($1, $2, $3, NOW())',
        ['ended', process.pid, birth],
      );
      sessionWork.hold('live', process.pid, birth);
      expect(isDaemonBusy()).toBe(true);
      await notifyDaemonStopping();
      expect(isDaemonBusy()).toBe(false);
      await db.close();
      db = new PGlite(directory);
      expect((await migrationStatus(db)).current).toBe(18);
      await notifyDaemonStarted(db);
      expect(isDaemonBusy()).toBe(true);
      await db.query('UPDATE agent_sessions SET ended_at = NOW() WHERE id = $1', ['live']);
      notifyAgentEnded('live', db);
      expect(isDaemonBusy()).toBe(false);
      await notifyDaemonStopping();
      await notifyDaemonStarted(db);
      expect(isDaemonBusy()).toBe(false);
    } finally {
      await db.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
  60_000,
);

it('fails startup when a real database lacks the required migration', async () => {
  const db = new PGlite();
  try {
    await migrate(
      db,
      MIGRATIONS.filter((migration) => migration.version < 17),
    );
    await expect(notifyDaemonStarted(db)).rejects.toThrow(/process_birth/);
    expect(isDaemonBusy()).toBe(false);
  } finally {
    await db.close();
  }
}, 60_000);
