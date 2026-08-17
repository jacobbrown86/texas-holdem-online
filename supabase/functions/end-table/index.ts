// supabase/functions/end-table/index.ts
// Host ends the session (between hands). Cashes each player's remaining stack
// back to their chip balance, marks the table finished, and records the winner
// (biggest net result) so the settlement summary can be shown.
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
  if (game.created_by !== userId) return json({ error: "Only the host can end the table" }, 403);
  if (game.status === "finished") return json({ ok: true, already: true });
  if (game.status !== "active") return json({ error: "Nothing to settle — cancel from the lobby instead" }, 409);
  if (game.street !== "idle") return json({ error: "Finish the current hand first" }, 409);

  const seated = players.filter((p) => p.status !== "left");
  // Winner(s): biggest net (what they're walking away with minus what they put in).
  const net = (p: typeof players[number]) => p.stack - p.total_bet;
  const bestNet = seated.length ? Math.max(...seated.map(net)) : 0;
  const winnerIds = seated.filter((p) => net(p) === bestNet).map((p) => p.player_id);

  const claimed = await claimGame(admin, game.id, game.version, {
    status: "finished",
    street: "idle",
    current_seat: null,
    turn_deadline: null,
    winner_ids: winnerIds,
    finished_at: new Date().toISOString(),
  });
  if (!claimed) return json({ error: "Table state changed, try again" }, 409);

  // Cash out stacks to chips (chips mode only). Ledger/none settle off-app; the
  // final stacks stay on the rows for the settlement summary.
  if (game.stake_type === "chips") {
    for (const p of seated) {
      if (p.stack > 0) await adjustChips(admin, p.player_id, p.stack);
    }
  }

  return json({ ok: true, winner_ids: winnerIds });
});
