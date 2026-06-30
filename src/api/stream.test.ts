/** Broadcaster unit tests (Milestone 5): subscribe/publish fan-out, unsubscribe, and subscriber isolation. */

import { describe, expect, it, vi } from 'vitest';

import { Broadcaster, type StreamEvent } from './stream';

const event: StreamEvent = { type: 'status', runId: 1, status: 'paused', run: {} as never };

describe('Broadcaster', () => {
  it('fans an event out to every subscriber and tracks size', () => {
    const b = new Broadcaster();
    const a = vi.fn();
    const c = vi.fn();
    b.subscribe(a);
    b.subscribe(c);
    expect(b.size).toBe(2);

    b.publish(event);
    expect(a).toHaveBeenCalledWith(event);
    expect(c).toHaveBeenCalledWith(event);
  });

  it('stops delivering after unsubscribe', () => {
    const b = new Broadcaster();
    const listener = vi.fn();
    const off = b.subscribe(listener);
    off();
    expect(b.size).toBe(0);

    b.publish(event);
    expect(listener).not.toHaveBeenCalled();
  });

  it('isolates a throwing subscriber so others still receive the event', () => {
    const b = new Broadcaster();
    const ok = vi.fn();
    b.subscribe(() => {
      throw new Error('boom');
    });
    b.subscribe(ok);

    expect(() => b.publish(event)).not.toThrow();
    expect(ok).toHaveBeenCalledWith(event);
  });
});
