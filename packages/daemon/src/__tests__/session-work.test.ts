import { describe, expect, it } from 'vitest';
import { createSessionWork } from '../session-work.js';

describe('local session work', () => {
  it.skipIf(process.platform !== 'linux')('recognizes the actual local process', () => {
    const work = createSessionWork();
    work.hold('self', process.pid);
    expect(work.isBusy()).toBe(true);
    work.release('self');
    expect(work.isBusy()).toBe(false);
  });

  it('holds work between RPCs until the session ends', () => {
    const work = createSessionWork(() => 'birth-1');
    work.hold('agent', 123);
    expect(work.isBusy()).toBe(true);
    work.release('agent');
    expect(work.isBusy()).toBe(false);
  });

  it('releases a process that exits or whose PID is reused', () => {
    let birth: string | null = 'birth-1';
    const work = createSessionWork(() => birth);
    work.hold('agent', 123);
    birth = 'birth-2';
    expect(work.isBusy()).toBe(false);
    work.hold('agent', 123);
    birth = null;
    expect(work.isBusy()).toBe(false);
  });

  it('does not hold missing processes and clears on shutdown', () => {
    const work = createSessionWork((pid) => pid === 123 ? 'birth' : null);
    work.hold('missing', 456);
    work.hold('unknown', null);
    expect(work.isBusy()).toBe(false);
    work.hold('agent', 123);
    work.clear();
    expect(work.isBusy()).toBe(false);
  });
});
