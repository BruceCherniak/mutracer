import { describe, expect, it } from 'vitest';
import { updateProgressiveState, type ProgressiveState } from '../../src/renderer/progressiveScheduler';

describe('consecutive-edit heuristic', () => {
  it('leaves isolated edits immediate and holds consecutive edits until idle', () => {
    const policy = policyFixture();
    expect(policy.update(true, false, 0, 150)).toBe(false);
    expect(policy.update(false, false, 16, 150)).toBe(false);
    expect(policy.update(true, false, 32, 150)).toBe(false);
    expect(policy.update(true, false, 48, 150)).toBe(true);
    expect(policy.update(false, false, 197, 150)).toBe(true);
    expect(policy.update(false, false, 198, 150)).toBe(false);
  });
  it('lets an explicit interaction end without an idle tail', () => {
    const policy = policyFixture();
    policy.update(true, false, 0, 150); policy.update(true, false, 16, 150);
    expect(policy.update(true, true, 32, 150)).toBe(true);
    expect(policy.update(true, false, 48, 150)).toBe(false);
  });
  it('resets stale heuristic state', () => {
    let policy = policyFixture();
    policy.update(true, false, 0, 150); policy.update(true, false, 16, 150); policy = policyFixture();
    expect(policy.update(false, false, 32, 150)).toBe(false);
  });
});

function policyFixture() {
  let state: ProgressiveState = {previousChanged: false, lastContinuousChange: -Infinity, changing: false};
  return {update(changed: boolean, active: boolean, now: number, idleMs: number) {
    const before = {...state};
    const next = updateProgressiveState(state, changed, active, now, idleMs);
    expect(state).toEqual(before); state = next; return state.changing;
  }};
}
