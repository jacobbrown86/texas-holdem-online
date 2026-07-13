# Texas Hold'em Online — Setup

Follow this once to stand up the backend and get the app running locally, then
the deploy section to put it on Vercel. It mirrors the Snake Eyes playbook.

---

## 0. Prerequisites
- Node 18+ (`node -v`)
- A Supabase account (free tier is fine)
- A Gmail account with an **App Password** (for sending sign-in codes)
- Windows/PowerShell: use `npm.cmd` / `npx.cmd` if the plain names are blocked.

---

## 1. Create the Supabase project
1. Go to <https://supabase.com/dashboard> → **New project**.
2. Name it `texas-holdem` (or anything), pick a region near you, set a strong DB
   password (save it), and create. Wait ~2 min for it to provision.

## 2. Apply the schema
1. In the project, open **SQL Editor** → **New query**.
2. Paste the contents of each migration **in order** and run each:
   - `supabase/migrations/001_schema.sql`
   - `supabase/migrations/002_invites.sql`
   - `supabase/migrations/003_realtime_replica_identity.sql`
   - `supabase/migrations/004_messages.sql`
   - `supabase/migrations/005_push.sql`
3. Confirm under **Table Editor** you see: `profiles`, `games`, `game_players`,
   `hole_cards`, `actions`, `showdowns`, `ledger_entries`, `invites`, `messages`,
   `push_subscriptions`.

## 3. Email **code** auth (not magic link)
1. **Authentication → Providers → Email**: enable Email, turn **Confirm email**
   ON, and **turn OFF** "Secure email change" isn't required — leave defaults.
2. **Authentication → Email Templates → Magic Link**: replace the body so it
   prints the code instead of a link. Minimum:
   ```html
   <h2>Your sign-in code</h2>
   <p>Enter this code in the app:</p>
   <p style="font-size:28px;font-weight:bold;letter-spacing:4px">{{ .Token }}</p>
   ```
   (Keep `{{ .Token }}` — that's the 6-digit code the app asks for.)
3. **Custom SMTP** (so codes actually send): **Project Settings → Authentication →
   SMTP Settings** → enable custom SMTP:
   - Host: `smtp.gmail.com`  Port: `465`
   - Username: your Gmail address
   - Password: your Gmail **App Password** (Google Account → Security → 2-Step
     Verification → App passwords)
   - Sender email: your Gmail address · Sender name: `Texas Hold'em`
4. **Authentication → URL Configuration**: set **Site URL** to
   `http://localhost:5173` and add your Vercel URL later. Add
   `http://localhost:5173` to **Redirect URLs** too.

## 4. Get the API keys
**Project Settings → API**:
- **Project URL** → `VITE_SUPABASE_URL`
- **Publishable key** (`sb_publishable_…`) or the legacy **anon public** key →
  `VITE_SUPABASE_ANON_KEY`
- **Secret key** (`sb_secret_…`) or legacy **service_role** → keep for the
  function secret `SB_SECRET_KEY` (Step 6). **Never** put this in the client.

## 5. Client env
```bash
cd client
cp .env.local.example .env.local   # then edit .env.local
npm install
npm run dev
```
Fill `.env.local`:
```
VITE_SUPABASE_URL=https://YOUR-ref.supabase.co
VITE_SUPABASE_ANON_KEY=sb_publishable_...
VITE_VAPID_PUBLIC_KEY=            # leave blank until push is set up
```
Restart `npm run dev` after editing (Vite bakes env at start). The setup banner
should disappear and you'll get the sign-in screen.

## 6. Supabase CLI + deploy the Edge Functions
```bash
npm i -g supabase            # or: npx supabase ...
supabase login
supabase link --project-ref YOUR-ref     # ref is in the dashboard URL

# Function secrets (service key + publishable key; VAPID later)
supabase secrets set SB_SECRET_KEY=sb_secret_...
supabase secrets set SB_PUBLISHABLE_KEY=sb_publishable_...

# Deploy each function (verify each prints "Deployed Function ... ")
supabase functions deploy create-game   --project-ref YOUR-ref
supabase functions deploy join-game      --project-ref YOUR-ref
supabase functions deploy cancel-game    --project-ref YOUR-ref
supabase functions deploy leave-table    --project-ref YOUR-ref
supabase functions deploy invite-player  --project-ref YOUR-ref
supabase functions deploy send-message   --project-ref YOUR-ref
```

## 7. Smoke test the lobby (the Phase 2 milestone)
1. Two browser windows (one normal, one incognito). Sign in as two different
   emails, pick two usernames.
2. Window A: **Online → Create table** (pick blinds/buy-in). You land in the lobby.
3. Copy the code; Window B: paste into **Join a table**. Seat fills live in A.
4. Check **Table Editor → game_players**: two rows, `stack` = buy-in each; both
   players' `profiles.chips` dropped by the buy-in.

That's the stopping point for this session. Dealing + betting (private hole
cards) is Phase 3.

---

## Deploy to Vercel
1. Push this repo to GitHub.
2. Vercel → **New Project** → import the repo.
3. **Root Directory = `client`** (important — the app lives there).
4. Framework preset: **Vite**. Build `npm run build`, output `dist`.
5. **Environment Variables**: add `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`
   (and `VITE_VAPID_PUBLIC_KEY` once you have it). **Redeploy** after adding env
   vars — Vite bakes them at build time.
6. Deploy. `client/vercel.json` already has SPA rewrites so `/g/CODE` deep links
   work. Add the Vercel URL to Supabase **Site URL** + **Redirect URLs**.
7. Push to `main` = auto-deploy from then on.
