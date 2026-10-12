import { describe, expect, it, vi } from 'vitest';
import { createWorkServiceQueue } from '../work-services.js';

describe('work service operation ordering', () => {
  it('finishes enter before leave even when a session ends immediately', async () => {
    let finish!: () => void;
    const entering = new Promise<void>((resolve) => { finish = resolve; });
    const run = vi.fn().mockImplementationOnce(() => entering).mockResolvedValue(undefined);
    const queue = createWorkServiceQueue(run);
    queue.enter('agent', 123, '/project');
    queue.leave('agent');
    await Promise.resolve();
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]?.[0]?.[0]).toBe('enter');
    expect(queue.isBusy()).toBe(true);
    finish();
    await vi.waitFor(() => expect(queue.isBusy()).toBe(false));
    expect(run.mock.calls[1]?.[0]).toEqual(['leave', '--session', 'agent']);
  });

  it('still attempts leave when enter fails', async () => {
    const run = vi.fn().mockRejectedValueOnce(new Error('failed')).mockResolvedValue(undefined);
    const queue = createWorkServiceQueue(run);
    queue.enter('agent', 123, '/project');
    queue.leave('agent');
    await vi.waitFor(() => expect(queue.isBusy()).toBe(false));
    expect(run).toHaveBeenCalledTimes(2);
  });
});
