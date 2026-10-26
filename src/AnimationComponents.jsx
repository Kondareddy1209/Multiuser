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
import React, { useEffect, useRef, useState, useCallback } from 'react';
import {
  prefersReducedMotion,
  hasSeenRound,
  markRoundSeen,
  clearSeenRounds,
  playEventAnimation,
  playVictoryCelebration,
  mountChestAnimation,
  floatCoinLabel,
} from './animations.js';

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
export function useRoundAnimation(roomId, roundNo, events, players, prev, current) {
  const fired = useRef(false);
  const rowRefs = useRef({}); // player_id -> DOM element ref

  const setRowRef = useCallback((playerId, el) => {
    rowRefs.current[playerId] = el;
  }, []);

  useEffect(() => {
    if (!roomId || !roundNo || !events?.length) return;
    if (fired.current) return;
    if (hasSeenRound(roomId, roundNo)) return;

    const raf = requestAnimationFrame(() => {
      markRoundSeen(roomId, roundNo);
      fired.current = true;

      const reduced = prefersReducedMotion();
      const actionEvents = events.filter(e => e.choice);

      // Stagger per player row — 130ms apart
      actionEvents.forEach((evt, idx) => {
        const rowEl = rowRefs.current[evt.player_id];
        if (!rowEl || reduced) return;
        playEventAnimation(rowEl, evt, idx * 130);
      });
    });

    return () => cancelAnimationFrame(raf);
  }, [roomId, roundNo, events]);

  return { setRowRef };
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
  { event, avatarIndex = 0, delayMs = 0 },
  ref
) {
  const [visible, setVisible] = useState(false);
  const [popped, setPopped] = useState(false);
  const reduced = prefersReducedMotion();

  useEffect(() => {
    if (reduced) {
      setVisible(true);
      return;
    }
    const t1 = setTimeout(() => setVisible(true), delayMs);
    const t2 = setTimeout(() => setPopped(true), delayMs + 60);
    const t3 = setTimeout(() => setPopped(false), delayMs + 320);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
      clearTimeout(t3);
    };
  }, [delayMs, reduced]);

  const meta = ACTION_LABELS[event.choice] ?? { icon: '?', verb: event.choice, color: '#aaa' };
  const delta = Number(event.delta ?? 0);
  const deltaClass = delta > 0 ? 'anim-positive' : delta < 0 ? 'anim-negative' : 'anim-neutral';

  return (
    <div
      ref={ref}
      className={`revealed-player anim-row ${visible ? 'anim-visible' : 'anim-hidden'} ${popped ? 'anim-pop' : ''}`}
      style={{ '--delay': `${delayMs}ms` }}
    >
      <span className={`avatar av${avatarIndex % 6}`}>
        {event.name?.[0] ?? '?'}
      </span>
      <span>
        <b>{event.name}</b>
        <small>
          <span className="anim-action-icon" style={{ color: meta.color }}>{meta.icon}</span>
          {' '}
          {event.choice === 'steal'
            ? `Targeted ${event.target_name}`
            : meta.verb}
          {event.choice === 'dig_deep'
            ? (event.success ? ' · ✨ Found 4 coins!' : ' · Excavation empty')
            : event.choice === 'explore'
              ? (event.success ? ' · 🗺 Found 2 bonus coins!' : ' · No bonus find')
              : ''}
        </small>
      </span>
      <i className={`anim-delta ${deltaClass}`}>
        {delta > 0 ? `+${delta} coins` : delta < 0 ? `${delta} coins` : '0 coins'} 🪙
      </i>
    </div>
  );
});

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
// Realistic Articulated Waiting Character (Layered Human Adventurer)
// ---------------------------------------------------------------------------

