import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRevealSteps, startingCoinSnapshot, MOVE_POSES, MAX_REVEAL_MS, REVEAL_ACTION_MS, REVEAL_STEP_MS } from '../src/revealSequence.js';

test('all six server action names map to articulated character poses', () => {
  assert.deepEqual(MOVE_POSES, {
    search: 'search', steal: 'steal', trap: 'trap', guard: 'guard',
    dig_deep: 'dig', explore: 'explore',
  });
});

test('ordinary steal credits and debits the exact authoritative transfer', () => {
  const steps = buildRevealSteps([
    { player_id: 'thief', name: 'Thief', choice: 'steal', target_id: 'target', target_name: 'Target' },
    { type: 'theft', thief_id: 'thief', target_id: 'target', amount: 2 },
  ]);
  assert.deepEqual(steps[0].deltas, { thief: 2, target: -2 });
  assert.deepEqual(steps[0].effects.map(effect => effect.kind), ['steal-success', 'steal-victim']);
});

test('Trap penalties target current server outcomes and pay each Trap setter once', () => {
  const steps = buildRevealSteps([
    { player_id: 'trapper', choice: 'trap', delta: -1 },
    { player_id: 'thief-a', choice: 'steal', target_id: 'trapper' },
    { player_id: 'thief-b', choice: 'steal', target_id: 'trapper' },
    { type: 'trap_penalty', thief_id: 'thief-a', target_id: 'trapper', amount: 1 },
    { type: 'trap_penalty', thief_id: 'thief-b', target_id: 'trapper', amount: 0 },
    { type: 'trap_blocked', target_id: 'trapper', delta: 2 },
  ]);
  assert.deepEqual(steps[0].deltas, { trapper: -1 });
  assert.deepEqual(steps[1].deltas, { 'thief-a': -1, trapper: 2 });
  assert.deepEqual(steps[2].deltas, {});
  assert.equal(steps.flatMap(step => step.effects).filter(effect => effect.kind === 'trap-reward').length, 1);
  assert.equal(steps.flatMap(step => step.effects).filter(effect => effect.kind === 'trap-sprung').length, 1);
});

test('Guard blocks steals without introducing a coin delta', () => {
  const [step] = buildRevealSteps([
    { player_id: 'thief', choice: 'steal', target_id: 'guard' },
    { type: 'guard_blocked', thief_id: 'thief', target_id: 'guard' },
  ]);
  assert.deepEqual(step.deltas, {});
  assert.deepEqual(step.effects.map(effect => effect.kind), ['steal-blocked', 'guard-shield']);
});

test('Dig Deep and Explore carry their authoritative win/fail reveal variants', () => {
  const steps = buildRevealSteps([
    { player_id: 'dig-win', choice: 'dig_deep', success: true, delta: 3 },
    { player_id: 'dig-fail', choice: 'dig_deep', success: false, delta: -1 },
    { player_id: 'map-win', choice: 'explore', success: true, delta: 2 },
    { player_id: 'map-empty', choice: 'explore', success: false, delta: 0 },
  ]);
  assert.deepEqual(steps.map(step => step.effects[0].kind), ['dig-win', 'dig-fail', 'explore-bonus', 'explore-empty']);
  assert.deepEqual(steps.map(step => Object.values(step.deltas)[0] ?? 0), [3, -1, 2, 0]);
});

test('round-one balances are reconstructed from final server balances and event deltas', () => {
  const snapshot = startingCoinSnapshot({
    events: [{ player_id: 'a', choice: 'search', delta: 2 }, { player_id: 'b', choice: 'explore', success: false, delta: 0 }],
    coins: { a: 7, b: 5 },
  }, null);
  assert.deepEqual(snapshot, { a: 5, b: 5 });
});

test('eight simultaneous moves fit the reveal budget without overlapping outcomes', () => {
  const events = Array.from({ length: 8 }, (_, index) => ({ player_id: `p${index}`, choice: 'search', delta: 2 }));
  const steps = buildRevealSteps(events);
  assert.equal(steps.length, 8);
  assert.equal(MAX_REVEAL_MS, REVEAL_ACTION_MS + steps.length * REVEAL_STEP_MS);
  assert.ok(MAX_REVEAL_MS < 6000);
});
