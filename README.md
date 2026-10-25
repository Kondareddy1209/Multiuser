# Treasure Plots

[![React](https://img.shields.io/badge/React-18.3.1-blue?logo=react)](https://react.dev/)
[![Vite](https://img.shields.io/badge/Vite-6.0.7-646CFF?logo=vite)](https://vitejs.dev/)
[![Tests](https://img.shields.io/badge/Tests-33%20Passed-brightgreen)](tests/)
[![JavaScript](https://img.shields.io/badge/ESM-JavaScript-F7DF1E?logo=javascript)](https://developer.mozilla.org/en-US/docs/Web/JavaScript)
[![GitHub](https://img.shields.io/badge/GitHub-Kondareddy1209%2FMultiuser-181717?logo=github)](https://github.com/Kondareddy1209/Multiuser)

Treasure Plots is a real-time, browser-based multiplayer strategy and party game. Up to eight players gather in an anonymous clearing, start with five coins, and compete across three rounds of simultaneous secret decisions. 

Players can quietly search for treasure, target rivals with thefts, protect their stash with traps or shields, or take risky expeditions into the deep woods. All moves remain hidden in the database until the round closes, resolving together in a single deterministic sequence.

---

## Table of Contents

- [Features](#features)
- [Game Rules](#game-rules)
  - [Actions Overview](#actions-overview)
  - [Action Details](#action-details)
  - [Simultaneous Resolution Sequence](#simultaneous-resolution-sequence)
  - [Winning the Game](#winning-the-game)
- [Tech Stack](#tech-stack)
- [Getting Started](#getting-started)
  - [Prerequisites](#prerequisites)
  - [Installation](#installation)
- [Environment Configuration](#environment-configuration)
- [Testing and Build](#testing-and-build)
- [Project Structure](#project-structure)
- [Database Setup](#database-setup)
  - [Supabase Prerequisites](#supabase-prerequisites)
  - [Applying Migrations](#applying-migrations)
- [Security](#security)
- [Deployment](#deployment)
- [Contributing](#contributing)
- [License](#license)

---

## Features

- **Anonymous Multiplayer Rooms:** Create private rooms with six-character codes or join instantly using direct invite links, clipboard copying, or native device sharing.
- **2–8 Player Capacity:** Accommodates duels and parties of up to eight participants per room.
- **Simultaneous Secret Decisions:** Players lock in their moves privately. Selections remain shielded by database security until all decisions are submitted or the round timer expires.
- **Six Distinct Actions:** Choose between Search, Steal, Trap, Guard, Dig Deep, and Explore, balancing guaranteed gains, defenses, and calculated risks.
- **Lobby Readiness Flow:** Room creators are automatically marked ready, while guests review field rules and confirm readiness before the host can launch the game.
- **Multi-Thief Allocation:** Deterministic, proportional split algorithm with order-based remainder distribution when multiple players target the same rival.
- **Resilient State & Reconnects:** Submitted moves survive network interruptions. Unsubmitted disconnected players are granted a 90-second grace window before the round resolves without them.
- **Supabase-Backed State Machine:** PostgreSQL transactional RPCs handle room creation, validation, move execution, coin conservation, and game progression without client-side state manipulation.
- **Live Sync & Polling Fallback:** Subscribes to Supabase Realtime channels (`postgres_changes`) on rooms, players, and round results, reinforced with an automatic 2.8-second polling heartbeat.
- **Rematch Support:** Host can reset rounds, coin totals, and readiness states for consecutive games within the same room.

---

## Game Rules

Each player begins the match with **5 coins** and competes over **3 rounds**.

### Actions Overview

| Action | Cost | Base Gain | Requirements & Mechanics | Net Outcome |
| :--- | :---: | :---: | :--- | :---: |
| **Search** | 0 | +2 | No target required. Safe baseline coin gain. | **+2** |
| **Steal** | 0 | Up to +2 | Must target a rival in the room. Deducts up to 2 coins from target. Blocked by Trap and Guard. | **0 to +2** |
| **Trap** | 1 | 0 | Blocks all incoming steals against you. Each thief loses up to 2 coins. Sprung trap awards setter +2 once. | **-1** (unattacked)<br>**+1** (sprung) |
| **Guard** | 1 | 0 | Blocks all incoming steals against you. No thief penalty or setter bonus. | **-1** |
| **Dig Deep** | 1 | 0 / +4 | 50% chance to discover treasure and gain 4 coins; otherwise lose the 1 coin cost. | **-1** (fail)<br>**+3** (success) |
| **Explore** | 1 | +1 | Guarantees 1 coin back, with a 50% chance to find an additional 2 coins. | **0** (fail)<br>**+2** (success) |

---

### Action Details

#### Search
- **Cost:** `0 coins`
- **Net:** `+2 coins`
- The safest action in the forest. Yields two guaranteed coins without targeting any player or risking counter-attacks.

#### Steal
- **Cost:** `0 coins`
- **Net:** `0 to +2 coins`
- Targets a selected rival to siphon up to two coins from their current balance.
- **Multi-Thief Allocation:** When multiple thieves target the same player:
  1. The total transferable pool is capped at `min(target_balance, 2 * thief_count)`.
  2. Each thief receives `floor(pool / thief_count)`.
  3. Any remainder coins are awarded one by one to thieves ordered by a deterministic hash (`md5(player_id || round_no)`).
  4. Targets are never driven below zero coins.

#### Trap
- **Cost:** `1 coin` (requires at least 1 coin)
- **Net:** `-1 coin` if unattacked; `+1 coin` if sprung
- Sets a defensive counter-measure. Blocks every steal attempt targeting the setter this round.
- **Thief Penalty:** Each thief attempting to steal from a trapped player loses up to 2 coins (capped at their current balance).
- **Setter Bonus:** If one or more thieves attempt to steal, the setter is awarded a one-time +2 coin bonus.

#### Guard
- **Cost:** `1 coin` (requires at least 1 coin)
- **Net:** `-1 coin`
- Raises a protective shield. Blocks all incoming steals aimed at the player for the round. Unlike Trap, Guard inflicts no penalty on thieves and awards no counter bonus.

#### Dig Deep
- **Cost:** `1 coin` (requires at least 1 coin)
- **Net:** `-1 coin` on failure; `+3 coins` on success
- A high-risk, high-reward expedition. A server-generated random roll provides a 50% chance to excavate a cache of 4 coins (yielding a net profit of +3 coins after paying the cost).

#### Explore
- **Cost:** `1 coin` (requires at least 1 coin)
- **Net:** `0 coins` on failure; `+2 coins` on success
- A cautious survey of the woods. The player immediately recuperates the 1 coin expenditure, and a 50% server roll determines whether an extra 2 coins are uncovered.

---

### Simultaneous Resolution Sequence

When all active players lock in their choices—or when the 90-second disconnect timeout expires—the round resolves atomically within a single database transaction (`resolve_round_internal`):

1. **Self-Contained Actions:** Costs and baseline gains for `search`, `trap`, `guard`, `dig_deep`, and `explore` are applied.
2. **Trap Counters & Penalties:** Sprung traps deduct penalties from attackers first and award setter bonuses, ensuring thieves cannot spend the same coin twice or drop below zero.
3. **Guard Blocks:** Remaining steals aimed at guarded players are neutralized.
4. **Steal Distribution:** Unblocked thefts deduct coins from targets and allocate spoils to thieves according to the proportional split algorithm.
5. **Payload Persistence:** Results and updated balances are written to `round_results`, advancing the game to the next round or final victory screen.

---

### Winning the Game

After **Round 3**, the match concludes:
- The player holding the highest total coin count is declared the winner.
- If two or more players share the highest coin balance, all tied leaders share the victory.

---

## Tech Stack

- **Client Framework:** [React 18.3.1](https://react.dev/)
- **Build Tool & Dev Server:** [Vite 6.0.7](https://vitejs.dev/) with [@vitejs/plugin-react 4.3.4](https://github.com/vitejs/vite-plugin-react)
- **Iconography:** [Lucide React 0.468.0](https://lucide.dev/)
- **Backend as a Service:** [Supabase](https://supabase.com/) via [@supabase/supabase-js 2.57.0](https://github.com/supabase/supabase-js)
- **Database Engine:** PostgreSQL 15+ (PL/pgSQL transactional RPCs, row-level security, advisory locks)
- **Styling:** Vanilla CSS with custom tokens, fluid typography, dark mode palette, and mobile-first glassmorphism
- **Testing:** Node.js native test runner (`node:test`, `node:assert/strict`)

---

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) v18.0.0 or higher
- [npm](https://www.npmjs.com/) or [pnpm](https://pnpm.io/)
- A free [Supabase](https://supabase.com/) project

### Installation

1. **Clone the repository:**
   ```bash
   git clone https://github.com/Kondareddy1209/Multiuser.git
   cd Multiuser
   ```

2. **Install project dependencies:**
   ```bash
   npm install
   # or
   pnpm install
   ```

3. **Configure local environment variables:**
   ```bash
   cp .env.example .env.local
   ```
   Add your Supabase project URL and anon/publishable key to `.env.local` (see [Environment Configuration](#environment-configuration)).

4. **Launch the development server:**
   ```bash
   npm run dev
   # or
   pnpm dev
   ```
   Open the printed URL (typically `http://localhost:5173`) in your browser.

---

## Environment Configuration

The application requires connection credentials to your Supabase project. Define these in `.env.local` in the project root:

```env
VITE_SUPABASE_URL=https://YOUR_PROJECT_ID.supabase.co
VITE_SUPABASE_ANON_KEY=YOUR_SUPABASE_ANON_PUBLISHABLE_KEY
```

> **Important:**
> - Only supply the **browser-safe anon/publishable key**. Never expose your Supabase `service_role` secret in client-side configuration.
> - `.env.local` is ignored by Git to prevent accidental credential leakage.
> - A template file [`.env.example`](.env.example) is committed to the repository for reference.

---

## Testing and Build

The project includes an automated contract and regression test suite verifying game logic, RPC contracts, state machines, and concurrency invariants without requiring a live database connection.

### Run Tests
```bash
npm test
# or
node --test
```

**Test Coverage Summary:**
- **Total Tests:** 33 passing
- **Modules Covered:**
  - `tests/gameRules.test.js`: Validates action definitions, costs, steal allocations, tiebreaker logic, idempotency, and regression guards.
  - `tests/readiness.test.js`: Validates host auto-readiness, guest review mandates, live sync subscriptions, and safe error redaction.

### Production Build
```bash
npm run build
```
Generates an optimized production bundle in the `dist/` folder.

### Preview Production Build
```bash
npm run preview
```

---

## Project Structure

```text
Multiuser/
├── .env.example            # Placeholder environment variable template
├── .gitignore              # Ignores environment files, build output, secrets, and caches
├── index.html              # Single-page application entry HTML
├── netlify.toml            # Netlify build and SPA routing configuration
├── package.json            # Scripts and package dependencies
├── vite.config.js          # Vite configuration with React plugin
├── src/
│   ├── gameRules.js        # Action models, coin calculations, steal distributions, winner evaluation
│   ├── main.jsx            # Main React application, screens (Home, Lobby, Game, Reveal), state
│   ├── readiness.js        # Player lobby readiness verification and readback validation
│   ├── style.css           # Vanilla CSS design system, layout, animations, components
│   └── supabaseDiagnostics.js # Error categorization and sensitive identifier redaction
├── supabase/
│   └── migrations/
│       ├── 001_game.sql    # Base schema: rooms, players, actions, results, core RPCs
│       ├── 002_multiplayer_actions_and_readiness.sql # 6 actions, readiness state, request idempotency
│       └── 003_reconcile_move_rpcs.sql # Composite keys reconciliation, steal model, trap ordering
└── tests/
    ├── gameRules.test.js   # Unit & invariant tests for game rules, steal splits, and resolutions
    └── readiness.test.js   # Contract tests for lobby readiness, UI states, and RPC safeguards
```

---

## Database Setup

Game state is persisted and resolved through PostgreSQL in Supabase.

### Supabase Prerequisites

1. Create a project at [supabase.com](https://supabase.com).
2. Navigate to **Authentication → Providers → Email / Password & Other Providers**.
3. Enable **Anonymous Sign-ins** (allows players to join rooms without creating persistent accounts).

### Applying Migrations

Execute the migration scripts in sequential order using the **Supabase SQL Editor** or the **Supabase CLI**:

1. [**`supabase/migrations/001_game.sql`**](supabase/migrations/001_game.sql):
   - Sets up initial tables (`rooms`, `players`, `actions`, `round_results`).
   - Enables Row Level Security (RLS) across all tables.
   - Defines initial RPCs (`create_room`, `join_room`, `start_game`, `get_room`, `submit_action`, `heartbeat`).

2. [**`supabase/migrations/002_multiplayer_actions_and_readiness.sql`**](supabase/migrations/002_multiplayer_actions_and_readiness.sql):
   - Adds `create_request_id` to `rooms` for idempotent room creation.
   - Adds `ready` status tracking to `players`.
   - Expands supported actions to all six moves: `search`, `steal`, `trap`, `guard`, `dig_deep`, `explore`.
   - Configures composite foreign keys and scoped realtime policies.

3. [**`supabase/migrations/003_reconcile_move_rpcs.sql`**](supabase/migrations/003_reconcile_move_rpcs.sql):
   - Refines `resolve_round_internal` with safe steal debit/credit validation.
   - Enforces trap penalty resolution before steal distribution to guarantee non-negative coin balances.
   - Adds room-scoped locks and concurrency reconciliation.

> **Caution:** Always review SQL migrations before executing them against a production database.

---

## Security

- **Row Level Security (RLS):** All tables enforce RLS. Move choices submitted to `actions` have no client read policies; choices remain strictly hidden from other players until published to `round_results`.
- **Client Privilege Isolation:** Only the public anon key is bundled in the frontend. Privileged administrative keys (`service_role`) must never be deployed to client code.
- **Transactional Server Authority:** Coin costs, random generation (`dig_deep`, `explore`), and resolution logic execute exclusively within `SECURITY DEFINER` PostgreSQL functions. Clients cannot forge coin balances or alter game state directly.
- **Diagnostic Redaction:** Client diagnostics in `supabaseDiagnostics.js` automatically sanitize UUIDs, room codes, and action choices before printing to console logs during development.
- **Credential Hygiene:** Git ignore rules prevent `.env`, `.env.*`, certificates (`*.pem`, `*.key`), and secrets from being committed to source control.

---

## Deployment

The application compiles to a static single-page application that can be hosted on any static hosting platform.

### Netlify Deployment

The repository includes a [netlify.toml](netlify.toml) pre-configured with:
- **Build command:** `npm run build`
- **Publish directory:** `dist`
- **SPA rewrite rule:** `/*` redirects to `/index.html` (HTTP 200)

**Deployment Steps:**
1. Connect your repository to Netlify.
2. In the Netlify site dashboard, navigate to **Site configuration → Environment variables**.
3. Add `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`.
4. Trigger a deploy.

---

## Contributing

Contributions, bug reports, and improvements are welcome:

1. **Fork the repository** on GitHub.
2. **Create a feature branch:**
   ```bash
   git checkout -b feature/your-feature-name
   ```
3. **Make your changes** and verify that all tests pass:
   ```bash
   npm test
   ```
4. **Verify the production build:**
   ```bash
   npm run build
   ```
5. **Commit your changes** with clear commit messages:
   ```bash
   git commit -m "Add descriptive message"
   ```
6. **Push to your branch and open a Pull Request.**

---

## License

No license has been specified for this project. All rights are reserved by the repository owner.
