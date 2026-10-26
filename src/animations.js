/**
 * Treasure Plots — Animation Engine
 * Pure CSS-3D transforms + Canvas API particles. Zero new dependencies.
 *
 * Design contract:
 *  - Animations ONLY trigger after authoritative Supabase round_results are received.
 *  - A WeakSet/Set of "seen" round keys prevents duplicate animation on polling rerenders.
 *  - Every animation respects `prefers-reduced-motion`.
 *  - WebGL is never required — Canvas 2D and CSS 3D are the heaviest APIs used.
 *  - All timers and animation frames are cleanly canceled on unmount.
 */

// ---------------------------------------------------------------------------
// Reduced-motion & performance guards
// ---------------------------------------------------------------------------
export function prefersReducedMotion() {
  if (typeof window === 'undefined') return false;
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}

/**
 * Returns a scaling factor (0.4 - 1.0) for particle counts on mobile / low-concurrency devices.
 */
export function getParticleMultiplier() {
  if (typeof window === 'undefined') return 1;
  const isSmallScreen = window.innerWidth < 640;
  const isLowConcurrency = (navigator.hardwareConcurrency ?? 8) <= 4;
  if (isSmallScreen && isLowConcurrency) return 0.4;
  if (isSmallScreen || isLowConcurrency) return 0.6;
  return 1;
}

// ---------------------------------------------------------------------------
// Seen-round deduplication: prevents replay on Supabase polling re-renders
// ---------------------------------------------------------------------------
const _seenRounds = new Set();

/** Returns true if this round animation has already played for this tab session. */
export function hasSeenRound(roomId, roundNo) {
  return _seenRounds.has(`${roomId}:${roundNo}`);
}

/** Mark a round as seen so it never plays again in this session. */
export function markRoundSeen(roomId, roundNo) {
  _seenRounds.add(`${roomId}:${roundNo}`);
}

/** Clear all seen-round history (called on rematch). */
export function clearSeenRounds() {
  _seenRounds.clear();
}

// ---------------------------------------------------------------------------
// Particle canvas helper — floating coins, sparkles, scatter, trap sparks, shield
// ---------------------------------------------------------------------------

/**
 * Spawn a canvas particle burst overlay over a target DOM element.
 * @param {HTMLElement} anchor   Element to position over
 * @param {'coins'|'sparkle'|'scatter'|'shield'|'trap'} type
 * @param {number} count         Base particle count
 * @param {number} durationMs    Total animation time in ms
 * @returns {() => void}         Cleanup fn – call on unmount
 */
