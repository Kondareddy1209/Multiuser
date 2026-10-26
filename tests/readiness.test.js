import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { canStartRoom, needsReadinessReview, readinessLabel, verifyReadyReadback } from '../src/readiness.js';

const app = await readFile(new URL('../src/main.jsx', import.meta.url), 'utf8');
const migration = await readFile(new URL('../supabase/migrations/002_multiplayer_actions_and_readiness.sql', import.meta.url), 'utf8');
const diagnostics = await readFile(new URL('../src/supabaseDiagnostics.js', import.meta.url), 'utf8');
const styles = await readFile(new URL('../src/style.css', import.meta.url), 'utf8');

test('room creator is automatically marked ready and enters lobby without forced rules review', () => {
  assert.ok(app.includes("if(creating)await call('set_player_ready',{p_code:r.code,p_ready:true})"));
  assert.ok(app.includes("const[rulesOpen,setRulesOpen]=useState(false)"));
  assert.match(app, /setPreGameOpen\(false\)/);
  assert.equal(needsReadinessReview({ isHost: true, ready: false }), false);
  assert.equal(readinessLabel({ id: 'host', ready: true }, 'host'), 'Host · Ready');
});

test('joiners are required to review and explicitly confirm readiness', () => {
  assert.ok(app.includes(":await call('join_room',{p_code:c,p_name:n})"));
  assert.ok(app.includes("setMode('join')"));
  assert.equal(needsReadinessReview({ isHost: false, ready: false }), true);
  assert.equal(needsReadinessReview({ isHost: false, ready: true }), false);
  assert.match(app, /onClick=\{\(\)=>onReady\(true\)\}/);
});

test('guest readiness persists through the existing RPC and only closes after a fresh room read confirms it', () => {
  assert.match(app, /call\('set_player_ready',\{p_code:roomCode,p_ready:value\}\)/);
  assert.match(app, /const updated=await refresh\(\)/);
  assert.match(app, /verifyReadyReadback\(updated,player\?\.id\)/);
  assert.match(app, /if\(value&&verification\.confirmed\)\{setPreGameOpen\(false\);return\}/);
  assert.match(app, /error&&<Alert text=\{error\}/);
});

test('only two or more active, ready players can start', () => {
  assert.equal(canStartRoom([]), false);
  assert.equal(canStartRoom([{ active: true, ready: true }]), false);
  assert.equal(canStartRoom([{ active: true, ready: true }, { active: true, ready: false }]), false);
  assert.equal(canStartRoom([{ active: true, ready: true }, { active: true, ready: true }]), true);
  assert.equal(canStartRoom([{ active: true, ready: true }, { active: false, ready: false }, { active: true, ready: true }]), true);
  assert.match(migration, /count\(\*\) from public\.players where room_id=r\.id and active\)<2/i);
  assert.match(migration, /active and not ready/i);
});

test('readiness refresh is shared across clients through realtime events and polling', () => {
  assert.match(app, /table:'players',filter:'room_id=eq\.'\+room\.id/);
  assert.match(app, /setInterval\(refresh,2800\)/);
  assert.match(app, /refreshRequest=useRef\(0\)/);
});

test('rematches reset participants and then mark the host ready through the existing RPC', () => {
  assert.match(migration, /ready=false where room_id=r\.id/i);
  assert.match(app, /rematch=async[\s\S]{0,220}set_player_ready/);
});
test('readiness is confirmed only when the fresh database room payload contains the player and ready=true', () => {
  assert.deepEqual(verifyReadyReadback({ players: [{ id: 'host', ready: true }] }, 'host'), {
    confirmed: true, reason: null, readyValue: true,
  });
  assert.equal(verifyReadyReadback({ players: [{ id: 'host', ready: false }] }, 'host').reason, 'not-ready');
  assert.equal(verifyReadyReadback({ players: [{ id: 'host' }] }, 'host').reason, 'ready-field-missing');
  assert.equal(verifyReadyReadback({ players: [] }, 'host').reason, 'player-missing');
});

test('development RPC diagnostics omit room codes and credentials', () => {
  assert.match(app, /logSupabaseError\(fn,e,import\.meta\.env\.DEV\)/);
  assert.match(diagnostics, /\.replace\(\/\\b\[0-9a-f\]/);
  assert.match(diagnostics, /message: safeMessage\(error\)/);
  assert.match(app, /console\.info\('\[Treasure Plots\] readiness readback'/);
  assert.doesNotMatch(app, /console\.(?:error|info)\([^\n]*(?:apikey|access_token|refresh_token)/i);
});

test('lobby readiness states are both explicit, accessible, and visually distinct', () => {
  assert.ok(app.includes("className={'readiness-mark '+(p.ready?'ready':'waiting')}") );
  assert.match(app, /aria-label=\{p\.ready\?'Ready':'Not ready'\}/);
  assert.match(app, /role="status" aria-live="polite"/);
  assert.match(styles, /\.lobby-player\.is-ready/);
  assert.match(styles, /\.lobby-player\.is-waiting/);
  assert.match(styles, /\.readiness-mark\.ready/);
  assert.match(styles, /\.readiness-mark\.waiting/);
  assert.match(styles, /prefers-reduced-motion: reduce/);
});
