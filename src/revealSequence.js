// Build a compact, server-result-driven sequence. This module contains no game
// rules: it only groups authoritative result deltas into reveal animations.
export const MOVE_POSES = Object.freeze({
  search: 'search', steal: 'steal', trap: 'trap', guard: 'guard',
  dig_deep: 'dig', explore: 'explore',
});
export const REVEAL_ACTION_MS = 1400;
export const REVEAL_STEP_MS = 450;
export const MAX_REVEAL_MS = REVEAL_ACTION_MS + 8 * REVEAL_STEP_MS;

const addDelta = (deltas, playerId, amount) => {
  if (!playerId || !Number.isFinite(Number(amount)) || !Number(amount)) return;
  deltas[playerId] = (deltas[playerId] || 0) + Number(amount);
};

/** Group one reveal step per submitted move (at most eight steps). */
export function buildRevealSteps(events = []) {
  const actions = events.filter(event => event?.choice && event?.player_id);
  const outcomes = events.filter(event => event?.type);
  const rewardedTraps = new Set();

  return actions.map(action => {
    const deltas = {};
    const effects = [];
    if (action.choice !== 'steal') {
      addDelta(deltas, action.player_id, action.delta);
      const kind = action.choice === 'dig_deep' ? (action.success ? 'dig-win' : 'dig-fail')
        : action.choice === 'explore' ? (action.success ? 'explore-bonus' : 'explore-empty') : action.choice;
      if (Number(action.delta) || action.choice === 'explore') effects.push({ playerId: action.player_id, delta: Number(action.delta || 0), kind });
      return { action, deltas, effects };
    }

    for (const outcome of outcomes) {
      if (outcome.thief_id !== action.player_id) continue;
      if (outcome.type === 'theft') {
        const amount = Number(outcome.amount);
        addDelta(deltas, outcome.thief_id, amount);
        addDelta(deltas, outcome.target_id, -amount);
        if (amount > 0) {
          effects.push({ playerId: outcome.thief_id, delta: amount, kind: 'steal-success', peerId: outcome.target_id });
          effects.push({ playerId: outcome.target_id, delta: -amount, kind: 'steal-victim', peerId: outcome.thief_id });
        }
      } else if (outcome.type === 'trap_penalty') {
        const amount = Number(outcome.amount || 0);
        addDelta(deltas, outcome.thief_id, -amount);
        if (amount) effects.push({ playerId: outcome.thief_id, delta: -amount, kind: 'trap-sprung', peerId: outcome.target_id });
        const trapReward = outcomes.find(item => item.type === 'trap_blocked' && item.target_id === outcome.target_id);
        if (trapReward && !rewardedTraps.has(outcome.target_id)) {
          rewardedTraps.add(outcome.target_id);
          addDelta(deltas, trapReward.target_id, Number(trapReward.delta ?? 2));
          effects.push({ playerId: trapReward.target_id, delta: Number(trapReward.delta ?? 2), kind: 'trap-reward', peerId: outcome.thief_id });
        }
      } else if (outcome.type === 'guard_blocked') {
        effects.push({ playerId: outcome.thief_id, delta: 0, kind: 'steal-blocked', peerId: outcome.target_id });
        effects.push({ playerId: outcome.target_id, delta: 0, kind: 'guard-shield', peerId: outcome.thief_id });
      }
    }
    return { action, deltas, effects };
  });
}

export function startingCoinSnapshot(result, previous) {
  const start = { ...(previous?.coins || {}) };
  const totals = {};
  for (const step of buildRevealSteps(result?.events || [])) {
    for (const [playerId, amount] of Object.entries(step.deltas)) totals[playerId] = (totals[playerId] || 0) + amount;
  }
  for (const [playerId, finalCoins] of Object.entries(result?.coins || {})) {
    if (start[playerId] == null) start[playerId] = Number(finalCoins) - (totals[playerId] || 0);
  }
  return start;
}
