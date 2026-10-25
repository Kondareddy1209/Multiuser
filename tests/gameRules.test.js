import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { actions, actionById, coinCost, netOutcome, splitSteal, getWinners } from '../src/gameRules.js';
import { explainSupabaseError, logSupabaseError } from '../src/supabaseDiagnostics.js';

const migration = await readFile(new URL('../supabase/migrations/002_multiplayer_actions_and_readiness.sql', import.meta.url), 'utf8');
const reconcileMigration = await readFile(new URL('../supabase/migrations/003_reconcile_move_rpcs.sql', import.meta.url), 'utf8');
const baseMigration = await readFile(new URL('../supabase/migrations/001_game.sql', import.meta.url), 'utf8');
const app = await readFile(new URL('../src/main.jsx', import.meta.url), 'utf8');

test('six action definitions and coin costs match the approved rules', () => {
  assert.deepEqual(actions.map((a) => a.id), ['search', 'steal', 'trap', 'guard', 'dig_deep', 'explore']);
  assert.deepEqual(actions.map((a) => coinCost(a.id)), [0, 0, 1, 1, 1, 1]);
  assert.equal(Object.keys(actionById).length, 6);
});

test('per-action net outcomes show costs and rewards correctly', () => {
  assert.equal(netOutcome('search'), 2);
  assert.equal(netOutcome('steal'), 0);
  assert.equal(netOutcome('trap'), -1);
  assert.equal(netOutcome('guard'), -1);
  assert.equal(netOutcome('dig_deep', false), -1);
  assert.equal(netOutcome('dig_deep', true), 3);
  assert.equal(netOutcome('explore', false), 0);
  assert.equal(netOutcome('explore', true), 2);
});

test('simultaneous theft allocation caps at balance and assigns remainder in stable input order', () => {
  assert.deepEqual(splitSteal(5, ['a', 'b', 'c']), [
    { playerId: 'a', amount: 2 }, { playerId: 'b', amount: 2 }, { playerId: 'c', amount: 1 },
  ]);
  assert.deepEqual(splitSteal(1, ['a', 'b']), [
    { playerId: 'a', amount: 1 }, { playerId: 'b', amount: 0 },
  ]);
  assert.deepEqual(splitSteal(0, ['a', 'b']), [
    { playerId: 'a', amount: 0 }, { playerId: 'b', amount: 0 },
  ]);
});

