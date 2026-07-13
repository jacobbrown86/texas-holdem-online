// supabase/functions/cancel-game/index.ts
// Host cancels a table. Marks it abandoned and refunds chip buy-ins/rebuys.
// (Mid-hand cancellation stays valid; pot handling for live hands lands in a
// later phase — for now tables are cancelled from the lobby.)
import {
  getCtx, json, corsHeaders, loadGame, claimGame, adjustChips,
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
  if (game.created_by !== userId) return json({ error: "Only the host can cancel" }, 403);
  if (game.status === "finished") return json({ error: "Table already finished" }, 409);
  if (game.status === "abandoned") return json({ cancelled: true });

  const claimed = await claimGame(admin, game.id, game.version, {
    status: "abandoned",
    current_seat: null,
    turn_deadline: null,
    pot: 0,
  });
  if (!claimed) return json({ error: "Table state changed, try again" }, 409);

  // Refund virtual chips players bought in with. Ledger/none stakes are settled
  // by humans, so there's nothing to reverse there.
  if (game.stake_type === "chips") {
    for (const p of players) {
      if (p.total_bet > 0) await adjustChips(admin, p.player_id, p.total_bet);
    }
  }

  return json({ cancelled: true });
});
