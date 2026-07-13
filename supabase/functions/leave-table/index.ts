// supabase/functions/leave-table/index.ts
// A non-host player leaves a table. In the lobby their buy-in is refunded and the
// seat is freed. (Leaving mid-hand — fold, cash out the stack — lands in Phase 5;
// for now leaving is a lobby action. The host cancels the whole table instead.)
import {
  getCtx, json, corsHeaders, loadGame, adjustChips,
} from "../_shared/poker-logic.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const ctx = await getCtx(req);
  if (ctx instanceof Response) return ctx;
  const { admin, userId } = ctx;

  const { game_id } = await req.json().catch(() => ({}));
  if (!game_id) return json({ error: "game_id required" }, 400);

  const { game, players } = await loadGame(admin, game_id);
  if (!game) return json({ error: "Table not found" }, 404);
  const me = players.find((p) => p.player_id === userId);
  if (!me) return json({ error: "You're not at this table" }, 403);
  if (game.created_by === userId) {
    return json({ error: "You're the host — cancel the table instead" }, 409);
  }

  // Clear any pending invite so it doesn't reappear on Home.
  await admin.from("invites")
    .update({ status: "declined" })
    .eq("game_id", game.id).eq("invitee", userId).eq("status", "pending");

  // Over already: just drop the seat, nothing to refund.
  if (game.status === "finished" || game.status === "abandoned") {
    await admin.from("game_players").delete().eq("game_id", game.id).eq("player_id", userId);
    return json({ left: true });
  }

  if (game.status === "lobby") {
    // Refund the chip buy-in and free the seat.
    if (game.stake_type === "chips" && (me.total_bet || 0) > 0) {
      await adjustChips(admin, userId, me.total_bet);
    }
    const remaining = players.length - 1;
    if (remaining === 0) {
      await admin.from("games")
        .update({ status: "abandoned", current_seat: null })
        .eq("id", game.id);
    }
    await admin.from("game_players").delete().eq("game_id", game.id).eq("player_id", userId);
    return json({ left: true, refunded: me.total_bet || 0 });
  }

  // Active hand: cashing out mid-hand comes in Phase 5.
  return json({ error: "You can't leave in the middle of a hand yet." }, 409);
});
