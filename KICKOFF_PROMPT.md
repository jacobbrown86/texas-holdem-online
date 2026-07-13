# KICKOFF PROMPT — paste this as your first message in Claude Code

(Open Claude Code with this folder — `Documents\Texas Holdem` — as the project
root, so it reads CLAUDE.md, and can see docs/poker-blueprint.md.)

---

Read `CLAUDE.md` and `docs/poker-blueprint.md` first. This is a Texas Hold'em poker
game built in the **same architecture and house style as my Snake Eyes Online
project**, which is finished and deployed. Reuse Snake Eyes' code and patterns
everywhere the game logic isn't poker-specific.

**The reference project is on this machine** at
`C:\Users\JacobBrown\Documents\Snake Eyes\snake-eyes-online\snake-eyes-online`
(repo `github.com/jacobbrown86/snake-eyes-online`, live at
`snake-eyes-online.vercel.app`). Read its `client/` and `supabase/` folders and
**port**: the auth flow (email code + custom SMTP), the lobby, invites
(`invite-player` + "You're invited"), chat (`send-message` + the `Chat` widget),
push notifications (`sw.js`, `_shared/push.ts`, VAPID), the in-person `LocalGame`
persistence pattern, the PWA setup, and the entire `styles.css` visual system
(green felt, gold, Limelight/Barlow, marquee/panel/chip/button components).

Please set up **Phases 1 & 2**:

1. Scaffold a Vite + React app in `client/` (install `@supabase/supabase-js` and
   `react-router-dom`). Copy the Snake Eyes styling + shared components as the
   starting point so it looks identical in feel. Add `client/vercel.json` with SPA
   rewrites.

2. Walk me through creating a **new Supabase project** step by step — I'll do the
   dashboard clicks, you tell me exactly what to click/paste. I need: the project
   created, the poker schema from the blueprint applied
   (`supabase/migrations/001_schema.sql`), the new API keys, email **code** auth
   working (edit the Magic Link template to show `{{ .Token }}`, set up custom
   SMTP with my Gmail app password), and my keys into `client/.env.local` +
   function secrets. (This is exactly what we did for Snake Eyes — follow that
   playbook; it's in the blueprint's "operational playbook" section.)

3. Set up the Supabase CLI, link the project, and write + deploy the first Edge
   Functions: `create-game`, `join-game` (with `_shared/poker-logic.ts` +
   `getCtx`/`json`/`claimGame` ported from Snake Eyes). Verify each deploys clean.

4. Build these screens, mobile-first (reuse Snake Eyes screens):
   - Sign-in (email code) + username onboarding + Home (game list, mode picker:
     Online / In person / Vs computer).
   - New game: blinds/big-blind (stake) selector, buy-in, stake type
     (chips/ledger/none) — reuse the chip-button styling — calls `create-game`.
   - Lobby at `/g/:code`: seats fill live via Realtime, share-link + copy-code,
     invite-by-username, host "START HAND" — reuse the Snake Eyes lobby wholesale.
   - Join flow: opening `/g/:code` while signed in calls `join-game`.

5. **Stop after the lobby works end-to-end** with two browser windows signed in as
   two different users (seats fill live, buy-in deducted). We'll build the actual
   dealing + betting (Phase 3, the private-hole-cards milestone) next session.

Important constraints (also in CLAUDE.md): the client never writes to game tables,
all mutations go through Edge Functions, **hole cards are private (RLS:
`player_id = auth.uid()`)**, and there is no real-money anything in this app.

Then hand me back a short deploy step: connect the repo to Vercel (root dir
`client`), set the env vars, and confirm auto-deploy on push — same as Snake Eyes.
