import { execFile } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { promisify } from 'node:util';
import { createLogger } from '@revealui/utils/logger';
import { onAgentEnded, onDaemonBusy } from './eviction.js';

const exec = promisify(execFile);
const log = createLogger({ service: 'revdev-work-services' });

export function createWorkServiceQueue(run: (args: string[]) => Promise<unknown>) {
  const pending = new Map<string, Promise<void>>();
  function enqueue(id: string, args: string[]) {
    const previous = pending.get(id) ?? Promise.resolve();
    const next = previous.then(async () => { await run(args); }).catch(() => {
      log.warn('work service operation failed; inspect the lifecycle journal');
    });
    pending.set(id, next);
    void next.then(() => {
      if (pending.get(id) === next) pending.delete(id);
    });
  }
  return {
    enter(id: string, pid: number, workDir: string) {
      enqueue(id, ['enter', '--session', id, '--pid', String(pid), '--work-dir', workDir]);
    },
    leave(id: string) {
      enqueue(id, ['leave', '--session', id]);
    },
    isBusy: () => pending.size > 0,
  };
}

const queue = createWorkServiceQueue(async (args) => {
  const command = process.env.REVDEV_WORK_SERVICES_COMMAND;
  if (!command) return;
  if (!isAbsolute(command)) throw new Error('work services command must be absolute');
  await exec(command, args, { timeout: 120_000 });
});

export function enterWorkServices(id: string, pid: number | null, workDir: string) {
  if (pid !== null && process.env.REVDEV_WORK_SERVICES_COMMAND) {
    queue.enter(id, pid, workDir);
  }
}

onDaemonBusy(() => queue.isBusy());
onAgentEnded((id) => {
  if (process.env.REVDEV_WORK_SERVICES_COMMAND) queue.leave(id);
});
