# Texas Hold'em Online — Architecture Blueprint

**Stack:** React (Vite) · Supabase (Auth, Postgres, Realtime, Edge Functions) · Vercel
**Money model:** Virtual chips by default, plus an optional private "ledger" players
settle offline. The app never moves money.
**Reference implementation:** Snake Eyes Online (`snake-eyes-online.vercel.app`) —
reuse its plumbing verbatim; this doc focuses on what poker changes.

---

## 1. Core design rules
1. **The server deals the cards.** A Supabase Edge Function shuffles with
   `crypto.getRandomValues()` and deals. The client only *requests* actions and
   *renders* state. Cheat-proof by construction.
2. **Hole cards are private.** They live in a table whose RLS only lets a player
   read their own row. The client never receives opponents' hole cards until a
   showdown row is written that makes them public.
3. **The database is the referee.** Whose turn, current bet, pot, stacks, street,
   button, blinds — all in Postgres, all validated server-side ("is it your turn?",
   "is this raise ≥ min-raise?", "do you have the chips?").
4. **One schema, three play modes.** Online (live/async), in-person one-phone, and
   vs-computer. Only the online mode uses the DB + Edge Functions; in-person and
   vs-computer run entirely client-side (mirror Snake Eyes' `LocalGame`).

---

## 2. Database schema (Postgres / Supabase)

Reuse Snake Eyes' `profiles`, `invites`, `messages`, `push_subscriptions` tables
**unchanged**. Poker-specific tables below. Every game mutation is gated by a
`version` column (optimistic concurrency, like Snake Eyes `claimGame`).

```sql
-- A table (one poker game). Persists across many hands.
create table games (
  id            uuid primary key default gen_random_uuid(),
  invite_code   text unique not null,
  status        text not null default 'lobby'
                check (status in ('lobby','active','finished','abandoned')),
  mode          text not null default 'async' check (mode in ('live','async')),
  stake_type    text not null default 'chips' check (stake_type in ('chips','ledger','none')),
  small_blind   integer not null default 1,
  big_blind     integer not null default 2,
  buy_in        integer not null default 200,   -- starting stack per player
  -- live hand state:
  hand_no       integer not null default 0,
  button_seat   integer,                          -- dealer button
  street        text default 'idle'
                check (street in ('idle','preflop','flop','turn','river','showdown')),
  board         smallint[] default '{}',          -- community cards (0..51), public
  current_seat  integer,                           -- whose action
  current_bet   integer not null default 0,        -- amount to call on this street
  min_raise     integer not null default 0,        -- min legal raise increment
  last_aggressor_seat integer,                      -- who to stop the round on
  pot           integer not null default 0,        -- collected to the middle
  deck_hash     text,                               -- optional: commit-reveal fairness
  turn_deadline timestamptz,
  version       integer not null default 0,
  created_by    uuid not null references profiles(id),
  winner_ids    uuid[],
  created_at    timestamptz not null default now(),
  finished_at   timestamptz
);

-- Who is at the table (persists across hands).
create table game_players (
  game_id     uuid not null references games(id) on delete cascade,
  player_id   uuid not null references profiles(id),
  seat        integer not null check (seat between 0 and 9),
  stack       integer not null default 0,          -- chips in front of them
  total_bet   integer not null default 0,          -- lifetime buy-ins + rebuys (for ledger)
  status      text not null default 'seated'
              check (status in ('seated','sitting_out','left')),
  -- per-hand state (reset each hand):
  in_hand     boolean not null default false,      -- dealt into current hand
  has_folded  boolean not null default false,
  street_bet  integer not null default 0,          -- chips committed on the current street
  has_acted   boolean not null default false,      -- acted since the last raise
  is_all_in   boolean not null default false,
  joined_at   timestamptz not null default now(),
  primary key (game_id, player_id),
  unique (game_id, seat)
);

-- PRIVATE hole cards. RLS: a player reads only their own row.
create table hole_cards (
  game_id   uuid not null references games(id) on delete cascade,
  player_id uuid not null references profiles(id),
  hand_no   integer not null,
  cards     smallint[] not null,                    -- two cards, 0..51
  primary key (game_id, player_id, hand_no)
);

-- Action log (audit + replay + drives the action feed via Realtime).
create table actions (
  id         bigint generated always as identity primary key,
  game_id    uuid not null references games(id) on delete cascade,
  hand_no    integer not null,
  player_id  uuid references profiles(id),
  seat       integer,
  street     text,
  action     text not null
             check (action in ('post_sb','post_bb','fold','check','call','bet','raise','all_in','deal','win')),
  amount     integer not null default 0,
  created_at timestamptz not null default now()
);

-- Showdown reveals (makes shown hole cards public for the hand). Client reads
-- these to display opponents' cards ONLY at showdown.
create table showdowns (
  id         bigint generated always as identity primary key,
  game_id    uuid not null references games(id) on delete cascade,
  hand_no    integer not null,
  player_id  uuid not null references profiles(id),
  cards      smallint[] not null,
  hand_rank  text,                                  -- e.g. "Full house, Kings over Nines"
  won        integer not null default 0
);

-- ledger_entries: reuse Snake Eyes shape; reasons: 'buy_in','rebuy','pot_win','zero_penalty'.
```

### Card encoding
A card is `0..51`. `rank = card % 13` (0=2 … 12=Ace), `suit = floor(card / 13)`
(0♣ 1♦ 2♥ 3♠). Keep it in `poker-logic.ts` with `cardName(n)` helpers.

### Row Level Security (the important bits)
```sql
alter table games enable row level security;
alter table game_players enable row level security;
alter table hole_cards enable row level security;
alter table actions enable row level security;
alter table showdowns enable row level security;

create policy "read own games" on games for select using (is_in_game(id) or status='lobby');
create policy "read seats" on game_players for select using (is_in_game(game_id));
create policy "read own hole cards" on hole_cards for select using (player_id = auth.uid()); -- PRIVATE
create policy "read actions" on actions for select using (is_in_game(game_id));
create policy "read showdowns" on showdowns for select using (is_in_game(game_id));
-- No client INSERT/UPDATE/DELETE on any game table. Deliberate.

-- Realtime + RLS need REPLICA IDENTITY FULL to deliver UPDATE events (learned the
-- hard way in Snake Eyes). Apply to games, game_players, actions.
alter table games replica identity full;
alter table game_players replica identity full;
alter table actions replica identity full;
alter publication supabase_realtime add table games, game_players, actions, showdowns, hole_cards;
```
> `is_in_game(uuid)` is the same SECURITY DEFINER helper as Snake Eyes.

---

## 3. Edge Functions (the referee)

Each function: authenticates the caller, loads + version-locks the game, validates,
mutates, logs an `actions` row, returns new public state. Reuse Snake Eyes'
`getCtx`, `json`, `claimGame`, `corsHeaders` from a shared module.

| Function | Validates | Does |
|---|---|---|
| `create-game` | blinds, buy-in, stake | Create lobby, seat creator, generate code |
| `join-game` | lobby, <10 seats, chips ≥ buy-in | Seat player, deduct buy-in into their stack |
| `start-hand` | host or auto, ≥2 seated with chips | Move button, post blinds, **shuffle + deal 2 hole cards each (into `hole_cards`)**, set `street=preflop`, `current_seat`=UTG, log `deal` |
| `act` | caller is `current_seat`, action legal | Apply fold/check/call/bet/raise/all-in; update `street_bet`, `stack`, `pot`, `current_bet`, `min_raise`, `has_acted`; advance to next to act |
| `advance-street` | betting round closed | Deal flop/turn/river to `board`, reset `street_bet`/`has_acted`, set first-to-act; or trigger showdown |
| `showdown` | river betting done or all-in runout | Evaluate best hands, build **side pots**, write `showdowns`, award chips, log `win`, end hand |
| `rebuy` | stack 0, chips available | Top stack back to buy-in, ledger `rebuy` |
| `leave-table` | any | Fold if in a hand, cash stack to chips, seat = `left` |

Reuse `cancel-game`, `invite-player`, `send-message`, `leave-game` patterns.

### The betting engine (in `act`)
- Legal actions depend on `current_bet` vs the player's `street_bet`:
  - `current_bet == street_bet` → **check** or **bet**.
  - `current_bet > street_bet` → **call** (pay the difference), **raise**, or **fold**.
  - Insufficient chips to call → **all-in** for whatever they have.
- **Raise** must be ≥ `current_bet + min_raise` (min_raise starts = big_blind, then
  = size of the last raise). A full raise reopens action (`has_acted=false` for all
  others still in). An all-in raise smaller than a full raise does NOT reopen it.
- After each action, advance `current_seat` to the next non-folded, non-all-in
  player. The betting round **closes** when action returns to `last_aggressor_seat`
  (or everyone has `has_acted` and matched `current_bet`). Then move `street_bet`
  into `pot`, `advance-street`.
- Hand ends early if all but one fold → that player wins the pot uncontested (no
  card reveal required).

### Hand evaluation + side pots (in `poker-logic.ts`, used by `showdown`)
- `bestHand(sevenCards)` → a comparable rank tuple `[category, ...tiebreakers]`.
  Categories: high card < pair < two pair < trips < straight < flush < full house
  < quads < straight flush. Evaluate the best 5 of 7. (A wheel A-2-3-4-5 is a
  straight; ace high or low.)
- **Side pots**: sort all-in amounts; for each distinct all-in level, form a pot
  contested only by players who put in at least that much. Award each pot to the
  best eligible hand; split ties (odd chips to earliest seat left of the button).

### Turn timers (async + live) — same as Snake Eyes
`live`: `turn_deadline = now()+60s`; `async`: `+48h`. A pg_cron sweep auto-folds (or
checks if free) anyone past the deadline. Send a "your turn" push at deal + a 24h
nudge in async.

---

## 4. Realtime (how everyone sees the same table)
One channel per game. Subscribe to Postgres changes on `games`, `game_players`,
`actions`, `showdowns` filtered by `game_id`, **plus** the caller's own `hole_cards`
row. The client re-fetches state on any change (with the Snake Eyes safeguards: 3s
poll while a hand is live, resync on foreground, drive your own action locally,
hold state during deal/flip animations). Never subscribe to other players' hole
cards — RLS blocks it anyway.

Card animations (deal, flop/turn/river flips, chips to pot) are client-side theater
played off the `actions` feed, same "same drama, zero trust" model as the Snake
Eyes dice tumble.

---

## 5. Invite / chat / notifications
Identical to Snake Eyes — reuse the tables and functions:
- Invite by share link `/g/CODE`, 6-char code (in-app "Join a table" box), or
  **username** (`invite-player`, "You're invited" on Home, recent-players list).
- Table **chat** with `@username` tagging via `send-message` (server-routed so it
  can push).
- **Push**: notify a player when **it's their turn to act**, when invited, and on
  new chat. Wire `notifyTurn`-equivalent into `start-hand`, `act`, `advance-street`.

---

## 6. In-person & vs-computer (client-only, mirror Snake Eyes `LocalGame`)
- **In person (one phone):** enter names, pass the phone. Because everyone shares the
  screen, hole cards are shown one player at a time behind a "pass to <name> — tap
  to see your cards" gate (tap to reveal, tap to hide before passing). All betting,
  pots, side pots, showdown run locally in `poker-logic.ts` (the SAME engine as the
  server — write it isomorphic so both use it). Persist to `localStorage`; show as a
  resumable "LIVE GAME" row on Home.
- **Vs the computer:** same local engine; fill empty seats with AI opponents. Start
  with a simple heuristic bot (fold weak / call medium / raise strong by hand
  strength + pot odds), improve later. The human plays their seat; the app plays the
  bots with a short "thinking" delay for feel.

---

## 7. Money guardrails (non-negotiable for v1)
- `chips`: purely virtual, no cash meaning anywhere.
- `ledger`: show a settlement summary at the end ("Mike is down $40 to the table")
  with **no payment links, no Venmo handles** — settle privately.
- No buying chips with real money. That single feature is the line between
  "scorekeeper" and "gambling operator." Talk to a lawyer before ever crossing it.

---

## 8. Build order (each phase playable)

| Phase | Deliverable | New vs Snake Eyes |
|---|---|---|
| 1 | Supabase project, schema, email-code auth, profiles, SMTP | Mostly reuse |
| 2 | Lobby: create table (blinds/buy-in), invite link/code/username, seats fill live | Reuse Snake Eyes lobby |
| 3 | `start-hand` + `act` + private hole cards + preflop betting | **New: dealing, card privacy, betting engine** |
| 4 | Streets (flop/turn/river) + showdown + hand evaluation + pot award + next hand | **New: `poker-logic` hand eval** |
| 5 | All-ins + side pots + rebuys + bust/leave + ledger settlement | **New: side pots** |
| 6 | In-person one-phone (pass-and-hide) + vs-computer AI + chat + push + polish | Reuse chat/push; new AI + reveal gate |

**Phase 3 is the milestone that matters** — once two phones each see only their own
hole cards and can fold/call/raise a hand of preflop poker through the server,
everything after is additive.

---

## 9. Operational playbook carried from Snake Eyes (saves days)
- **Auth is an emailed CODE, not a magic link.** `signInWithOtp` → `verifyOtp({type:'email'})`. Edit the Supabase "Magic Link" email template to print `{{ .Token }}`; set up **custom SMTP** (Gmail app password) or codes don't send. Accept 6–10 digit codes.
- **Supabase new API keys:** client uses the **publishable** `sb_publishable_…` key as `VITE_SUPABASE_ANON_KEY`; functions use a **secret** `sb_secret_…` via `SB_SECRET_KEY`/`SB_PUBLISHABLE_KEY` secrets (with legacy fallback in `getCtx`). Don't paste the service_role/secret key into chat.
- **Realtime under RLS needs `REPLICA IDENTITY FULL`** on tables you watch for UPDATEs, or only INSERTs propagate. Also poll every ~3s while a hand is live and resync on `visibilitychange`/`focus` — mobile sockets drop.
- **Drive your own action's UI from the function response on a local timer**, not the realtime echo (which lags / drops when the phone sleeps). Hold visible state during any deal/flip animation so results don't appear early.
- **Vercel:** connect the GitHub repo, **root directory = `client`**, set env vars (`VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_VAPID_PUBLIC_KEY`) and **redeploy after adding env vars** (Vite bakes them at build). `client/vercel.json` needs SPA rewrites so `/g/CODE` deep links work. Push to `main` = auto-deploy.
- **Function secrets** (`supabase secrets set …`): `SB_SECRET_KEY`, `SB_PUBLISHABLE_KEY`, `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`. The VAPID **public** key must match `VITE_VAPID_PUBLIC_KEY` in Vercel.
- **iOS PWA:** `viewport-fit=cover` + `env(safe-area-inset-*)` padding to clear the camera; push only fires from the installed home-screen app (16.4+) when it's backgrounded; iOS caches the home-screen icon (delete + re-add to update). Add an in-app "Refresh" button.
- **Windows PowerShell:** use `npm.cmd` / `npx.cmd` (`.ps1` wrappers are blocked); run the dev server on the port that's in Supabase's redirect allowlist; `gh` auth lives in the interactive shell.
- **Migrations aren't auto-applied** — paste the SQL into the Supabase SQL editor (or `supabase db push`). Deploy each Edge Function with `npx supabase functions deploy <name> --project-ref <ref>`.
