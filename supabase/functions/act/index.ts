// supabase/functions/act/index.ts
// The referee for a human's move. Authenticates the caller, checks it's really
// their turn, then hands off to the shared engine (applyAndResolve), which runs
// the betting, street progression, and showdown server-side. Never trusts input.
import { getCtx, json, corsHeaders, loadGame } from "../_shared/poker-logic.ts";
import { applyAndResolve } from "../_shared/engine.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const ctx = await getCtx(req);
  if (ctx instanceof Response) return ctx;
  const { admin, userId } = ctx;

  const body = await req.json().catch(() => ({}));
  const gameId = body.game_id;
  const action = body.action;
  const amount = Number(body.amount);
  if (!gameId) return json({ error: "game_id required" }, 400);

  const { game, players } = await loadGame(admin, gameId);
  if (!game) return json({ error: "Table not found" }, 404);
  if (game.status !== "active" || !["preflop", "flop", "turn", "river"].includes(game.street)) {
    return json({ error: "No hand in progress" }, 409);
  }
  const me = players.find((p) => p.player_id === userId);
  if (!me) return json({ error: "You're not at this table" }, 403);
  if (me.seat !== game.current_seat) return json({ error: "It's not your turn" }, 409);
  if (!me.in_hand || me.has_folded || me.is_all_in) return json({ error: "You're not in the action" }, 409);

  const r = await applyAndResolve(admin, game, players, me, action, amount);
  if (r.error) return json({ error: r.error }, r.code ?? 409);
  return json(r);
});
