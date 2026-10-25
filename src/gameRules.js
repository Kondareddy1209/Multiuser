import { Compass, Swords, Shield, ShieldCheck, Shovel, Map } from 'lucide-react';

export const actions = [
  { id: 'search', title: 'Search', label: 'Search for Treasure', Icon: Compass, cost: 0, tone: 'moss', summary: 'Find 2 coins. No target needed.', net: '+2 coins' },
  { id: 'steal', title: 'Steal', label: 'Steal from a Rival', Icon: Swords, cost: 0, tone: 'berry', summary: 'Target a rival and request up to 2 coins.', net: 'up to +2' },
  { id: 'trap', title: 'Trap', label: 'Set a Trap', Icon: Shield, cost: 1, tone: 'gold', summary: 'Block all steals aimed at you; each thief loses up to 2. Gain 2 once if sprung.', net: 'cost 1 · blocks + reward' },
  { id: 'guard', title: 'Guard', label: 'Guard', Icon: ShieldCheck, cost: 1, tone: 'guard', summary: 'Block all steals aimed at you. No trap reward or thief penalty.', net: 'cost 1 · blocks' },
  { id: 'dig_deep', title: 'Dig Deep', label: 'Dig Deep', Icon: Shovel, cost: 1, tone: 'dig', summary: 'Pay 1. On a 50% success, gain 4; otherwise lose the cost.', net: '−1 or +3' },
  { id: 'explore', title: 'Explore', label: 'Explore', Icon: Map, cost: 1, tone: 'explore', summary: 'Pay 1, get 1 back, then 50% chance to find 2 more.', net: '0 or +2' },
];

export const actionById = Object.fromEntries(actions.map((action) => [action.id, action]));

export function coinCost(actionId) {
  return actionById[actionId]?.cost ?? Infinity;
}

export function netOutcome(actionId, success = false) {
  switch (actionId) {
    case 'search': return 2;
    case 'steal': return 0;
    case 'trap':
    case 'guard': return -1;
    case 'dig_deep': return success ? 3 : -1;
    case 'explore': return success ? 2 : 0;
    default: return null;
  }
}

export function splitSteal(balance, attackers) {
  const count = attackers.length;
  if (count === 0) return [];
  const total = Math.min(Math.max(0, balance), 2 * count);
  const base = Math.floor(total / count);
  const remainder = total % count;
  return attackers.map((playerId, index) => ({
    playerId,
    amount: base + (index < remainder ? 1 : 0),
  }));
}
export function getWinners(players) {
  if (!players.length) return [];
  const highScore = Math.max(...players.map((player) => player.coins));
  return players.filter((player) => player.coins === highScore);
}
