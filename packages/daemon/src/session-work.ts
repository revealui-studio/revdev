import { readFileSync } from 'node:fs';
import { onAgentEnded, onDaemonBusy, onDaemonStarted, onDaemonStopping } from './eviction.js';

export function sessionProcessIdentity(pid: number | null): string | null {
  if (process.platform !== 'linux' || pid === null || !Number.isSafeInteger(pid) || pid <= 0) {
    return null;
  }
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat
      .slice(stat.lastIndexOf(')') + 2)
      .trim()
      .split(/\s+/);
    if (fields[0] === 'Z' || fields[0] === 'X') return null;
    const start = fields[19]; // Linux stat field 22: process start time.
    const boot = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    if (!start || !boot) return null;
    return `${boot}:${start}`;
  } catch {
    return null;
  }
}

export function createSessionWork(
  identity: (pid: number) => string | null = sessionProcessIdentity,
) {
  const sessions = new Map<string, { pid: number; birth: string }>();
  return {
    hold(id: string, pid: number | null, expectedBirth?: string | null): string | null {
      sessions.delete(id);
      if (pid === null) return null;
      const birth = identity(pid);
      if (birth === null || (expectedBirth !== undefined && birth !== expectedBirth)) return null;
      sessions.set(id, { pid, birth });
      return birth;
    },
    release(id: string) {
      sessions.delete(id);
    },
    clear() {
      sessions.clear();
    },
    isBusy() {
      for (const [id, session] of sessions) {
        if (identity(session.pid) !== session.birth) sessions.delete(id);
      }
      return sessions.size > 0;
    },
  };
}

export const sessionWork = createSessionWork();
onDaemonBusy(() => sessionWork.isBusy());
onDaemonStarted(async (db) => {
  sessionWork.clear();
  const result = await db.query<{ id: string; pid: number; process_birth: string }>(
    `SELECT id, pid, process_birth FROM agent_sessions
     WHERE ended_at IS NULL AND pid IS NOT NULL AND process_birth IS NOT NULL`,
  );
  for (const row of result.rows) {
    sessionWork.hold(row.id, row.pid, row.process_birth);
  }
});
onAgentEnded((id) => sessionWork.release(id));
onDaemonStopping(() => sessionWork.clear());