export function RealisticWaitingCharacter({ reduced = false, className = '' }) {
  return (
    <div className={`tp-human-character-container ${className}`} aria-hidden="true">
      {/* Ground ambient contact shadow beneath boots */}
      <div className="tp-human-ground-shadow" />

      {/* Articulated, layered SVG character with independent head, torso, arm joints */}
      <svg
        className="tp-human-svg"
        viewBox="0 0 160 260"
        width="104"
        height="162"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
      >
        <defs>
          <linearGradient id="tpSkinGrad" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#f5cfb0" />
            <stop offset="60%" stopColor="#e2b493" />
            <stop offset="100%" stopColor="#c79471" />
          </linearGradient>
          <linearGradient id="tpJacketGrad" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#43634e" />
            <stop offset="45%" stopColor="#304c3a" />
            <stop offset="100%" stopColor="#1f3427" />
          </linearGradient>
          <linearGradient id="tpPantsGrad" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#2c3a30" />
            <stop offset="100%" stopColor="#1a231d" />
          </linearGradient>
          <linearGradient id="tpBootGrad" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#543b27" />
            <stop offset="60%" stopColor="#3c2818" />
            <stop offset="100%" stopColor="#25180e" />
          </linearGradient>
          <linearGradient id="tpHairGrad" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#4d3525" />
            <stop offset="60%" stopColor="#342217" />
            <stop offset="100%" stopColor="#20140d" />
          </linearGradient>
          <linearGradient id="tpLeatherGrad" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#7a5231" />
            <stop offset="100%" stopColor="#4a2e18" />
          </linearGradient>
          <linearGradient id="tpGoldDial" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#f7e494" />
            <stop offset="50%" stopColor="#d5b45b" />
            <stop offset="100%" stopColor="#8d6f26" />
          </linearGradient>
        </defs>

        {/* Ambient shadow ellipse on ground */}
        <ellipse cx="80" cy="245" rx="46" ry="6.5" fill="#07130b" opacity="0.65" />

        {/* Root Character Group with casual weight shifted onto left leg */}
        <g className="tp-char-root">
          {/* Subtle outdoor pack strap & bedroll on back */}
          <g className="tp-char-pack">
            <rect x="43" y="78" width="16" height="42" rx="5" fill="#38291e" opacity="0.85" />
            <ellipse cx="50" cy="76" rx="8" ry="6" fill="#4d392b" />
          </g>

          {/* Legs & Boots Group (Standing casually with weight on left leg) */}
          <g className="tp-char-legs">
            {/* Pelvis / Hips */}
            <path d="M58 140 L102 140 L98 162 L62 162 Z" fill="#202922" />

            {/* Left Leg: Weight-bearing, straight down to left boot */}
            <path d="M60 156 L76 156 L75 195 L74 233 L58 233 L59 195 Z" fill="url(#tpPantsGrad)" />
            <path d="M62 191 Q67 195 72 191" stroke="#151d17" strokeWidth="1.5" strokeLinecap="round" fill="none" />
            <path d="M58 229 L74 229 L75 235 L57 235 Z" fill="#18211a" />
            {/* Left Boot */}
            <path d="M55 233 L74 233 L76 241 L74 246 L50 246 L51 239 Z" fill="url(#tpBootGrad)" />
            <path d="M50 244 L76 244 L76 247 L49 247 Z" fill="#160e08" />

            {/* Right Leg: Relaxed casual stance, knee angled slightly outward */}
            <path d="M84 156 L100 156 L102 192 L96 232 L82 232 L85 192 Z" fill="url(#tpPantsGrad)" />
            <path d="M87 189 Q93 194 99 189" stroke="#151d17" strokeWidth="1.5" strokeLinecap="round" fill="none" />
            <path d="M82 228 L96 228 L97 234 L81 234 Z" fill="#18211a" />
            {/* Right Boot: Angled slightly outward */}
            <path d="M81 232 L97 232 L105 240 L103 245 L79 245 L80 238 Z" fill="url(#tpBootGrad)" />
            <path d="M78 244 L105 244 L105 247 L77 247 Z" fill="#160e08" />

            {/* Adventure Pouch on Right Hip */}
            <g className="tp-char-pouch">
              <rect x="96" y="146" width="13" height="17" rx="3" fill="url(#tpLeatherGrad)" />
              <path d="M96 151 L109 151" stroke="#331f11" strokeWidth="1" />
              <circle cx="102.5" cy="154" r="1.5" fill="#d5b45b" />
            </g>
          </g>

          {/* Torso & Arms (Independently Articulated with Natural Breathing) */}
          <g className="tp-char-torso">
            {/* Belt */}
            <path d="M59 139 L101 139 L101 146 L59 146 Z" fill="#4d321d" />
            <rect x="76" y="138" width="8" height="9" rx="1.5" fill="#d5b45b" stroke="#7e5d26" strokeWidth="1" />

            {/* Jacket Body */}
            <path d="M56 86 C56 86, 78 84, 104 86 L101 140 L59 140 Z" fill="url(#tpJacketGrad)" />
            {/* Inner shirt / cream collar */}
            <polygon points="73,85 80,102 87,85" fill="#e8dfce" />
            {/* Jacket Lapels & Zipper Seam */}
            <path d="M72 85 L79 104 L79 140" stroke="#1f3427" strokeWidth="1.6" />
            <path d="M88 85 L81 104 L81 140" stroke="#1f3427" strokeWidth="1.6" />
            <line x1="80" y1="104" x2="80" y2="139" stroke="#9fca8a" strokeWidth="1" strokeDasharray="2,2" />
            {/* Chest Utility Pockets */}
            <path d="M63 108 L73 108 L73 118 L63 118 Z" fill="#243d2c" opacity="0.75" />
            <path d="M87 108 L97 108 L97 118 L87 118 Z" fill="#243d2c" opacity="0.75" />

            {/* Left Arm: Resting across waist with wristband clearly on wrist */}
            <g className="tp-char-arm-left">
              {/* Left Upper Arm */}
              <path d="M56 86 C52 98, 50 110, 52 122 L62 121 C60 110, 62 98, 65 87 Z" fill="url(#tpJacketGrad)" />
              {/* Left Forearm */}
              <path d="M52 122 L72 130 L71 137 L53 128 Z" fill="url(#tpJacketGrad)" />
              {/* Left Hand */}
              <circle cx="73" cy="133" r="5" fill="url(#tpSkinGrad)" />

              {/* Wristband & Watch on Opposite Wrist */}
              <g className="tp-char-wristband-unit">
                <rect x="69" y="129" width="8" height="7" rx="2" fill="url(#tpLeatherGrad)" />
                <circle cx="73" cy="132.5" r="3.2" fill="url(#tpGoldDial)" stroke="#4a2e18" strokeWidth="0.8" />
                <circle cx="73" cy="132.5" r="1" fill="#fff" />
              </g>

              {/* Left Fingers resting naturally */}
              <path d="M68 135 C66 138, 70 141, 74 138" stroke="#be8f6d" strokeWidth="1.5" strokeLinecap="round" fill="none" />
            </g>

            {/* Right Arm (Independently Articulated: Upper Arm -> Forearm -> Hand) */}
            <g className="tp-char-arm-upper-right">
              {/* Right Upper Arm (Pivoting at Shoulder 104, 86) */}
              <path d="M104 86 C107 98, 106 110, 102 121 L93 119 C96 110, 97 98, 95 86 Z" fill="url(#tpJacketGrad)" />

              {/* Forearm & Hand Group (Pivoting at Elbow 101, 120) */}
              <g className="tp-char-arm-forearm-right">
                <path d="M101 120 L80 131 L82 138 L102 126 Z" fill="url(#tpJacketGrad)" />

                {/* Hand Group (Pivoting at Wrist 80, 133 to adjust the wristband) */}
                <g className="tp-char-hand-right">
                  <ellipse cx="79" cy="133" rx="4.5" ry="4" fill="url(#tpSkinGrad)" />
                  {/* Fingers gently gripping and adjusting the wristband */}
                  <path d="M78 131 Q74 131 72 132" stroke="#be8f6d" strokeWidth="1.8" strokeLinecap="round" fill="none" />
                  <path d="M79 134 Q75 135 73 134" stroke="#be8f6d" strokeWidth="1.6" strokeLinecap="round" fill="none" />
                </g>
              </g>
            </g>

            {/* Neck & Head Group (Pivoting at base of neck 80, 78) */}
            <g className="tp-char-head-group">
              {/* Neck */}
              <path d="M74 69 L86 69 L88 85 L72 85 Z" fill="url(#tpSkinGrad)" />
              {/* Head / Face */}
              <ellipse cx="80" cy="50" rx="16" ry="19" fill="url(#tpSkinGrad)" />
              {/* Ears */}
              <ellipse cx="64" cy="51" rx="2.5" ry="4.5" fill="#d8a37d" />
              <ellipse cx="96" cy="51" rx="2.5" ry="4.5" fill="#d8a37d" />

              {/* Eyes & Blinking Group */}
              <g className="tp-char-eyes-group">
                {/* Left Eye */}
                <ellipse cx="74" cy="48" rx="2.6" ry="2.2" fill="#203024" />
                <circle cx="74.7" cy="47.2" r="0.8" fill="#ffffff" />
                {/* Right Eye */}
                <ellipse cx="86" cy="48" rx="2.6" ry="2.2" fill="#203024" />
                <circle cx="86.7" cy="47.2" r="0.8" fill="#ffffff" />
                {/* Animated Eyelids */}
                <g className="tp-char-eyelids">
                  <rect x="70" y="44" width="8" height="6" fill="url(#tpSkinGrad)" />
                  <rect x="82" y="44" width="8" height="6" fill="url(#tpSkinGrad)" />
                </g>
              </g>

              {/* Eyebrows */}
              <path d="M71 44 Q74 42 77 44" stroke="#33241b" strokeWidth="1.3" strokeLinecap="round" fill="none" />
              <path d="M83 44 Q86 42 89 44" stroke="#33241b" strokeWidth="1.3" strokeLinecap="round" fill="none" />
              {/* Nose */}
              <path d="M79 48 L79 53 L82 54" stroke="#c08c69" strokeWidth="1.2" strokeLinecap="round" fill="none" />
              {/* Friendly Patient Mouth */}
              <path d="M76 59 Q80 62 84 59" stroke="#9c563e" strokeWidth="1.4" strokeLinecap="round" fill="none" />

              {/* Hair */}
              <path d="M64 45 C63 32, 75 27, 85 28 C96 29, 98 38, 97 45 C96 42, 92 38, 88 38 C80 38, 77 42, 73 42 C69 42, 66 44, 64 45 Z" fill="url(#tpHairGrad)" />
              {/* Hair strands */}
              <path d="M67 36 Q75 30 84 32" stroke="#5a3d2c" strokeWidth="1.5" strokeLinecap="round" fill="none" />
              <path d="M78 33 Q87 32 94 37" stroke="#5a3d2c" strokeWidth="1.5" strokeLinecap="round" fill="none" />
              <path d="M63 45 Q62 52 65 55" stroke="#33241b" strokeWidth="2" strokeLinecap="round" fill="none" />
            </g>
          </g>
        </g>
      </svg>
    </div>
  );
}

// ---------------------------------------------------------------------------
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
        <RealisticWaitingCharacter reduced={reduced} className="tp-human-waiting-mini" />

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
        <RealisticWaitingCharacter reduced={reduced} />
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