export function spawnParticles(anchor, type = 'coins', count = 18, durationMs = 1400) {
  if (prefersReducedMotion()) return () => {};
  if (!anchor || typeof document === 'undefined') return () => {};

  const scaledCount = Math.max(4, Math.round(count * getParticleMultiplier()));
  const rect = anchor.getBoundingClientRect();
  const canvas = document.createElement('canvas');
  canvas.style.cssText = `
    position:fixed;
    left:${rect.left + rect.width / 2 - 120}px;
    top:${rect.top + rect.height / 2 - 120}px;
    width:240px;height:240px;
    pointer-events:none;
    z-index:9999;
    border-radius:50%;
  `;
  canvas.width = 240;
  canvas.height = 240;
  document.body.appendChild(canvas);

  const ctx = canvas.getContext('2d');
  if (!ctx) {
    canvas.remove();
    return () => {};
  }

  const cx = 120, cy = 120;
  const particles = [];

  // Palettes by effect type
  const palettes = {
    coins:   ['#f0d47a', '#e5c45c', '#fce88a', '#d4a830', '#fff0b3'],
    sparkle: ['#f0d47a', '#ffffff', '#a8e6c0', '#e5c45c', '#c8f0d8'],
    scatter: ['#f8a49a', '#e67a6a', '#ffd0c8', '#e07060', '#ffc0b8'],
    shield:  ['#88c8d8', '#a8e0f0', '#5ab0c8', '#c0e8f8', '#80d0e8'],
    trap:    ['#d4c860', '#e8a090', '#f5b041', '#e74c3c', '#f39c12'],
  };
  const colors = palettes[type] ?? palettes.coins;
  const isCoin = ['coins', 'sparkle'].includes(type);

  for (let i = 0; i < scaledCount; i++) {
    const angle = (Math.PI * 2 * i) / scaledCount + (Math.random() - 0.5) * 0.8;
    const speed = type === 'trap'
      ? 2.0 + Math.random() * 3.5
      : 1.2 + Math.random() * 2.8;
    particles.push({
      x: cx, y: cy,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed - (type === 'coins' ? 2.0 : 1.2) + Math.random(),
      r: 3 + Math.random() * 5,
      color: colors[Math.floor(Math.random() * colors.length)],
      alpha: 1,
      rot: Math.random() * Math.PI * 2,
      rotV: (Math.random() - 0.5) * 0.22,
      gravity: type === 'coins' ? 0.05 : 0.09,
    });
  }

  let raf;
  const start = performance.now();

  const tick = (now) => {
    const elapsed = now - start;
    if (elapsed > durationMs) {
      canvas.remove();
      return;
    }
    ctx.clearRect(0, 0, 240, 240);
    const progress = elapsed / durationMs;

    for (const p of particles) {
      p.x += p.vx;
      p.y += p.vy;
      p.vy += p.gravity;
      p.rot += p.rotV;
      p.alpha = Math.max(0, 1 - Math.pow(progress, 1.5));

      ctx.save();
      ctx.globalAlpha = p.alpha;
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);

      if (isCoin) {
        // Coin disc
        ctx.beginPath();
        ctx.ellipse(0, 0, p.r, p.r * 0.65, 0, 0, Math.PI * 2);
        ctx.fillStyle = p.color;
        ctx.fill();
        ctx.strokeStyle = '#00000030';
        ctx.lineWidth = 0.5;
        ctx.stroke();
      } else if (type === 'shield') {
        // Radiant shield diamond
        ctx.beginPath();
        ctx.moveTo(0, -p.r * 1.4);
        ctx.lineTo(p.r * 0.7, 0);
        ctx.lineTo(0, p.r * 1.4);
        ctx.lineTo(-p.r * 0.7, 0);
        ctx.closePath();
        ctx.fillStyle = p.color;
        ctx.fill();
      } else if (type === 'trap') {
        // Sharp spiked spark
        ctx.beginPath();
        ctx.moveTo(0, -p.r * 1.6);
        ctx.lineTo(p.r * 0.5, -p.r * 0.3);
        ctx.lineTo(p.r * 1.5, 0);
        ctx.lineTo(p.r * 0.5, p.r * 0.3);
        ctx.lineTo(0, p.r * 1.6);
        ctx.lineTo(-p.r * 0.5, p.r * 0.3);
        ctx.lineTo(-p.r * 1.5, 0);
        ctx.lineTo(-p.r * 0.5, -p.r * 0.3);
        ctx.closePath();
        ctx.fillStyle = p.color;
        ctx.fill();
      } else {
        // Scatter shard
        ctx.beginPath();
        ctx.arc(0, 0, p.r * 0.8, 0, Math.PI * 2);
        ctx.fillStyle = p.color;
        ctx.fill();
      }
      ctx.restore();
    }
    raf = requestAnimationFrame(tick);
  };

  raf = requestAnimationFrame(tick);
  return () => {
    cancelAnimationFrame(raf);
    canvas.remove();
  };
}

// ---------------------------------------------------------------------------
// DOM overlay: floating "+N coins" text with directional flight
// ---------------------------------------------------------------------------

/**
 * Float a coin-change label (e.g. "+3", "−1") above a DOM element.
 * For positive gains: floats upward towards balance.
 * For negative losses: scatters downward and away from balance.
 * @param {HTMLElement} anchor
 * @param {number} delta   Signed integer
 * @param {number} delayMs Optional delay before showing
 * @returns {() => void}   Cleanup
 */
export function floatCoinLabel(anchor, delta, delayMs = 0) {
  if (prefersReducedMotion()) return () => {};
  if (!anchor || delta === 0 || typeof document === 'undefined') return () => {};

  const el = document.createElement('div');
  const positive = delta > 0;
  const label = positive ? `+${delta}` : `${delta}`;
  el.textContent = label + ' 🪙';
  const animClass = positive ? 'tp-float-coin-gain' : 'tp-float-coin-loss';

  el.className = `tp-floating-coin-label ${animClass}`;
  el.style.cssText = `
    position:fixed;
    font-family:'DM Sans',-apple-system,BlinkMacSystemFont,sans-serif;
    font-size:${Math.min(22, 14 + Math.abs(delta) * 2)}px;
    font-weight:700;
    color:${positive ? '#f0d47a' : '#f8a49a'};
    text-shadow:0 2px 14px ${positive ? '#d4a83090' : '#e0504090'};
    pointer-events:none;
    z-index:9998;
    white-space:nowrap;
    animation-delay:${delayMs}ms;
    animation-duration:${650 + Math.abs(delta) * 75}ms;
  `;

  const rect = anchor.getBoundingClientRect();
  el.style.left = (rect.left + rect.width / 2) + 'px';
  el.style.top = (rect.top + rect.height / 2) + 'px';
  el.style.transform = 'translate(-50%, -50%)';

  document.body.appendChild(el);
  const timeout = setTimeout(() => el.remove(), delayMs + 1100 + Math.abs(delta) * 75);
  return () => {
    clearTimeout(timeout);
    el.remove();
  };
}