test('duplicate player root cause is addressed with room-scoped keys and idempotency', () => {
  assert.match(baseMigration, /players \(id uuid primary key/i);
  assert.match(migration, /primary key\(room_id,id\)/i);
  assert.match(migration, /rooms_host_create_request_uq/i);
  assert.match(migration, /pg_advisory_xact_lock/i);
  assert.match(migration, /on conflict\(room_id,id\)/i);
  assert.match(migration, /create function public\.create_room\(p_name text,p_request_id uuid\)/i);
  assert.match(app, /p_request_id:requestId/);
  assert.match(app, /busyRef\.current/);
});

test('server RPC validates action names, targets, cost, and duplicate submissions', () => {
  assert.match(migration, /p_choice not in \('search','steal','trap','guard','dig_deep','explore'\)/i);
  assert.match(migration, /p_choice='steal' and \(p_target is null or p_target=u/i);
  assert.match(migration, /p_choice in \('trap','guard','dig_deep','explore'\) and balance<1/i);
  assert.match(migration, /Choice already locked/i);
  assert.match(migration, /coins=coins-1 where room_id=rid and id=a\.player_id and coins>=1/i);
});

test('trap penalties/reward and guard-only protection are separate resolution branches', () => {
  assert.match(migration, /if protection='trap' then/i);
  assert.match(migration, /elsif protection='guard' then/i);
  assert.match(migration, /trap_penalty/i);
  assert.match(migration, /trap_blocked/i);
  assert.match(migration, /guard_blocked/i);
});

test('risky outcomes are server-generated and only written into the resolved result', () => {
  assert.equal((migration.match(/uuid_send\(pg_catalog\.gen_random_uuid\(\)\)/gi) || []).length, 2);
  assert.match(migration, /choice','dig_deep','success',success/i);
  assert.match(migration, /choice','explore','success',success/i);
  assert.match(migration, /insert into public\.round_results[\s\S]*?'events',ev/i);
  assert.match(app, /e\.choice==='dig_deep'/);
  assert.match(app, /e\.choice==='explore'/);
});

test('readiness is persisted and server-checked before starting, and reset for rematches', () => {
  assert.match(migration, /add column ready boolean not null default false/i);
  assert.match(migration, /create or replace function public\.set_player_ready/i);
  assert.match(migration, /active and not ready/i);
  assert.match(migration, /ready=false where room_id=r\.id/i);
  assert.match(app, /set_player_ready/);
  assert.match(app, /Review the rules/);
  assert.match(app, /Back to Lobby/);
});

test('reconnect window stays 90 seconds and committed choices remain present', () => {
  assert.match(migration, /interval '90 seconds'/i);
  assert.match(migration, /not exists\(select 1 from public\.actions a where a\.room_id=r\.id and a\.round_no=r\.round_no and a\.player_id=u\)/i);
  assert.match(migration, /my_action/);
  assert.match(baseMigration, /alter table public\.actions enable row level security/i);
  assert.doesNotMatch(migration, /create policy[\s\S]*?on public\.actions/i);
});

test('six distinct action cards and completed-game copy are present', () => {
  assert.match(app, /THE SIX MOVES/);
  assert.match(app, /Moves stay private until the round resolves/);
  assert.match(app, /Three rounds are complete/);
  assert.match(app, /allReady/);
});


test('final leaderboard returns every player tied for the high score', () => {
  const players = [{ id: 'a', coins: 8 }, { id: 'b', coins: 8 }, { id: 'c', coins: 5 }];
  assert.deepEqual(getWinners(players).map((p) => p.id), ['a', 'b']);
  assert.deepEqual(getWinners([]), []);
});

test('submission client matches the authenticated RPC contract and refreshes after success or rejection', () => {
  assert.match(migration, /create or replace function public\.submit_action\(p_code text,p_choice text,p_target uuid default null\)/i);
  assert.match(migration, /grant execute on function public\.[\s\S]*?submit_action\(text,text,uuid\)[\s\S]*?to authenticated/i);
  assert.match(app, /call\('submit_action',\{p_code:roomCode,p_choice:choice,p_target:choice==='steal'\?target:null\}\)/);
  assert.match(app, /if\(r\?\.ok\)[\s\S]*?const updated=await refresh\(\)/);
  assert.match(app, /await refresh\(\{preserveError:true\}\)/);
});

test('two different player moves wait for all active players and resolve exactly once', () => {
  assert.match(migration, /select \* into r from public\.rooms where code=upper\(trim\(p_code\)\) for update/i);
  assert.match(migration, /select coins into balance from public\.players where id=u and room_id=r\.id and active for update/i);
  assert.match(migration, /exists\(select 1 from public\.actions where room_id=r\.id and round_no=r\.round_no and player_id=u\)/i);
  assert.match(migration, /insert into public\.actions\(room_id,round_no,player_id,choice,target_id\)/i);
  assert.match(migration, /not exists\(select 1 from public\.players p where p\.room_id=r\.id and p\.active[\s\S]*?not exists\(select 1 from public\.actions a where a\.room_id=r\.id and a\.round_no=r\.round_no and a\.player_id=p\.id\)\)/i);
  assert.match(migration, /if r\.status<>'playing' or r\.round_no<>rn or exists\(select 1 from public\.round_results where room_id=rid and round_no=rn\) then return; end if/i);
  assert.match(baseMigration, /round_results[\s\S]*?primary key\(room_id,round_no\)/i);
});

test('sequential model verifies first move waits, second move resolves, and duplicate is rejected', () => {
  const active = new Set(['host', 'guest']);
  const locked = new Map();
  let resolves = 0;
  const submit = (id, action) => {
    const key = `room-1:1:${id}`;
    if (!active.has(id)) throw new Error('Not an active player');
    if (locked.has(key)) throw new Error('Choice already locked');
    locked.set(key, action);
    if ([...active].every((player) => locked.has(`room-1:1:${player}`))) resolves++;
    return resolves;
  };
  assert.equal(submit('host', 'search'), 0);
  assert.deepEqual([...locked.values()], ['search']);
  assert.equal(submit('guest', 'guard'), 1);
  assert.throws(() => submit('host', 'steal'), /Choice already locked/);
  assert.equal(resolves, 1);
});




test('regression: 002 scopes resolver name lookups to the current room', () => {
  // Migration 001 uses scalar player-name lookups by id alone. Once an identity
  // can belong to several rooms, those queries can raise PostgreSQL 21000.
  assert.match(baseMigration, /select name from players where id=a\.target_id/i);
  assert.match(baseMigration, /select name from players where id=a\.player_id/i);
  const resolver = migration.split('create or replace function public.resolve_round_internal', 2)[1].split('create or replace function public.heartbeat', 1)[0];
  assert.doesNotMatch(resolver, /select\s+(?:name|coins)\s+from\s+public\.players\s+where\s+id\s*=/i);
  assert.match(resolver, /join public\.players p on p\.room_id=act\.room_id and p\.id=act\.player_id/i);
  assert.match(resolver, /join public\.players targ on targ\.room_id=act\.room_id and targ\.id=act\.target_id/i);
});

test('regression: get_room scalar action and result reads have local unique-key guarantees', () => {
  assert.match(baseMigration, /actions[\s\S]*?primary key\(room_id,round_no,player_id\)/i);
  assert.match(baseMigration, /round_results[\s\S]*?primary key\(room_id,round_no\)/i);
  assert.match(migration, /'my_action',\(select jsonb_build_object[\s\S]*?a\.room_id=r\.id and a\.round_no=r\.round_no and a\.player_id=u\)/i);
  assert.match(migration, /'result',\(select payload from public\.round_results where room_id=r\.id and round_no=r\.round_no\)/i);
});

test('error 21000 distinguishes submit transaction failure from stale read failure', () => {
  assert.match(explainSupabaseError({ code: '21000' }, 'submit_action'), /should have rolled back/i);
  assert.match(explainSupabaseError({ code: '21000' }, 'get_room'), /do not resubmit/i);
});



test('diagnostics redact action names from database error messages', () => {
  const logs = [];
  const original = console.error;
  console.error = (...args) => logs.push(args);
  try { logSupabaseError('submit_action', { code: '21000', message: 'failed while processing steal for 12345678-1234-4234-8234-123456789abc' }, true); }
  finally { console.error = original; }
  const detail = JSON.stringify(logs);
  assert.doesNotMatch(detail, /steal|12345678-1234/i);
  assert.match(detail, /21000/);
});



function simulateSequentialTrapPenalties(startingCoins, trapCount) {
  let coins = startingCoins;
  const penalties = [];
  for (let i = 0; i < trapCount; i++) {
    const amount = Math.min(2, Math.max(coins, 0));
    coins -= amount;
    penalties.push(amount);
  }
  return { coins, penalties };
}

test('Trap penalty regression: one thief hit by multiple traps spends only current coins', () => {
  assert.match(reconcileMigration, /select coins into current_balance from public\.players[\s\S]*?where room_id=rid and id=a\.player_id for update/i);
  assert.match(reconcileMigration, /amt:=least\(2,greatest\(current_balance,0\)\)/i);
  assert.doesNotMatch(reconcileMigration, /amt:=least\(2,coalesce\(\(balances->>a\.player_id::text\)::int,0\)\)/i);
  assert.deepEqual(simulateSequentialTrapPenalties(3, 2), { coins: 0, penalties: [2, 1] });
});

test('Trap penalty regression: low balance is exhausted without going negative or aborting', () => {
  assert.match(reconcileMigration, /if found then amt:=least\(2,greatest\(current_balance,0\)\); else amt:=0; end if/i);
  assert.match(reconcileMigration, /if not found then amt:=0; end if/i);
  assert.deepEqual(simulateSequentialTrapPenalties(1, 3), { coins: 0, penalties: [1, 0, 0] });
});

test('Trap penalty regression: a single sprung Trap rewards its setter once and deducts at most two', () => {
  assert.match(reconcileMigration, /select distinct act\.target_id,p\.name[\s\S]*?update public\.players set coins=coins\+2 where room_id=rid and id=t\.target_id;[\s\S]*?for a in[\s\S]*?trap_penalty/i);
  assert.deepEqual(simulateSequentialTrapPenalties(5, 1), { coins: 3, penalties: [2] });
});

test('Migration 003 keeps all player updates room-scoped and preserves reviewed permissions', () => {
  const updates = [...reconcileMigration.matchAll(/update public\.players\s+set[\s\S]*?;/gim)].map((m) => m[0]);
  assert.ok(updates.length >= 7);
  assert.ok(updates.every((sql) => /where room_id=rid and id=/.test(sql)));
  assert.match(reconcileMigration, /revoke all on function public\.submit_action\(text,text,uuid\) from public,anon,authenticated/i);
  assert.match(reconcileMigration, /grant execute on function public\.submit_action\(text,text,uuid\) to authenticated,service_role/i);
  assert.doesNotMatch(reconcileMigration, /(?:grant|revoke)\s+[^;]*resolve_round_internal/i);
  assert.doesNotMatch(reconcileMigration, /alter table|create policy|drop policy/i);
});


test('steal splits from 0, 1, and 2 coins never transfer more than the target owns', () => {
  const thieves = ['a', 'b', 'c'];
  for (const balance of [0, 1, 2]) {
    const split = splitSteal(balance, thieves);
    assert.equal(split.reduce((sum, item) => sum + item.amount, 0), balance);
    assert.ok(split.every((item) => item.amount >= 0));
    assert.ok(split.reduce((sum, item) => sum + item.amount, 0) <= balance);
  }
  assert.deepEqual(splitSteal(0, thieves).map((x) => x.amount), [0, 0, 0]);
  assert.deepEqual(splitSteal(1, thieves).map((x) => x.amount), [1, 0, 0]);
  assert.deepEqual(splitSteal(2, thieves).map((x) => x.amount), [1, 1, 0]);
  assert.match(reconcileMigration, /share_n:=least\(t\.coins,2\*n\)\/n; rem_n:=least\(t\.coins,2\*n\)%n/i);
  assert.match(reconcileMigration, /where room_id=rid and id=t\.target_id and coins>=amt/i);
});

test('ordinary Steal debits the target and checks FOUND before crediting the thief', () => {
  const start = reconcileMigration.indexOf('amt:=share_n+case');
  const end = reconcileMigration.indexOf("ev:=ev||jsonb_build_array(jsonb_build_object('type','theft'", start);
  const transfer = reconcileMigration.slice(start, end);
  const debit = transfer.indexOf('update public.players set coins=coins-amt where room_id=rid and id=t.target_id and coins>=amt;');
  const debitCheck = transfer.indexOf("if not found then raise exception 'Coin invariant failed while resolving steal'; end if;", debit);
  const credit = transfer.indexOf('update public.players set coins=coins+amt where room_id=rid and id=a.player_id;', debitCheck);
  const creditCheck = transfer.indexOf("if not found then raise exception 'Coin invariant failed while crediting steal'; end if;", credit);
  assert.ok(debit >= 0 && debitCheck > debit && credit > debitCheck && creditCheck > credit);
});

test('failed target debit cannot credit a thief in the transfer model', () => {
  const transfer = (targetCoins, thiefCoins, amount) => {
    if (targetCoins < amount) throw new Error('Coin invariant failed while resolving steal');
    return { targetCoins: targetCoins - amount, thiefCoins: thiefCoins + amount };
  };
  assert.throws(() => transfer(0, 4, 1), /Coin invariant failed/);
  assert.throws(() => transfer(1, 4, 2), /Coin invariant failed/);
  assert.deepEqual(transfer(2, 4, 2), { targetCoins: 0, thiefCoins: 6 });
});
