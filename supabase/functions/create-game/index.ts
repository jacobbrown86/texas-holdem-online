// supabase/functions/create-game/index.ts
// Creates a poker table (lobby), seats the creator at seat 0, and buys them in
// for their starting stack. The "stake" the client sends is the BIG BLIND; the
// small blind is derived here (half, rounded down, min 1).
import {
  getCtx, json, corsHeaders, inviteCode, adjustChips,
} from "../_shared/poker-logic.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const ctx = await getCtx(req);
  if (ctx instanceof Response) return ctx;
  const { admin, userId } = ctx;

  const body = await req.json().catch(() => ({}));
  const mode = ["live", "async"].includes(body.mode) ? body.mode : "async";
  const stakeType = ["chips", "ledger", "none"].includes(body.stake_type)
    ? body.stake_type : "chips";

  const bigBlind = Number.isInteger(body.big_blind) && body.big_blind >= 2 && body.big_blind <= 1000
    ? body.big_blind : 2;
  const smallBlind = Math.max(1, Math.floor(bigBlind / 2));

  // Buy-in = starting stack. Must at least cover the big blind; capped for sanity.
  const buyIn = Number.isInteger(body.buy_in) && body.buy_in >= bigBlind && body.buy_in <= 1_000_000
    ? body.buy_in : bigBlind * 100;

  // chip games: verify the creator can cover the buy-in.
  if (stakeType === "chips") {
    const { data: prof } = await admin.from("profiles").select("chips").eq("id", userId).single();
    if (!prof || prof.chips < buyIn) return json({ error: "Not enough chips for the buy-in" }, 409);
  }

  const { data: game, error } = await admin.from("games").insert({
    invite_code: inviteCode(),
    mode,
    stake_type: stakeType,
    small_blind: smallBlind,
    big_blind: bigBlind,
    buy_in: buyIn,
    created_by: userId,
  }).select("*").single();
  if (error || !game) return json({ error: "Could not create table" }, 500);

  const tracked = stakeType !== "none"; // chips + ledger track lifetime buy-ins

  await admin.from("game_players").insert({
    game_id: game.id,
    player_id: userId,
    seat: 0,
    stack: buyIn,
    total_bet: tracked ? buyIn : 0,
  });

  if (tracked) {
    await admin.from("ledger_entries").insert({
      game_id: game.id, player_id: userId, amount: -buyIn, reason: "buy_in",
    });
  }
  if (stakeType === "chips") await adjustChips(admin, userId, -buyIn);

  return json({
    game_id: game.id,
    invite_code: game.invite_code,
    share_url_path: `/g/${game.invite_code}`,
  });
});
