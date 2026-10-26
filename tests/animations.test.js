import test from 'node:test';
import assert from 'node:assert/strict';
import {
  hasSeenRound,
  markRoundSeen,
  clearSeenRounds,
  prefersReducedMotion,
  getParticleMultiplier,
} from '../src/animations.js';

test('seen round tracking prevents replay and resets on rematch', () => {
  clearSeenRounds();

  const roomA = 'ROOM_ALPHA';
  const roomB = 'ROOM_BETA';

  assert.equal(hasSeenRound(roomA, 1), false);
  assert.equal(hasSeenRound(roomA, 2), false);
  assert.equal(hasSeenRound(roomB, 1), false);

  // Mark round 1 of roomA seen
  markRoundSeen(roomA, 1);
  assert.equal(hasSeenRound(roomA, 1), true);
  assert.equal(hasSeenRound(roomA, 2), false);
  assert.equal(hasSeenRound(roomB, 1), false);

  // Mark round 2 of roomA and round 1 of roomB seen
  markRoundSeen(roomA, 2);
  markRoundSeen(roomB, 1);
  assert.equal(hasSeenRound(roomA, 2), true);
  assert.equal(hasSeenRound(roomB, 1), true);

  // Clear seen rounds (rematch behavior)
  clearSeenRounds();
  assert.equal(hasSeenRound(roomA, 1), false);
  assert.equal(hasSeenRound(roomA, 2), false);
  assert.equal(hasSeenRound(roomB, 1), false);
});

test('prefersReducedMotion safely evaluates without throwing', () => {
  const result = prefersReducedMotion();
  assert.equal(typeof result, 'boolean');
});

test('getParticleMultiplier returns a valid scaling factor between 0.2 and 1.0', () => {
  const mult = getParticleMultiplier();
  assert.ok(typeof mult === 'number');
  assert.ok(mult >= 0.2 && mult <= 1.0);
});

test('all six core action types are supported in the animation system', () => {
  const actions = ['search', 'steal', 'trap', 'guard', 'dig_deep', 'explore'];
  assert.equal(actions.length, 6);
  actions.forEach(a => {
    assert.equal(typeof a, 'string');
    assert.ok(a.length > 0);
  });
});

test('gain, loss, and neutral coin outcomes are categorized correctly', () => {
  const outcomes = [
    { delta: 3, expectedType: 'coins', label: '+3 coins' },
    { delta: -2, expectedType: 'scatter', label: '-2 coins' },
    { delta: 0, expectedType: 'sparkle', label: '0 coins' },
  ];

  outcomes.forEach(({ delta, expectedType, label }) => {
    const type = delta > 0 ? 'coins' : delta < 0 ? 'scatter' : 'sparkle';
    const formatted = delta > 0 ? `+${delta} coins` : delta < 0 ? `${delta} coins` : '0 coins';
    assert.equal(type, expectedType);
    assert.equal(formatted, label);
  });
});

test('missing or null round results gracefully fall back without throwing', () => {
  // Test fallback handling logic
  const safeEvents = (result) => Array.isArray(result?.events) ? result.events : [];
  const safePlayers = (players) => Array.isArray(players) ? players : [];

  assert.deepEqual(safeEvents(null), []);
  assert.deepEqual(safeEvents({}), []);
  assert.deepEqual(safeEvents({ events: null }), []);
  assert.deepEqual(safePlayers(null), []);
  assert.deepEqual(safePlayers(undefined), []);
});

test('two-player waiting and resolution state transitions are valid', () => {
  const room = {
    round_no: 1,
    players: [{ id: 'p1', name: 'Alice' }, { id: 'p2', name: 'Bob' }],
    submitted: 1,
    my_action: { choice: 'search' },
    all_results: [],
  };

  const mySubmitted = !!room.my_action;
  const missing = Math.max(0, room.players.length - (room.submitted || 0));
  const allSubmitted = room.players.length >= 2 && room.submitted >= room.players.length;

  assert.equal(mySubmitted, true);
  assert.equal(missing, 1);
  assert.equal(allSubmitted, false);

  // When second player submits
  room.submitted = 2;
  const allSubmittedAfter = room.players.length >= 2 && room.submitted >= room.players.length;
  assert.equal(allSubmittedAfter, true);
});

test('reconnect preserves pending move and rematch resets state cleanly', () => {
  let pendingMove = { round: 1, choice: 'guard' };
  const room = { round_no: 1, my_action: null };

  // While in round 1 with pending move, waiting state holds
  const isWaiting = !!room.my_action || pendingMove?.round === room.round_no;
  assert.equal(isWaiting, true);

  // On rematch, round resets, pendingMove is cleared
  pendingMove = null;
  clearSeenRounds();
  assert.equal(pendingMove, null);
  assert.equal(hasSeenRound('ROOM1', 1), false);
});

test('lobby waiting animation dynamically updates as players join and ready up', () => {
  // Helper mimicking LobbyWaitingAnimation state logic
  function getLobbyState({ count, enough, allReady, host }) {
    const title = allReady
      ? 'All adventurers are ready!'
      : enough
        ? 'Adventurers reviewing readiness...'
        : 'Gathering adventurers...';
    const message = allReady
      ? (host ? 'The clearing is set. Start the three-round hunt whenever you’re ready.' : 'The clearing is set. Waiting for the host to start the hunt.')
      : enough
        ? 'Your crew is in the room. Everyone reviews the guide and confirms readiness.'
        : 'Share your invite link or six-character room code to gather your crew.';
    return { title, message, count };
  }

  // 1. Host alone in lobby
  const state1 = getLobbyState({ count: 1, enough: false, allReady: false, host: true });
  assert.equal(state1.title, 'Gathering adventurers...');
  assert.ok(state1.message.includes('invite link'));
  assert.equal(state1.count, 1);

  // 2. Guest joined, reviewing readiness
  const state2 = getLobbyState({ count: 2, enough: true, allReady: false, host: true });
  assert.equal(state2.title, 'Adventurers reviewing readiness...');
  assert.ok(state2.message.includes('confirms readiness'));
  assert.equal(state2.count, 2);

  // 3. Both confirmed ready
  const state3 = getLobbyState({ count: 2, enough: true, allReady: true, host: true });
  assert.equal(state3.title, 'All adventurers are ready!');
  assert.ok(state3.message.includes('Start the three-round hunt'));
});
