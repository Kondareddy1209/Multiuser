/**
 * Treasure Plots — React Animation Components
 *
 * Provides:
 *  - <AnimatedWaiting>   Floating 3D chest, orbiting gold coins, ambient sparkles, live authoritative count
 *  - <ChestScene>        CSS-3D perspective treasure chest used in Search/DigDeep/Explore reveals
 *  - <AnimatedPlayerRow> Staggered revealed player cards with net coin change badges
 *  - <VictoryOverlay>    Full-screen celebration with trophy shine, coin rain, and keyboard-accessible skip
 *  - <AnimatedCoinCount> Animated numerical balance display
 *  - useRoundAnimation   Hook that deduplicates round animations via seen-round tracking
 *
 * STRICT CONTRACT: animations only fire when authoritative Supabase data
 * arrives (result.events from round_results). Never before.
 */
import React, { useEffect, useLayoutEffect, useRef, useState, useCallback } from 'react';
import {
  prefersReducedMotion,
  hasSeenRound,
  markRoundSeen,
  clearSeenRounds,
  playVictoryCelebration,
  mountChestAnimation,
  floatCoinLabel,
} from './animations.js';
import { buildRevealSteps, startingCoinSnapshot, MOVE_POSES, REVEAL_ACTION_MS, REVEAL_STEP_MS } from './revealSequence.js';

// ---------------------------------------------------------------------------
// Hook: deduplication + sequencing for a single round
// ---------------------------------------------------------------------------

/**
 * Returns a stable ref to "animate this round" — fires once per (roomId, roundNo).
 * @param {string} roomId
 * @param {number} roundNo
 * @param {object[]} events   Supabase result.events array
 * @param {object[]} players  Room players for coin-change lookup
 * @param {object} prev       Previous round coin snapshot
 * @param {object} current    Current round coin snapshot
 */
