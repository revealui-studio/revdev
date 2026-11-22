import { afterEach, describe, expect, it, vi } from 'vitest';
import { createIdleStop } from '../idle-stop.js';

describe('createIdleStop', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires only after the idle window with zero clients', () => {
    vi.useFakeTimers();
    const onIdle = vi.fn();
    let clients = 0;
    const idle = createIdleStop({
      idleStopMs: 5_000,
      isBusy: () => clients > 0,
      onIdle,
    });

    idle.arm();
    vi.advanceTimersByTime(4_999);
    expect(onIdle).not.toHaveBeenCalled();

    clients = 1;
    idle.onConnect();
    vi.advanceTimersByTime(10_000);
    expect(onIdle).not.toHaveBeenCalled();

    clients = 0;
    idle.onDisconnect();
    vi.advanceTimersByTime(5_000);
    expect(onIdle).toHaveBeenCalledOnce();
  });

  it('does nothing when idle stop is disabled', () => {
    vi.useFakeTimers();
    const onIdle = vi.fn();
    const idle = createIdleStop({
      idleStopMs: 0,
      isBusy: () => false,
      onIdle,
    });
    idle.arm();
    idle.onDisconnect();
    vi.advanceTimersByTime(60_000);
    expect(onIdle).not.toHaveBeenCalled();
  });
});

describe('work-aware idle stop', () => {
  afterEach(() => vi.useRealTimers());

  it('waits for disconnected work to finish and then a full idle window', () => {
    vi.useFakeTimers();
    let busy = true;
    const onIdle = vi.fn();
    const idle = createIdleStop({
      idleStopMs: 5_000,
      isBusy: () => busy,
      onIdle,
    });
    idle.arm();
    vi.advanceTimersByTime(10_000);
    expect(onIdle).not.toHaveBeenCalled();
    busy = false;
    vi.advanceTimersByTime(1_000);
    vi.advanceTimersByTime(4_999);
    expect(onIdle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onIdle).toHaveBeenCalledOnce();
  });

  it('restarts the idle window when work interrupts it', () => {
    vi.useFakeTimers();
    let busy = false;
    const onIdle = vi.fn();
    const idle = createIdleStop({
      idleStopMs: 5_000,
      isBusy: () => busy,
      onIdle,
    });
    idle.arm();
    vi.advanceTimersByTime(4_000);
    busy = true;
    vi.advanceTimersByTime(1_000);
    busy = false;
    vi.advanceTimersByTime(1_000);
    vi.advanceTimersByTime(4_999);
    expect(onIdle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onIdle).toHaveBeenCalledOnce();
  });

  it('cannot rearm after shutdown', () => {
    vi.useFakeTimers();
    const onIdle = vi.fn();
    const idle = createIdleStop({
      idleStopMs: 5_000,
      isBusy: () => false,
      onIdle,
    });
    idle.arm();
    idle.stop();
    idle.onDisconnect();
    idle.arm();
    vi.advanceTimersByTime(60_000);
    expect(onIdle).not.toHaveBeenCalled();
  });
});
