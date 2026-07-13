# CLAUDE.md — Texas Hold'em Online (Southern Cross)

## What this project is
A multiplayer **No-Limit Texas Hold'em** poker game (2–10 players) with the same
house/aesthetic as **Snake Eyes Online**. Three ways to play:
- **Online** — each player on their own device, live or async (Words-with-Friends
  style). Invite by share link, 6-char code, *or* by username. Same as Snake Eyes.
- **In person** — one phone passed around a table, players entered by name, no
  accounts. Fully offline, state saved to `localStorage` so it survives app close.
- **Vs the computer** — in-person mode against AI opponents (made-up players that
  the app plays for).

**Stack:** React (Vite) · Supabase (Auth, Postgres, Realtime, Edge Functions) ·
Vercel hosting. Reuse the Snake Eyes visual system: green felt, gold `#c9a24b` /
`#ffd75a`, cream `#f5efdc`, Limelight (display) + Barlow / Barlow Condensed fonts,
480px mobile-first, the marquee / panel / chip-button / big-button components.

## Non-negotiable rules
1. **The server deals and referees.** All card dealing, betting validation, street
   progression, and pot math happen in Supabase **Edge Functions** using the
   service role. Clients never write to game tables — RLS is read-only for them.
2. **Cards are dealt server-side** with `crypto.getRandomValues()`. **HOLE CARDS
   ARE PRIVATE.** A player may only ever read *their own* hole cards (RLS:
   `player_id = auth.uid()`). Never send another player's hole cards to any client
   before showdown. Community cards are public once dealt.
3. **No real money, ever.** `stake_type` is `chips` (virtual), `ledger`
   (scorekeeping humans settle privately), or `none`. No payment integrations,
   purchase flows, chip-buying, or payment-app links.
4. **Poker rules live in `_shared/poker-logic.ts`** — the deck, the 7-card hand
   evaluator, the betting engine (legal actions, min-raise, all-in), side-pot
   splitting, and blind/button rotation. Nowhere else. Clients render outcomes.

## House rules / structure (encode these; ask before changing)
- No-Limit Hold'em, 2–10 seats.
- **Blinds**: small blind + big blind. The configured "stake" sets the big-blind
  size (SB = half, rounded). Optional antes off by default.
- **Button** rotates one seat left each hand; SB and BB post automatically. Heads-
  up (2 players): the button posts the SB.
- **Streets**: preflop → flop (3 community) → turn (1) → river (1). One betting
  round per street. First to act preflop = left of BB; postflop = left of button.
- **Actions**: fold, check, call, bet, raise, all-in. Enforce min-raise = size of
  the previous bet/raise; a raise reopens the action.
- **Showdown**: best 5-card hand from each player's 2 hole + 5 community wins.
  Ties split the pot (odd chips to the earliest seat left of the button). All-ins
  create **side pots**.
- **Starting stack / buy-in**: each player buys in for a fixed stack (e.g. 100 ×
  big blind) from their chips. **Rebuy**: a player who busts to 0 may rebuy for the
  buy-in (mirrors Snake Eyes re-ante) or leave the table.
- A hand ends when one player remains (all others folded) or at showdown. Then the
  button moves and the next hand deals — until players leave or the host ends it.

## Reuse from Snake Eyes — do NOT reinvent these
The reference project (`Documents\Snake Eyes\snake-eyes-online\snake-eyes-online`,
live at `snake-eyes-online.vercel.app`) already solved the whole non-game stack.
Port these directly:
- **Auth**: email 6–10 digit **code** (OTP) via `signInWithOtp` + `verifyOtp`
  (NOT magic link — links break on mobile/PWA). Needs the Supabase "Magic Link"
  email template edited to show `{{ .Token }}`, and **custom SMTP** (Gmail app
  password) so codes actually send.
- **Invites**: `invites` table + `invite-player` Edge Function; "You're invited"
  card on Home; invite by username + recent-players list; push on invite.
- **Chat**: `messages` table + `send-message` Edge Function (routes chat through
  the server so it can push); floating widget with `@username` tagging + unread
  badge; realtime + 4s poll fallback.
- **Push notifications**: `sw.js`, `push_subscriptions` table, `_shared/push.ts`
  (`npm:web-push`, VAPID secrets), Home toggle. For poker, notify the player when
  **it's their turn to act** and on new chat/invite. iOS push only fires from the
  installed home-screen PWA.
- **Realtime + sync**: `alter table … replica identity full` so UPDATE events
  deliver under RLS; a 3s poll while a hand is live; resync on
  `visibilitychange`/`focus`; drive *your own* action's UI locally, don't wait on
  realtime; hold visible state during any deal/reveal animation.
- **In-person persistence**: save the local game to `localStorage`
  (`se_local_game` equivalent), show it on Home as a resumable "LIVE GAME" row.
- **PWA / iOS**: `manifest.webmanifest`, apple-touch meta, `env(safe-area-inset-*)`
  padding, generated icons; iOS caches the home-screen icon (re-add to update).
- **Deploy**: GitHub → Vercel auto-deploy on push to `main`; Vercel root dir =
  `client`; client env vars `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` (the
  **publishable** `sb_publishable_…` key), `VITE_VAPID_PUBLIC_KEY`; function
  secrets `SB_SECRET_KEY`, `SB_PUBLISHABLE_KEY`, `VAPID_*`; SPA rewrites in
  `client/vercel.json`.
- **Windows/PowerShell gotchas**: use `npm.cmd` / `npx.cmd` (`.ps1` is blocked);
  the dev server must be on the port that's in Supabase's redirect allowlist.

## Conventions
- Frontend: Vite + React, plain CSS matching Snake Eyes' system, mobile-first
  480px max width. Copy `styles.css` and the component set as a starting point.
- Concurrency: every game mutation goes through an optimistic-concurrency gate
  (a `version` column + compare-and-swap), exactly like Snake Eyes' `claimGame`.
  On a 409, the client refetches and retries once.
- Realtime: one channel per game; Postgres changes on the public tables + the
  caller's own private hole-cards row.

## Build phases (each must be playable before moving on)
1. Supabase project + schema + email-code auth + username onboarding + custom SMTP.
2. Lobby: create table (blinds/stake/buy-in) → invite link/code/username → seats
   fill live via Realtime. Reuse Snake Eyes lobby wholesale.
3. **Deal + preflop betting** wired to Edge Functions, with private hole cards.
   Milestone: two phones each see only their own cards and can fold/call/raise.
4. Full streets (flop/turn/river), showdown + hand evaluation, pot award, next hand.
5. All-ins + side pots; rebuys; bust/leave; winner + ledger settlement summary.
6. In-person one-phone mode + vs-computer AI; chat; push notifications; polish.
