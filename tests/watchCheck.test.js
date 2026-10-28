import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const component = await readFile(new URL('../src/AnimationComponents.jsx', import.meta.url), 'utf8');
const css = await readFile(new URL('../src/animations.css', import.meta.url), 'utf8');
const start = component.indexOf('export const RealisticWaitingCharacter');
const end = component.indexOf('// Improved AnimatedWaiting component', start);
const character = component.slice(start, end);

test('the supplied waiting-player drawing is inline SVG with independently animated body groups', () => {
  assert.match(character, /React\.memo\(function RealisticWaitingCharacter/);
  assert.match(character, /<svg[\s\S]*?viewBox="0 0 300 460"[\s\S]*?role="img"/);
  assert.doesNotMatch(character, /<iframe|<img\s/);
  for (const group of ['breath', 'sigh', 'a1u', 'a1f', 'a1h', 'a2u', 'a2f', 'a2h', 'hd', 'fc', 'pu', 'bl', 'br', 'mo', 'fo', 'th', 'tk']) {
    assert.ok(character.includes(`className="tp-waiting-player-${group}`), `${group} remains in the inline asset`);
  }
  assert.match(character, /aria-label="A player checking his watch while waiting for another player"/);
});

test('all imported keyframes are namespaced and only run while the SVG is active', () => {
  const animations = ['breath', 'sigh', 'a1u', 'a1f', 'a1h', 'a2u', 'a2f', 'a2h', 'hd', 'fc', 'pu', 'bl', 'br', 'mo', 'fo', 'th', 'dot', 'tk'];
  for (const name of animations) assert.ok(css.includes(`@keyframes tp-waiting-player-${name}`), `prefixed keyframe ${name}`);
  assert.match(css, /\.tp-waiting-player-svg\.is-active \.tp-waiting-player-a1f\{animation:tp-waiting-player-a1f var\(--t\) ease-in-out infinite\}/);
  assert.match(css, /\.tp-waiting-player-svg\.is-active \.tp-waiting-player-tk\{animation:tp-waiting-player-tk 60s steps\(60,end\) infinite\}/);
  assert.match(css, /\.tp-waiting-player-svg\.is-active \.tp-waiting-player-breath\{animation:tp-waiting-player-breath 4s ease-in-out infinite\}/);
  assert.doesNotMatch(css, /@keyframes (?:breath|a1u|tk)\b|\.wp(?:\s|\.)/);
});

test('the character animates in lobby waiting and while other players resolve a submitted move', () => {
  assert.match(component, /active=\{!enough && !allReady\}/);
  assert.match(component, /active=\{!allSubmitted\} className="tp-human-waiting-mini"/);
  assert.match(component, /Your move is locked in\./);
  assert.match(component, /Waiting for players/);
  assert.match(component, /Waiting for the other players/);
  assert.match(component, /All players have chosen!/);
});

test('reduced motion disables every SVG animation and leaves the thought bubble hidden', () => {
  const reduced = css.split('@media (prefers-reduced-motion: reduce)', 2)[1];
  assert.match(reduced, /\.tp-waiting-player-svg,/);
  assert.match(reduced, /\.tp-waiting-player-svg \*,/);
  assert.match(reduced, /animation: none !important/);
  assert.match(css, /\.tp-waiting-player-svg \.tp-waiting-player-th \{ opacity: 0 !important; \}/);
});

test('the sports blues were recolored for the forest theme without changing compact sizing', () => {
  assert.doesNotMatch(character, /#2c6bc3|#1f55a3|#1d57ad|#174a93|#143f82/);
  assert.match(character, /fill="#365b3d"/);
  assert.match(css, /width: 104px; height: 162px/);
  assert.match(css, /width: 82px; height: 128px/);
  assert.match(css, /@media \(max-width: 600px\)/);
});