// ---------------------------------------------------------------------------
// Shield & Trap Flash Overlays
// ---------------------------------------------------------------------------

/**
 * Flash a cyan-teal barrier ripple overlay (for Guard block / Trap block).
 * @param {HTMLElement} anchor
 * @returns {() => void}
 */
export function flashShieldOverlay(anchor) {
  if (prefersReducedMotion() || !anchor || typeof document === 'undefined') return () => {};

  const el = document.createElement('div');
  el.className = 'tp-shield-flash-overlay';
  el.style.cssText = `
    position:fixed;
    border-radius:8px;
    pointer-events:none;
    z-index:9997;
    animation:tp-shield-flash 0.75s cubic-bezier(0.16, 1, 0.3, 1) forwards;
  `;

  const rect = anchor.getBoundingClientRect();
  el.style.left = (rect.left - 4) + 'px';
  el.style.top = (rect.top - 4) + 'px';
  el.style.width = (rect.width + 8) + 'px';
  el.style.height = (rect.height + 8) + 'px';

  document.body.appendChild(el);
  const t = setTimeout(() => el.remove(), 800);
  return () => { clearTimeout(t); el.remove(); };
}

/**
 * Flash an amber-crimson spiked trap snap overlay (when a trap triggers).
 * @param {HTMLElement} anchor
 * @returns {() => void}
 */
export function flashTrapOverlay(anchor) {
  if (prefersReducedMotion() || !anchor || typeof document === 'undefined') return () => {};

  const el = document.createElement('div');
  el.className = 'tp-trap-flash-overlay';
  el.style.cssText = `
    position:fixed;
    border-radius:8px;
    pointer-events:none;
    z-index:9997;
    animation:tp-trap-snap 0.8s cubic-bezier(0.16, 1, 0.3, 1) forwards;
  `;

  const rect = anchor.getBoundingClientRect();
  el.style.left = (rect.left - 4) + 'px';
  el.style.top = (rect.top - 4) + 'px';
  el.style.width = (rect.width + 8) + 'px';
  el.style.height = (rect.height + 8) + 'px';

  document.body.appendChild(el);
  const t = setTimeout(() => el.remove(), 850);
  return () => { clearTimeout(t); el.remove(); };
}

// ---------------------------------------------------------------------------
// Action-result animation: plays once per revealed round, per player row
// ---------------------------------------------------------------------------

/**
 * Play the result animation for a single player event.
 * @param {HTMLElement} rowEl    The player row element in the Reveal section
 * @param {object} event         Supabase event: { choice, delta, success, type, target_name }
 * @param {number} indexDelay    Stagger offset in ms
 * @returns {() => void}         Cleanup
 */
export function playEventAnimation(rowEl, event, indexDelay = 0) {
  if (prefersReducedMotion() || !rowEl) return () => {};

  const cleanups = [];
  const delta = Number(event.delta ?? 0);

  const schedule = (fn, ms) => {
    const t = setTimeout(fn, ms);
    cleanups.push(() => clearTimeout(t));
  };

  schedule(() => {
    // 1. Highlight row background with smooth cubic-bezier transition
    rowEl.style.transition = 'background 0.25s cubic-bezier(0.16, 1, 0.3, 1), box-shadow 0.25s ease';
    if (delta > 0) {
      rowEl.style.background = 'linear-gradient(90deg, #1b3d22 0%, #295730 100%)';
      rowEl.style.boxShadow = '0 0 20px rgba(131, 201, 154, 0.25)';
    } else if (delta < 0) {
      rowEl.style.background = 'linear-gradient(90deg, #3d1c18 0%, #56251f 100%)';
      rowEl.style.boxShadow = '0 0 20px rgba(232, 160, 144, 0.25)';
    } else {
      rowEl.style.background = 'linear-gradient(90deg, #22322a 0%, #1a2822 100%)';
      rowEl.style.boxShadow = '0 0 16px rgba(167, 177, 165, 0.15)';
    }

    schedule(() => {
      rowEl.style.background = '';
      rowEl.style.boxShadow = '';
      rowEl.style.transition = '';
    }, 600);

    // 2. Particle burst based on outcome
    const particleType = delta > 0 ? 'coins' : delta < 0 ? 'scatter' : 'sparkle';
    const count = Math.min(26, 10 + Math.abs(delta) * 4);
    const cleanup1 = spawnParticles(rowEl, particleType, count, 1300);
    cleanups.push(cleanup1);

    // 3. Directional coin change label
    if (delta !== 0) {
      const cleanup2 = floatCoinLabel(rowEl, delta, 80);
      cleanups.push(cleanup2);
    }

    // 4. Special visual effects for Guard / Trap / Steal
    if (event.choice === 'guard' || event.type === 'guard_blocked') {
      const cShield = flashShieldOverlay(rowEl);
      const cParts = spawnParticles(rowEl, 'shield', 14, 900);
      cleanups.push(cShield, cParts);
    }

    if (
      event.choice === 'trap' ||
      event.type === 'trap_penalty' ||
      event.type === 'trap_blocked' ||
      event.type === 'trap_reward'
    ) {
      const cTrap = flashTrapOverlay(rowEl);
      const cParts = spawnParticles(rowEl, 'trap', 16, 950);
      cleanups.push(cTrap, cParts);
    }
  }, indexDelay);

  return () => cleanups.forEach(fn => fn());
}

