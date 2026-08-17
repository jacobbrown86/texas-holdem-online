// supabase/functions/timeout-sweep/index.ts
// Cron-invoked. Finds live hands whose current player has run out the clock
// (turn_deadline in the past) and auto-acts for them: check if it's free,
// otherwise fold — through the exact same engine as a real move.
//
// Deploy with --no-verify-jwt and guard with the CRON_SECRET header so only the
// scheduled job (which knows the secret) can trigger it.
import { createClient } from "npm:@supabase/supabase-js@2";
import { json, corsHeaders, loadGame } from "../_shared/poker-logic.ts";
import { applyAndResolve } from "../_shared/engine.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const secret = Deno.env.get("CRON_SECRET");
  if (!secret || req.headers.get("x-cron-secret") !== secret) {
    return json({ error: "Unauthorized" }, 401);
  }

  const url = Deno.env.get("SUPABASE_URL")!;
  const service = Deno.env.get("SB_SECRET_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(url, service);

  const nowIso = new Date().toISOString();
  const { data: due, error } = await admin.from("games")
    .select("id")
    .eq("status", "active")
    .in("street", ["preflop", "flop", "turn", "river"])
    .not("current_seat", "is", null)
    .lt("turn_deadline", nowIso);
  if (error) return json({ error: error.message }, 500);

  let swept = 0;
  const details: Record<string, unknown>[] = [];

  for (const row of due ?? []) {
    try {
      const { game, players } = await loadGame(admin, row.id);
      if (!game || game.current_seat == null) continue;
      const me = players.find((p) => p.seat === game.current_seat);
      if (!me || !me.in_hand || me.has_folded || me.is_all_in) continue;

      // Auto-action: check if there's nothing to call, otherwise fold.
      const toCall = game.current_bet - me.street_bet;
      const action = toCall > 0 ? "fold" : "check";
      const r = await applyAndResolve(admin, game, players, me, action, 0);
      if (!r.error) { swept++; details.push({ game: row.id, seat: me.seat, action }); }
    } catch (e) {
      details.push({ game: row.id, error: String(e) });
    }
  }

  return json({ swept, details });
});
