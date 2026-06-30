import { describe, expect, it, vi } from 'vitest';

import type { SideEffectClaim } from '../store/repository';
import { AmbiguousSideEffectError, SideEffectLedger, type SideEffectStore } from './side-effects';

/** A fake store whose `beginSideEffect` returns scripted claims, recording calls for assertions. */
function fakeStore(claims: SideEffectClaim[]): SideEffectStore & { begins: string[]; completes: Array<[string, unknown]> } {
  const begins: string[] = [];
  const completes: Array<[string, unknown]> = [];
  let i = 0;
  return {
    begins,
    completes,
    beginSideEffect(_runId, key) {
      begins.push(key);
      return claims[i++] ?? { state: 'fresh' };
    },
    completeSideEffect(_runId, key, result) {
      completes.push([key, result]);
    },
  };
}

describe('SideEffectLedger.once', () => {
  it('performs the call on a fresh slot and records the result', async () => {
    const store = fakeStore([{ state: 'fresh' }]);
    const ledger = new SideEffectLedger(store, 7, 'triage#0');
    const perform = vi.fn().mockResolvedValue({ id: 42 });

    const result = await ledger.once('signoff', perform);

    expect(result).toEqual({ id: 42 });
    expect(perform).toHaveBeenCalledOnce();
    expect(store.begins).toEqual(['triage#0:signoff']);
    expect(store.completes).toEqual([['triage#0:signoff', { id: 42 }]]);
  });

  it('reuses a completed slot WITHOUT performing the call again (the no-duplicate guarantee)', async () => {
    const store = fakeStore([{ state: 'done', result: { id: 42 } }]);
    const ledger = new SideEffectLedger(store, 7, 'triage#0');
    const perform = vi.fn().mockResolvedValue({ id: 99 });

    const result = await ledger.once('signoff', perform);

    expect(result).toEqual({ id: 42 }); // the stored result, not the re-performed one
    expect(perform).not.toHaveBeenCalled();
    expect(store.completes).toEqual([]); // nothing re-recorded
  });

  it('throws AmbiguousSideEffectError on a pending slot and never performs the call', async () => {
    const store = fakeStore([{ state: 'pending' }, { state: 'pending' }]);
    const ledger = new SideEffectLedger(store, 7, 'triage#0');
    const perform = vi.fn().mockResolvedValue({ id: 1 });

    await expect(ledger.once('subissue:0', perform)).rejects.toBeInstanceOf(AmbiguousSideEffectError);
    await expect(ledger.once('subissue:0', perform)).rejects.toMatchObject({ key: 'triage#0:subissue:0' });
    expect(perform).not.toHaveBeenCalled();
  });

  it('builds the slot key from the prefix so call sites pass only the slot', async () => {
    const store = fakeStore([{ state: 'fresh' }, { state: 'fresh' }]);
    const ledger = new SideEffectLedger(store, 1, 'code_review#2');
    await ledger.once('comment:0', () => Promise.resolve(null));
    await ledger.once('comment:1', () => Promise.resolve(null));
    expect(store.begins).toEqual(['code_review#2:comment:0', 'code_review#2:comment:1']);
  });
});