export function useRoundAnimation(roomId, roundNo, events, prev, current, animate = false) {
  const [timeline, setTimeline] = useState({ state: 'idle', step: -1, balances: {}, activeEffects: [] });

  useLayoutEffect(() => {
    if (!roomId || !roundNo || !events?.length) return;
    const finalBalances = current?.coins || {};
    const key = `${roomId}:${roundNo}`;
    const finish = () => setTimeline({ state: 'done', step: -1, balances: { ...finalBalances }, activeEffects: [] });
    if (!animate) {
      finish();
      return;
    }
    if (prefersReducedMotion() || hasSeenRound(roomId, roundNo)) {
      markRoundSeen(roomId, roundNo);
      finish();
      return;
    }

    markRoundSeen(roomId, roundNo);
    const sequence = buildRevealSteps(events);
    const initialBalances = startingCoinSnapshot(current, prev);
    setTimeline({ state: 'actions', step: -1, balances: initialBalances, activeEffects: [] });
    let timer;
    let index = 0;
    let balances = { ...initialBalances };
    timer = setTimeout(() => {
      if (!sequence.length) { finish(); return; }
      const runStep = () => {
        if (index >= sequence.length) { finish(); return; }
        const step = sequence[index];
        setTimeline({ state: 'outcomes', step: index, balances: { ...balances }, activeEffects: step.effects });
        timer = setTimeout(() => {
          for (const [playerId, delta] of Object.entries(step.deltas)) {
            balances[playerId] = Math.max(0, Number(balances[playerId] ?? 0) + Number(delta));
          }
          index += 1;
          if (index >= sequence.length) finish();
          else runStep();
        }, REVEAL_STEP_MS);
      };
      runStep();
    }, REVEAL_ACTION_MS);
    return () => clearTimeout(timer);
  // Room polling creates fresh object/array identities. Keying only on the
  // resolved round prevents the animation from restarting on each sync tick.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId, roundNo, animate]);

  const actionPoses = Object.fromEntries((events || []).filter(event => event?.choice && event?.player_id)
    .map(event => [event.player_id, MOVE_POSES[event.choice] || 'idle']));
  const activeStep = timeline.state === 'outcomes' ? buildRevealSteps(events || [])[timeline.step] : null;
  const poseFor = playerId => {
    if (timeline.state === 'actions') return actionPoses[playerId] || 'idle';
    if (timeline.state !== 'outcomes' || !activeStep) return 'idle';
    const effect = activeStep.effects.find(item => item.playerId === playerId);
    if (!effect) return 'idle';
    return effect.delta > 0 ? 'win' : effect.delta < 0 ? 'lose'
      : ['steal-blocked','explore-empty','dig-fail'].includes(effect.kind) ? 'lose' : 'guard';
  };
  const outcomeFor = playerId => activeStep?.effects.find(item => item.playerId === playerId)?.kind || '';
  const deltaFor = playerId => activeStep?.effects.filter(item => item.playerId === playerId).reduce((sum, item) => sum + item.delta, 0) ?? null;
  return { timeline, poseFor, outcomeFor, deltaFor };
}

// ---------------------------------------------------------------------------
// CSS-3D Treasure Chest Component
// ---------------------------------------------------------------------------

export function ChestScene({ mode = 'open', onDone, onSkip, className = '' }) {
  const containerRef = useRef(null);

  useEffect(() => {
    if (!containerRef.current) return;
    const cleanup = mountChestAnimation(containerRef.current, mode, 2600);
    const t = setTimeout(() => onDone?.(), 2700);
    return () => {
      cleanup();
      clearTimeout(t);
    };
  }, [mode, onDone]);

  return (
    <div className={`tp-chest-stage ${className}`}>
      <div
        ref={containerRef}
        className="tp-chest-scene"
        aria-hidden="true"
      />
      {onSkip && (
        <button
          type="button"
          className="tp-skip-chest"
          onClick={onSkip}
          aria-label="Skip chest reveal animation"
        >
          Skip animation →
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Action result card with animated badge
// ---------------------------------------------------------------------------

const ACTION_LABELS = {
  search:   { icon: '🧭', verb: 'Searched',   color: '#9fca8a' },
  steal:    { icon: '⚔️',  verb: 'Stole',      color: '#e8a090' },
  trap:     { icon: '🛡️', verb: 'Trapped',    color: '#d4c860' },
  guard:    { icon: '🔰', verb: 'Guarded',    color: '#88c8d8' },
  dig_deep: { icon: '⛏️', verb: 'Dug Deep',   color: '#d6ae88' },
  explore:  { icon: '🗺️', verb: 'Explored',   color: '#a9c99e' },
};

/**
 * Animated player-action row for the Reveal panel.
 */
export const AnimatedPlayerRow = React.forwardRef(function AnimatedPlayerRow(
  { event, avatarIndex = 0, pose = 'idle', revealState = 'done', balance, revealDelta = null, outcome = '', effectToken = '' },
  ref
) {
  const reduced = prefersReducedMotion();
  const [floatingDelta, setFloatingDelta] = useState(null);
  const labelTimer = useRef(null);
  useEffect(() => {
    if (revealDelta == null) return;
    if (reduced) { setFloatingDelta(revealDelta); return; }
    if (revealState === 'outcomes') {
      clearTimeout(labelTimer.current);
      setFloatingDelta(revealDelta);
      labelTimer.current = setTimeout(() => setFloatingDelta(null), 1200);
    }
  }, [effectToken, revealDelta, revealState, reduced]);
  useEffect(() => () => clearTimeout(labelTimer.current), []);

  const meta = ACTION_LABELS[event.choice] ?? { icon: '?', verb: event.choice, color: '#aaa' };
  const visibleBalance = balance == null ? '—' : Number(balance);
  const label = floatingDelta == null ? null : Number(floatingDelta);
  const showLabel = label !== null && (label !== 0 || ['explore-empty','dig-fail'].includes(outcome));

  return (
    <div
      ref={ref}
      data-pose={pose}
      data-reveal-state={revealState}
      className="revealed-player tp-reveal-player"
    >
      <RealisticWaitingCharacter pose={pose} outcome={outcome} reduced={reduced} className="tp-reveal-character" />
      <span className={`avatar av${avatarIndex % 6}`}>
        {event.name?.[0] ?? '?'}
      </span>
      <span>
        <b className="tp-reveal-name">{event.name}{showLabel && <i className={`tp-floating-delta ${label > 0 ? 'positive' : label < 0 ? 'negative' : 'neutral'}`} key={`${effectToken}-${label}`}>{label > 0 ? '+' : label < 0 ? '−' : ''}{Math.abs(label)}</i>}</b>
        <small>
          <span className="anim-action-icon" style={{ color: meta.color }}>{meta.icon}</span>
          {' '}
          {event.choice === 'steal'
            ? `Targeted ${event.target_name}`
            : meta.verb}
          {revealState === 'done' || revealDelta !== null ? (event.choice === 'dig_deep'
            ? (event.success ? ' · ✨ Found 4 coins!' : ' · Excavation empty')
            : event.choice === 'explore'
              ? (event.success ? ' · 🗺 Found 2 bonus coins!' : ' · No bonus find')
              : '') : ''}
        </small>
      </span>
      <span className="tp-reveal-balance" aria-label={`${event.name} has ${visibleBalance} coins`}>
        {revealState === 'outcomes' && <i className={`tp-coin-flight ${deltaForClass(label)} ${outcome}`} aria-hidden="true">🪙</i>}
        <b>{visibleBalance}</b><span aria-hidden="true">🪙</span>
      </span>
    </div>
  );
});

function deltaForClass(delta) { return Number(delta) > 0 ? 'gain' : Number(delta) < 0 ? 'spend' : 'neutral'; }

// ---------------------------------------------------------------------------
// Victory Overlay (mounted on the Final screen)
// ---------------------------------------------------------------------------

export function VictoryOverlay({ winners, onSkip, roomId }) {
  const [phase, setPhase] = useState('enter'); // enter | celebrate | done
  const [show, setShow] = useState(true);
  const overlayRef = useRef(null);
  const reduced = prefersReducedMotion();

  const handleSkip = useCallback(() => {
    setShow(false);
    onSkip?.();
  }, [onSkip]);

  // Keyboard shortcut: Escape or Enter skips the celebration
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape' || e.key === 'Enter') handleSkip();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [handleSkip]);

  useEffect(() => {
    if (reduced) {
      setPhase('done');
      return;
    }

    const cleanup = playVictoryCelebration(winners.length > 1 ? 2 : 1);

    const t1 = setTimeout(() => setPhase('celebrate'), 350);
    const t2 = setTimeout(() => setPhase('done'), 3200);

    return () => {
      cleanup();
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, [winners.length, reduced]);

  if (!show) return null;

  const isTie = winners.length > 1;

  return (
    <div
      ref={overlayRef}
      className={`tp-victory-overlay tp-victory-${phase}`}
      role="dialog"
      aria-modal="true"
      aria-label={isTie ? 'A Shared Victory celebration' : 'Winner celebration'}
    >
      {/* Radiant celebratory rays */}
      <div className="tp-victory-rays" aria-hidden="true" />

      <div className="tp-victory-inner">
        <div className="tp-victory-trophy" aria-hidden="true">
          {isTie ? '🏆🏆' : '🏆'}
        </div>
        <div className="tp-victory-eyebrow">
          {isTie ? '✦ A SHARED VICTORY ✦' : '✦ THE FOREST HAS A CHAMPION ✦'}
        </div>
        <div className="tp-victory-names">
          {winners.map(w => (
            <span key={w.id} className="tp-victory-name">
              {w.name}
            </span>
          ))}
        </div>
        <div className="tp-victory-coins">
          {winners[0]?.coins} Coins
        </div>
        <button
          type="button"
          className="tp-victory-skip"
          onClick={handleSkip}
          aria-label="Skip victory celebration"
        >
          View Final Leaderboard →
        </button>
      </div>

      {/* Floating coin rain */}
      {!reduced && Array.from({ length: 14 }).map((_, i) => (
        <span
          key={i}
          className="tp-coin-rain"
          style={{
            left: `${4 + i * 7}%`,
            animationDelay: `${i * 0.12}s`,
            animationDuration: `${1.3 + (i % 4) * 0.25}s`,
          }}
          aria-hidden="true"
        >
          🪙
        </span>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Animated score change in leaderboard sidebar
// ---------------------------------------------------------------------------

export function AnimatedCoinCount({ coins, prevCoins }) {
  const ref = useRef(null);
  const [display, setDisplay] = useState(coins);
  const prevRef = useRef(prevCoins ?? coins);
  const reduced = prefersReducedMotion();

  useEffect(() => {
    const from = prevRef.current;
    const to = coins;
    prevRef.current = coins;

    if (from === to || reduced) {
      setDisplay(to);
      return;
    }

    const steps = 18;
    const stepDuration = 500 / steps;
    let step = 0;
    const timer = setInterval(() => {
      step++;
      const progress = step / steps;
      const eased = 1 - Math.pow(1 - progress, 3);
      setDisplay(Math.round(from + (to - from) * eased));
      if (step >= steps) {
        clearInterval(timer);
        setDisplay(to);
        if (ref.current) floatCoinLabel(ref.current, to - from, 0);
      }
    }, stepDuration);

    return () => clearInterval(timer);
  }, [coins, reduced]);

  return <span ref={ref} className="tp-animated-coins">{display}</span>;
}

// ---------------------------------------------------------------------------
// Reused inline SVG from waiting-player.html; memoization keeps its CSS timeline steady during polling.
export const RealisticWaitingCharacter = React.memo(function RealisticWaitingCharacter({ reduced = false, active = false, pose = 'idle', outcome = '', className = '' }) {
  const animate = active && !reduced;
  const normalizedPose = ['idle','waiting','search','steal','trap','guard','dig','explore','win','lose'].includes(pose) ? pose : 'idle';
  const props = outcome ? ` outcome-${String(outcome).replace(/[^a-z-]/g, '')}` : '';
  return (
    <div className={`tp-human-character-container ${className} ${animate ? 'is-waiting' : 'is-static'} pose-${normalizedPose}${props}`} data-pose={normalizedPose} data-reveal-state={normalizedPose === 'idle' || normalizedPose === 'waiting' ? 'idle' : 'active'}>
      <svg className={`tp-waiting-player-svg${animate ? " is-active" : ""}`} viewBox="0 0 300 460" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="A player checking his watch while waiting for another player">


      {/* ground shadow + legs (static) */}
      <ellipse cx="150" cy="440" rx="80" ry="9" fill="#000" opacity=".3"/>
      <g className="tp-waiting-player-leg-back"><path d="M108 252 L149 252 L146 420 L111 420 Z" fill="#59614c"/><path d="M129 270 L128 405" stroke="#737b62" strokeWidth="2" strokeLinecap="round"/></g>
      <g className="tp-waiting-player-leg-front"><path d="M151 252 L192 252 L189 420 L154 420 Z" fill="#48513e"/><path d="M171 270 L172 405" stroke="#737b62" strokeWidth="2" strokeLinecap="round"/></g>
      <ellipse cx="126" cy="428" rx="23" ry="8.5" fill="#5b4027" stroke="#2a1b11" strokeWidth="2"/>
      <g className="tp-waiting-player-fo"><ellipse cx="176" cy="428" rx="23" ry="8.5" fill="#5b4027" stroke="#2a1b11" strokeWidth="2"/></g>

      <g className="tp-waiting-player-breath"><g className="tp-waiting-player-sigh">

        {/* torso */}
        <g className="tp-waiting-player-torso">
          <path d="M100 134 Q104 124 126 120 L174 120 Q196 124 200 134 L204 170 L198 262 Q150 272 102 262 L96 170 Z" fill="#365b3d"/>
          <path d="M150 124 L200 134 L204 170 L198 262 Q175 268 150 268 Z" fill="#254531" opacity=".32"/>
          <path d="M102 262 Q150 272 198 262" stroke="#f3ead2" strokeWidth="3" fill="none" opacity=".85"/>
          <path d="M132 119 L150 148 L168 119 Z" fill="#b57b55"/>
          <path d="M129 118 L150 150 L171 118" stroke="#f3ead2" strokeWidth="4" fill="none" strokeLinejoin="round"/>
        </g>

        {/* neck */}
        <rect x="139" y="100" width="22" height="26" rx="6" fill="#b57b55"/>

        {/* head */}
        <g className="tp-waiting-player-hd">
          <ellipse cx="123" cy="86" rx="5" ry="8" fill="#c58a63"/><ellipse cx="177" cy="86" rx="5" ry="8" fill="#c58a63"/>
          <ellipse cx="150" cy="84" rx="27" ry="31" fill="#c58a63"/>
          <path d="M123 68 L123 84 Q126 78 129 72 Z M177 68 L177 84 Q174 78 171 72 Z" fill="#1c1512"/>
          <g className="tp-waiting-player-fc">
            <g className="tp-waiting-player-bl">
              <ellipse cx="138" cy="89" rx="6" ry="4.2" fill="#fff"/><ellipse cx="162" cy="89" rx="6" ry="4.2" fill="#fff"/>
              <g className="tp-waiting-player-pu"><circle cx="138" cy="89" r="2.7" fill="#2a1a12"/><circle cx="162" cy="89" r="2.7" fill="#2a1a12"/></g>
            </g>
            <g className="tp-waiting-player-br" fill="none" stroke="#1c1512" strokeWidth="2.4" strokeLinecap="round">
              <path d="M131 82 q7 -3 14 0"/><path d="M155 82 q7 -3 14 0"/>
            </g>
            <path d="M150 90 q-3 8 -1 11 q3 2 5 0" stroke="#9c6544" strokeWidth="2" fill="none" strokeLinecap="round"/>
            <ellipse className="tp-waiting-player-mo" cx="150" cy="106" rx="6" ry="1.4" fill="#7d3f31"/>
          </g>
          {/* cap */}
          <path d="M120 72 Q117 38 150 36 Q183 38 180 72 Q150 64 120 72 Z" fill="#294a34"/>
          <path d="M150 37 L150 66" stroke="#203d2b" strokeWidth="2"/>
          <circle cx="150" cy="37" r="3" fill="#173323"/>
          <path d="M118 67 Q150 76 182 67 L181 72 Q150 83 119 72 Z" fill="#173323"/>
        </g>

        {/* watch arm: upper > forearm > hand (image right) */}
        <g className="tp-waiting-player-a1u">
          <rect x="187" y="126" width="26" height="72" rx="13" fill="#c58a63"/>
          <path d="M185 126 Q200 117 215 128 L216 168 Q200 175 184 168 Z" fill="#365b3d"/>
          <path d="M184 168 Q200 175 216 168" stroke="#f3ead2" strokeWidth="3" fill="none"/>
          <g className="tp-waiting-player-a1f">
            <rect x="190" y="190" width="20" height="62" rx="10" fill="#c58a63"/>
            <rect x="189" y="230" width="22" height="17" rx="3" fill="#14171b"/>
            <circle cx="200" cy="238" r="9.5" fill="#d8b25a"/>
            <circle cx="200" cy="238" r="7.5" fill="#f6f1e1"/>
            <path d="M200 238 L200 233 M200 238 L203.5 240" stroke="#222" strokeWidth="1.4" strokeLinecap="round"/>
            <g className="tp-waiting-player-tk"><path d="M200 238 L200 231.5" stroke="#d94b3d" strokeWidth="1"/></g>
            <circle cx="200" cy="238" r="1.2" fill="#222"/>
            <path d="M195 234 Q197 232 200 232" stroke="#fff" strokeWidth="1.2" fill="none" opacity=".7"/>
            <g className="tp-waiting-player-a1h"><rect x="190" y="248" width="20" height="14" rx="7" fill="#c58a63"/></g>
          </g>
        </g>

        {/* adjusting arm: upper > forearm > hand (image left), drawn on top */}
        <g className="tp-waiting-player-a2u">
          <rect x="87" y="126" width="26" height="72" rx="13" fill="#c58a63"/>
          <path d="M85 126 Q100 117 115 128 L116 168 Q100 175 84 168 Z" fill="#365b3d"/>
          <path d="M84 168 Q100 175 116 168" stroke="#f3ead2" strokeWidth="3" fill="none"/>
          <g className="tp-waiting-player-a2f">
            <rect x="90" y="190" width="20" height="62" rx="10" fill="#c58a63"/>
            <rect x="89" y="234" width="22" height="13" rx="3" fill="#14171b"/>
            <g className="tp-waiting-player-a2h">
              <path d="M91 248 h18 v10 q0 10 -9 10 q-9 0 -9 -10 z" fill="#c58a63"/>
              <ellipse cx="111" cy="256" rx="4" ry="7" fill="#c58a63"/>
              <path d="M95 258 v7 M100 259 v8 M105 258 v7" stroke="#9c6544" strokeWidth="1.4" strokeLinecap="round"/>
            </g>
          </g>
        </g>

        {/* Pose props live on their own layers and never participate in scoring. */}
        <g className="tp-waiting-player-prop tp-prop-search-coin"><circle cx="126" cy="399" r="8" fill="#d8b25a"/><circle cx="126" cy="399" r="5.5" fill="#f6f1e1"/><path d="M126 396v6m-2-3h4" stroke="#8a6b26" strokeWidth="1.3"/></g>
        <g className="tp-waiting-player-prop tp-prop-coin-burst"><circle cx="130" cy="202" r="7" fill="#d8b25a"/><circle cx="168" cy="194" r="6" fill="#f6f1e1"/><circle cx="184" cy="218" r="7" fill="#d8b25a"/><path d="M130 198v8m-3-4h6M168 191v6m-3-3h6M184 214v8m-3-4h6" stroke="#8a6b26" strokeWidth="1.3"/></g>
        <g className="tp-waiting-player-prop tp-prop-shovel"><path d="M204 238 L143 364" stroke="#8b633b" strokeWidth="7" strokeLinecap="round"/><path d="M136 356 Q124 381 142 390 Q158 379 149 359 Z" fill="#aab2a0" stroke="#536051" strokeWidth="2"/></g>
        <g className="tp-waiting-player-prop tp-prop-map"><path d="M103 203 L132 195 L160 203 L190 194 L190 238 L160 247 L132 239 L103 247 Z" fill="#ead9a0" stroke="#8d7540" strokeWidth="2"/><path d="M132 195v44m28-36v44M112 220q11-12 18-2t18 1" fill="none" stroke="#9d7545" strokeWidth="2"/><path d="M158 218l5-7 5 7" fill="none" stroke="#a6493a" strokeWidth="2"/></g>
        <g className="tp-waiting-player-prop tp-prop-trap"><path d="M126 400h48M136 393l10 7-10 7m28-14-10 7 10 7" fill="none" stroke="#d8b25a" strokeWidth="4" strokeLinecap="round"/><circle cx="150" cy="399" r="4" fill="#f6f1e1"/></g>
        <g className="tp-waiting-player-prop tp-prop-shield"><path d="M177 136l19 7v17q-4 14-19 21-15-7-19-21v-17z" fill="#d8b25a" stroke="#f6f1e1" strokeWidth="3"/><path d="m168 157 6 6 12-14" fill="none" stroke="#294a34" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round"/></g>
        <g className="tp-waiting-player-prop tp-prop-dirt"><circle cx="118" cy="390" r="4" fill="#b57b55"/><circle cx="183" cy="382" r="3" fill="#a8794b"/><circle cx="164" cy="395" r="2.5" fill="#d6ae88"/></g>

      </g></g>

      {/* thought bubble */}
      <g className="tp-waiting-player-th">
        <circle cx="190" cy="57" r="4" fill="#f4efdc"/><circle cx="183" cy="66" r="2.6" fill="#f4efdc"/>
        <rect x="196" y="8" width="84" height="40" rx="20" fill="#f4efdc"/>
        <circle className="tp-waiting-player-dot" cx="220" cy="28" r="4.5" fill="#1d3a2c"/>
        <circle className="tp-waiting-player-dot tp-waiting-player-d2" cx="238" cy="28" r="4.5" fill="#1d3a2c"/>
        <circle className="tp-waiting-player-dot tp-waiting-player-d3" cx="256" cy="28" r="4.5" fill="#1d3a2c"/>
      </g>
      </svg>
    </div>
  );
});

// Improved AnimatedWaiting component (Move-submitted state)
// ---------------------------------------------------------------------------

export function AnimatedWaiting({ action, missing, total, submittedCount, allSubmitted = false }) {
  const reduced = prefersReducedMotion();
  const [dotCount, setDotCount] = useState(1);

  useEffect(() => {
    if (reduced) return;
    const t = setInterval(() => setDotCount(d => (d % 3) + 1), 500);
    return () => clearInterval(t);
  }, [reduced]);

  const ACTION_META = {
    search:   { icon: '🧭', label: 'Search',   color: '#9fca8a' },
    steal:    { icon: '⚔️',  label: 'Steal',    color: '#e8a090' },
    trap:     { icon: '🛡️', label: 'Trap',     color: '#d4c860' },
    guard:    { icon: '🔰', label: 'Guard',    color: '#88c8d8' },
    dig_deep: { icon: '⛏️', label: 'Dig Deep', color: '#d6ae88' },
    explore:  { icon: '🗺️', label: 'Explore',  color: '#a9c99e' },
  };

  const choice = action?.choice;
  const meta = ACTION_META[choice] ?? {
    icon: '🔒',
    label: choice ? choice.replace('_', ' ') : 'Secret Move',
    color: '#d5b45b',
  };

  // Authoritative live count:
  const hasAuthoritativeCount =
    typeof submittedCount === 'number' &&
    typeof total === 'number' &&
    total > 0;

  // Safe ready count:
  const readyCount = typeof submittedCount === 'number' ? submittedCount : Math.max(1, (total || 2) - (missing || 0));

  return (
    <div className="waiting-card tp-waiting-card-3d" role="status" aria-live="polite">
      {/* Adventurer & 3D Floating Stage with Glowing Chest */}
      <div className="tp-waiting-stage" aria-hidden="true">
        {/* Soft glowing ambient aura */}
        <div className="tp-waiting-aura" />

        {/* Ambient sparkles (restrained) */}
        {!reduced && (
          <div className="tp-ambient-sparkles">
            <span className="tp-sparkle sp1">✦</span>
            <span className="tp-sparkle sp2">✧</span>
          </div>
        )}

        {/* Realistic Human Waiting Character */}
        <RealisticWaitingCharacter reduced={reduced} active={!allSubmitted} className="tp-human-waiting-mini" />

        {/* Floating 3D glowing treasure chest */}
        <div className="tp-waiting-chest-3d">
          <div className="tp-chest-mini-body">
            <div className="tp-chest-mini-face tp-mini-front">
              <span className="tp-vault-icon" style={{ color: meta.color }}>
                {meta.icon}
              </span>
            </div>
            <div className="tp-chest-mini-face tp-mini-back" />
            <div className="tp-chest-mini-face tp-mini-left" />
            <div className="tp-chest-mini-face tp-mini-right" />
            <div className="tp-chest-mini-face tp-mini-bottom" />
          </div>
          <div className="tp-chest-mini-lid">
            <div className="tp-chest-mini-face tp-mini-lid-top" />
            <div className="tp-chest-mini-face tp-mini-lid-front" />
          </div>
        </div>

        {/* Orbiting gold coins */}
        {!reduced && (
          <div className="tp-orbit-system">
            <div className="tp-orbit-track track-1">
              <span className="tp-orbit-coin">🪙</span>
            </div>
          </div>
        )}
      </div>

      {/* Pulsing check ring */}
      <span className="waiting-check tp-pulse-ring">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
          <polyline points="20 6 9 17 4 12" />
        </svg>
      </span>

      {/* Primary Message */}
      <span className="eyebrow">✦ SECRET MOVE LOCKED ✦</span>
      <h2 className="tp-waiting-heading">
        {allSubmitted ? 'All players have chosen!' : 'Your move is locked in.'}
      </h2>

      {/* Supporting text: "Waiting for the other players..." */}
      <p className="tp-waiting-desc">
        {allSubmitted ? (
          <>The forest clearing is resolving this round’s moves…</>
        ) : (
          <>
            Waiting for the other players{reduced ? '...' : '.'.repeat(dotCount)}
            <br />
            <small style={{ opacity: 0.85, fontSize: '0.85rem' }}>
              Your <b>{meta.label}</b> remains private until the round resolves.
            </small>
          </>
        )}
      </p>

      {/* Subtle Progress Indicator without countdown */}
      <div className="tp-waiting-progress-track" aria-hidden="true">
        <div className="tp-progress-bar-subtle">
          <div
            className="tp-progress-bar-fill"
            style={{ width: total > 0 ? `${Math.min(100, (readyCount / total) * 100)}%` : '50%' }}
          />
        </div>
        {hasAuthoritativeCount && (
          <span className="tp-progress-ratio">
            {readyCount}/{total}
          </span>
        )}
      </div>

      {/* Authoritative live count footer */}
      <div className="tp-waiting-footer">
        <svg className="spin" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M21 12a9 9 0 11-6.219-8.56" />
        </svg>
        {hasAuthoritativeCount ? (
          <span>{readyCount} of {total} players ready</span>
        ) : (
          <span>Waiting for the other players…</span>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// LobbyWaitingAnimation (Natural human waiting character beside lobby message)
// ---------------------------------------------------------------------------

export function LobbyWaitingAnimation({ enough, allReady, host, count = 1 }) {
  const reduced = prefersReducedMotion();

  // Exact copy requested by user:
  // Waiting for players: "Your room is ready. Invite a friend to join the hunt."
  // When room has enough players but not all ready: "Waiting for everyone to be ready."
  const title = allReady
    ? 'All adventurers are ready!'
    : enough
      ? 'Waiting for everyone to be ready'
      : 'Waiting for players';

  const message = allReady
    ? (host
        ? 'The clearing is set. Start the three-round hunt whenever you’re ready.'
        : 'The clearing is set. Waiting for the host to start the hunt.')
    : enough
      ? 'Waiting for everyone to be ready.'
      : 'Your room is ready. Invite a friend to join the hunt.';

  return (
    <div className="tp-lobby-waiting-card" role="status" aria-live="polite">
      {/* Natural, human-like waiting character beside the lobby message */}
      <div className="tp-lobby-character-col">
        <RealisticWaitingCharacter reduced={reduced} active={!enough && !allReady} />
      </div>

      <div className="tp-lobby-waiting-content">
        <span className="eyebrow">✦ EXPEDITION PREPARATION ✦</span>
        <h3 className="tp-lobby-waiting-title">{title}</h3>
        <p className="tp-lobby-waiting-desc">{message}</p>
        <div className="tp-lobby-waiting-footer">
          <span className="tp-lobby-ready-pill">
            {count} / 8 in clearing
          </span>
          {!enough ? (
            <span className="tp-lobby-hint">
              Invite a friend to begin
            </span>
          ) : !allReady ? (
            <span className="tp-lobby-hint">
              Waiting for readiness
            </span>
          ) : (
            <span className="tp-lobby-hint tp-ready-hint">
              All adventurers ready
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

// Round change transition
// ---------------------------------------------------------------------------
export function RoundTransition({ roundNo, children }) {
  const [key, setKey] = useState(roundNo);
  const [animClass, setAnimClass] = useState('tp-round-enter');

  useEffect(() => {
    if (roundNo === key) return;
    setAnimClass('tp-round-exit');
    const t1 = setTimeout(() => {
      setKey(roundNo);
      setAnimClass('tp-round-enter');
    }, 280);
    return () => clearTimeout(t1);
  }, [roundNo, key]);

  return (
    <div className={`tp-round-transition ${animClass}`} key={key}>
      {children}
    </div>
  );
}

export { clearSeenRounds };
