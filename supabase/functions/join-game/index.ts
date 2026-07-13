// supabase/functions/join-game/index.ts
// Seat a player from an invite code while the table is still in the lobby, and
// buy them in for the table's starting stack.
import {
  getCtx, json, corsHeaders, adjustChips,
} from "../_shared/poker-logic.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const ctx = await getCtx(req);
  if (ctx instanceof Response) return ctx;
  const { admin, userId } = ctx;

  const { invite_code } = await req.json().catch(() => ({}));
  if (!invite_code) return json({ error: "invite_code required" }, 400);

  const { data: game } = await admin.from("games")
    .select("*").eq("invite_code", String(invite_code).toUpperCase()).single();
  if (!game) return json({ error: "Table not found" }, 404);
  if (game.status !== "lobby") return json({ error: "Table already started" }, 409);

  const { data: seats } = await admin.from("game_players")
    .select("player_id, seat").eq("game_id", game.id);
  const players = seats ?? [];

  if (players.some((p) => p.player_id === userId)) {
    return json({ game_id: game.id, already_seated: true });
  }
  if (players.length >= 10) return json({ error: "Table is full (10 max)" }, 409);

  if (game.stake_type === "chips") {
    const { data: prof } = await admin.from("profiles").select("chips").eq("id", userId).single();
    if (!prof || prof.chips < game.buy_in) return json({ error: "Not enough chips for the buy-in" }, 409);
  }

  // Lowest free seat index (so seats stay compact as players come and go).
  const taken = new Set(players.map((p) => p.seat));
  let seat = 0;
  while (taken.has(seat)) seat++;

  const tracked = game.stake_type !== "none";

  const { error } = await admin.from("game_players").insert({
    game_id: game.id,
    player_id: userId,
    seat,
    stack: game.buy_in,
    total_bet: tracked ? game.buy_in : 0,
  });
  if (error) return json({ error: "Could not take a seat, try again" }, 409);

  if (tracked) {
    await admin.from("ledger_entries").insert({
      game_id: game.id, player_id: userId, amount: -game.buy_in, reason: "buy_in",
    });
  }
  if (game.stake_type === "chips") await adjustChips(admin, userId, -game.buy_in);

  // Mark any pending invite for this player as accepted.
  await admin.from("invites")
    .update({ status: "accepted" })
    .eq("game_id", game.id).eq("invitee", userId).eq("status", "pending");

  return json({ game_id: game.id, seat });
});
