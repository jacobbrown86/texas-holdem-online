# Texas Hold'em Online

Multiplayer No-Limit Texas Hold'em (2–10 players) in the Southern Cross house
style — green felt, gold, Limelight/Barlow. Built in the same architecture as
[Snake Eyes Online](https://snake-eyes-online.vercel.app): React (Vite) +
Supabase (Auth, Postgres, Realtime, Edge Functions) + Vercel.

**No real money, ever.** Stakes are virtual `chips`, a private `ledger` friends
settle offline, or `none`.

## Play modes
- **Online** — each player on their own device, live or async. Invite by link,
  6-char code, or username.
- **In person** — one phone passed around the table, cards private behind a tap. *(Phase 6)*
- **Vs the computer** — practice against AI opponents. *(Phase 6)*

## Layout
```
client/                 Vite + React app (deploy root on Vercel)
  src/screens/          SignIn, Onboarding, Home, NewGame, GameRoom, LocalGame
  src/game/             LobbyView, Chat  (PlayView/showdown come in Phase 3–4)
  src/lib/              supabase, api (Edge Function wrappers), push
  src/styles.css        the whole visual system (green felt / gold / cards)
supabase/
  migrations/           001 schema · 002 invites · 003 realtime · 004 messages · 005 push
  functions/
    _shared/            poker-logic.ts (plumbing + cards + deck) · push.ts
    create-game join-game cancel-game leave-table invite-player send-message
docs/poker-blueprint.md Architecture blueprint (source of truth for the design)
CLAUDE.md               House rules + non-negotiables for contributors/agents
KICKOFF_PROMPT.md       The original build brief pasted into Claude Code
SETUP.md                Step-by-step backend + deploy walkthrough
```

## Non-negotiables (see CLAUDE.md)
1. The **server** deals and referees — all mutations go through Edge Functions;
   clients never write to game tables (RLS is read-only for them).
2. **Hole cards are private** — RLS lets a player read only their own row
   (`player_id = auth.uid()`); opponents' cards are never sent before showdown.
3. Poker rules live in `_shared/poker-logic.ts`. Clients render outcomes.

## Build status
- [x] **Phase 1** — schema, email-code auth, profiles, custom SMTP
- [x] **Phase 2** — lobby: create table, invite link/code/username, seats fill live
- [ ] **Phase 3** — deal + preflop betting with private hole cards *(next session)*
- [ ] Phase 4 — streets, showdown, hand evaluation, pot award
- [ ] Phase 5 — all-ins + side pots, rebuys, ledger settlement
- [ ] Phase 6 — in-person + vs-computer, chat, push, polish

## Getting started
See **[SETUP.md](SETUP.md)**. Short version:
```bash
cd client && cp .env.local.example .env.local   # fill in Supabase keys
npm install && npm run dev                        # http://localhost:5173
```

The reference project (reuse its patterns) is Snake Eyes Online at
`Documents\Snake Eyes\snake-eyes-online\snake-eyes-online`.
