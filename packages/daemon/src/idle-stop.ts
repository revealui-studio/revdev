/**
 * Stop only after a continuous idle window.
 * Recheck busy work so completion needs no socket-disconnect event.
 */
export interface IdleStop {
  onConnect(): void;
  onDisconnect(): void;
  arm(): void;
  stop(): void;
}

export function createIdleStop(opts: {
  idleStopMs: number;
  isBusy: () => boolean;
  onIdle: () => void;
}): IdleStop {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let quietSince: number | null = null;
  let stopped = false;

  const clear = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };

  const schedule = () => {
    clear();
    if (stopped || opts.idleStopMs <= 0) return;
    const remaining =
      quietSince === null ? opts.idleStopMs : opts.idleStopMs - (Date.now() - quietSince);
    timer = setTimeout(check, Math.max(1, Math.min(1_000, remaining)));
    timer.unref?.();
  };

  const check = () => {
    timer = null;
    if (stopped) return;
    if (opts.isBusy()) {
      quietSince = null;
    } else {
      quietSince ??= Date.now();
      if (Date.now() - quietSince >= opts.idleStopMs) {
        stopped = true;
        opts.onIdle();
        return;
      }
    }
    schedule();
  };

  const arm = () => {
    if (stopped || opts.idleStopMs <= 0) return;
    quietSince = opts.isBusy() ? null : Date.now();
    schedule();
  };

  return {
    onConnect() {
      quietSince = null;
      clear();
    },
    onDisconnect: arm,
    arm,
    stop() {
      stopped = true;
      clear();
    },
  };
}
