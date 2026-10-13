import { randomUUID } from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { sessionProcessIdentity, sessionWork } from './session-work.js';

export function createSessionRegistrations() {
  const pending = new Map<string, string>();
  const tails = new Map<string, Promise<void>>();
  return {
    async run<T>(id: string, operation: (generation: string) => Promise<T>): Promise<T> {
      const previous = tails.get(id) ?? Promise.resolve();
      let release!: () => void;
      const completed = new Promise<void>((resolve) => {
        release = resolve;
      });
      const tail = previous.then(() => completed);
      tails.set(id, tail);
      await previous;
      const generation = randomUUID();
      pending.set(id, generation);
      try {
        return await operation(generation);
      } finally {
        if (pending.get(id) === generation) pending.delete(id);
        release();
        if (tails.get(id) === tail) tails.delete(id);
      }
    },
    async finalize(
      db: PGlite,
      id: string,
      generation: string,
      pid: number | null,
      birth: string | null,
      onAdmitted: () => void = () => {},
    ) {
      if (pending.get(id) !== generation) return false;
      const currentBirth = sessionProcessIdentity(pid);
      const admittedBirth = currentBirth === birth ? birth : null;
      const updated = await db.query<{ id: string }>(
        `UPDATE agent_sessions SET process_birth = $2
         WHERE id = $1 AND registration_generation = $3 AND pid IS NOT DISTINCT FROM $4
         RETURNING id`,
        [id, admittedBirth, generation, pid],
      );
      // A newer registration may begin while the conditional write is pending.
      if (updated.rows.length === 0 || pending.get(id) !== generation) return false;
      sessionWork.hold(id, pid, admittedBirth);
      onAdmitted();
      return true;
    },
  };
}
export const sessionRegistrations = createSessionRegistrations();
