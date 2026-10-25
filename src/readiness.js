export function needsReadinessReview({ isHost, ready }) {
  return !isHost && ready !== true;
}

export function canStartRoom(players = []) {
  const active = players.filter((player) => player.active !== false);
  return active.length >= 2 && active.every((player) => player.ready === true);
}

export function readinessLabel(player, hostId) {
  const status = player.ready ? 'Ready' : 'Not ready';
  return player.id === hostId ? `Host · ${status}` : player.ready ? 'Ready to play' : 'Reviewing the rules';
}

export function verifyReadyReadback(room, playerId) {
  const player = room?.players?.find((entry) => entry.id === playerId);
  if (!player) return { confirmed: false, reason: 'player-missing', readyValue: null };
  if (!Object.prototype.hasOwnProperty.call(player, 'ready')) {
    return { confirmed: false, reason: 'ready-field-missing', readyValue: null };
  }
  if (player.ready !== true) return { confirmed: false, reason: 'not-ready', readyValue: player.ready };
  return { confirmed: true, reason: null, readyValue: true };
}