// ---------------------------------------------------------------------------
// Victory celebration
// ---------------------------------------------------------------------------

/**
 * Fire a golden victory particle burst from the center of the screen.
 * @param {number} intensity 1 = normal, 2 = tie (dual bursts)
 * @returns {() => void}     Cleanup
 */
export function playVictoryCelebration(intensity = 1) {
  if (prefersReducedMotion() || typeof window === 'undefined') return () => {};

  const cleanups = [];
  const burstCount = intensity > 1 ? 4 : 5;

  for (let burst = 0; burst < burstCount; burst++) {
    const t = setTimeout(() => {
      const fakeAnchor = {
        getBoundingClientRect: () => ({
          left: window.innerWidth / 2 - 12,
          top: window.innerHeight / 2 - 12,
          width: 24,
          height: 24,
        }),
      };
      const cleanup = spawnParticles(
        /** @type {HTMLElement} */ (fakeAnchor),
        'coins',
        22 + Math.floor(Math.random() * 12),
        1600
      );
      cleanups.push(cleanup);
    }, burst * 320);
    cleanups.push(() => clearTimeout(t));
  }

  return () => cleanups.forEach(fn => fn());
}

// ---------------------------------------------------------------------------
// 3D Treasure Chest Animation (CSS-perspective)
// ---------------------------------------------------------------------------

/**
 * Mount a CSS-3D treasure chest animation on a container element.
 * @param {HTMLElement} container
 * @param {'open'|'empty'} mode
 * @param {number} durationMs
 * @returns {() => void}  Cleanup
 */
export function mountChestAnimation(container, mode = 'open', durationMs = 2800) {
  if (!container || typeof document === 'undefined') return () => {};
  const reduced = prefersReducedMotion();

  const wrapper = document.createElement('div');
  wrapper.className = 'tp-chest-wrapper';
  wrapper.innerHTML = `
    <div class="tp-chest ${mode}" aria-hidden="true">
      <div class="tp-chest-body">
        <div class="tp-chest-face tp-chest-front"></div>
        <div class="tp-chest-face tp-chest-back"></div>
        <div class="tp-chest-face tp-chest-left"></div>
        <div class="tp-chest-face tp-chest-right"></div>
        <div class="tp-chest-face tp-chest-bottom"></div>
      </div>
      <div class="tp-chest-lid ${reduced ? 'tp-chest-lid-open' : ''}">
        <div class="tp-chest-face tp-chest-lid-top"></div>
        <div class="tp-chest-face tp-chest-lid-front"></div>
        <div class="tp-chest-face tp-chest-lid-back"></div>
        <div class="tp-chest-face tp-chest-lid-left"></div>
        <div class="tp-chest-face tp-chest-lid-right"></div>
      </div>
      ${mode === 'open' ? `
        <div class="tp-chest-glow"></div>
        <div class="tp-chest-beams"></div>
        <div class="tp-chest-coins-fly">
          <span class="c-coin c1">🪙</span>
          <span class="c-coin c2">🪙</span>
          <span class="c-coin c3">🪙</span>
        </div>
      ` : `
        <div class="tp-chest-dust"></div>
      `}
    </div>
  `;

  container.appendChild(wrapper);

  let t;
  if (!reduced) {
    t = setTimeout(() => {
      const lid = wrapper.querySelector('.tp-chest-lid');
      if (lid) {
        if (mode === 'open') {
          lid.classList.add('tp-chest-lid-open');
        } else {
          lid.classList.add('tp-chest-lid-empty-peek');
          setTimeout(() => lid.classList.remove('tp-chest-lid-empty-peek'), 700);
        }
      }
    }, 280);
  }

  const removeTimer = setTimeout(() => {
    wrapper.style.opacity = '0';
    wrapper.style.transition = 'opacity 0.35s ease';
    setTimeout(() => wrapper.remove(), 380);
  }, durationMs - 380);

  return () => {
    clearTimeout(t);
    clearTimeout(removeTimer);
    wrapper.remove();
  };
}
