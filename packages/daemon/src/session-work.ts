import { readFileSync } from 'node:fs';
import { onAgentEnded, onDaemonBusy, onDaemonStopping } from './eviction.js';

function processIdentity(pid: number): string | null {
  if (process.platform !== 'linux' || !Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat
      .slice(stat.lastIndexOf(')') + 2)
      .trim()
      .split(/\s+/);
    if (fields[0] === 'Z' || fields[0] === 'X') return null;
    return fields[19] ?? null; // Linux stat field 22: process start time.
  } catch {
    return null;
  }
}

export function createSessionWork(identity: (pid: number) => string | null = processIdentity) {
  const sessions = new Map<string, { pid: number; birth: string }>();
  return {
    hold(id: string, pid: number | null) {
      sessions.delete(id);
      if (pid === null) return;
      const birth = identity(pid);
      if (birth !== null) sessions.set(id, { pid, birth });
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
onAgentEnded((id) => sessionWork.release(id));
onDaemonStopping(() => sessionWork.clear());
