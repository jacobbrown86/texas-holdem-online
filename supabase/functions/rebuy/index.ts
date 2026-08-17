// supabase/functions/rebuy/index.ts
// A busted player (stack 0) buys back in for the table's buy-in between hands.
import { getCtx, json, corsHeaders, loadGame, adjustChips } from "../_shared/poker-logic.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const ctx = await getCtx(req);
  if (ctx instanceof Response) return ctx;
  const { admin, userId } = ctx;

  const { game_id } = await req.json().catch(() => ({}));
  if (!game_id) return json({ error: "game_id required" }, 400);

  const { game, players } = await loadGame(admin, game_id);
  if (!game) return json({ error: "Table not found" }, 404);
  if (game.status !== "active") return json({ error: "No active table" }, 409);
  if (game.street !== "idle") return json({ error: "Wait until the hand finishes to rebuy" }, 409);

  const me = players.find((p) => p.player_id === userId);
  if (!me) return json({ error: "You're not at this table" }, 403);
  if (me.stack > 0) return json({ error: "You still have chips" }, 409);

  if (game.stake_type === "chips") {
    const { data: prof } = await admin.from("profiles").select("chips").eq("id", userId).single();
    if (!prof || prof.chips < game.buy_in) return json({ error: "Not enough chips to rebuy" }, 409);
  }

  await admin.from("game_players").update({
    stack: game.buy_in,
    total_bet: me.total_bet + game.buy_in,
    status: "seated",
  }).eq("game_id", game.id).eq("player_id", userId);

  if (game.stake_type !== "none") {
    await admin.from("ledger_entries").insert({
      game_id: game.id, player_id: userId, amount: -game.buy_in, reason: "rebuy",
    });
  }
  if (game.stake_type === "chips") await adjustChips(admin, userId, -game.buy_in);

  return json({ ok: true, stack: game.buy_in });
});
