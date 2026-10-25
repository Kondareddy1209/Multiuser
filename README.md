# Treasure Plots

A mobile-first, anonymous-room party game built with React, Vite, Supabase, and Netlify.

## Local setup

1. Create a Supabase project.
2. In **Authentication → Sign In / Providers**, enable **Anonymous sign-ins**.
3. For a new database, run supabase/migrations/001_game.sql in the Supabase SQL Editor. Existing databases with the three-action version require migration 002 after it has been reviewed and explicitly approved.
4. In the project settings, copy the **Project URL** and the browser-safe **publishable key** (the key formerly named `anon`). Never put a `service_role` or secret key in the browser.
5. Copy `.env.example` to `.env.local` and fill in those two values.
6. Install dependencies with `pnpm install` (or `npm install`), then run `npm run dev`.

Rooms use anonymous Supabase Auth sessions. The browser can call only validated database functions. Row level security exposes room/player/round state to room members; action rows have no client read policy, so choices stay private. Realtime listens to room, player, and result table changes, with a short polling fallback.

## Publish with Netlify

1. Push this project to a Git repository and import it into Netlify.
2. Keep the build command `npm run build` and publish directory `dist` (both are in `netlify.toml`).
3. Add `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` as Netlify environment variables, then deploy.
4. Open the Netlify URL on two or more devices; create a room in one and join with the code or invite link in the others.

The public frontend needs no player accounts or installs. The operator needs a Supabase project and a Netlify account to configure and publish it.

## Rules

All players start with 5 coins and play 3 rounds. Search earns 2. Steal targets one rival and requests up to 2 coins; attackers split the target's available balance evenly with a deterministic remainder order. Trap costs 1, blocks steals, makes each blocked thief lose up to 2, and awards its setter 2 once when sprung. Guard costs 1 and blocks steals without a bonus or thief penalty. Dig Deep costs 1 and has a server-side 50% chance to add 4 (net +3), otherwise it nets −1. Explore costs 1, returns 1 coin for sure, and has a server-side 50% chance to add 2 more (net 0 or +2). All actions resolve together; outcomes are hidden until the round resolves. Highest score after round three wins; tied players share the win.

A locked move survives a disconnect. An unsubmitted disconnected player's round waits up to 90 seconds; on timeout that move is skipped and the round resolves. Duplicate or changed submissions are rejected by the server. Rematch resets scores and round state in the same room.


## Existing database upgrade (review required)

supabase/migrations/002_multiplayer_actions_and_readiness.sql is a forward-only draft for the existing three-action database. It adds room-scoped memberships and create-request idempotency, supports six server-validated actions, persists lobby readiness, and keeps the 90-second reconnect window and private action policy. It has not been applied. Do not run it until the SQL is reviewed and explicitly approved.

Run local contract tests with node --test from the project root. These tests do not connect to Supabase; they check the rule definitions and migration/frontend invariants. Database integration must be verified against a disposable database after approval.
