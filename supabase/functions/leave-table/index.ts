// supabase/functions/leave-table/index.ts
// A non-host player leaves a table. Lobby: buy-in refunded, seat freed. Between
// hands: stack cashed to chips, seat freed. Mid-hand: it counts as a FOLD that
// cashes out their remaining (uncommitted) stack — chips already in the pot stay
// there. If it's their turn the fold runs through the shared engine (which may
// advance the street or end the hand); otherwise they're folded out and the hand
// ends only if they were the last live opponent.
import {
  getCtx, json, corsHeaders, loadGame, adjustChips, claimGame,
} from "../_shared/poker-logic.ts";
import { applyAndResolve } from "../_shared/engine.ts";

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

  // Between hands (table active, no hand dealt): cash the stack out and free the seat.
  if (game.street === "idle") {
    if (game.stake_type === "chips" && me.stack > 0) {
      await adjustChips(admin, userId, me.stack);
    }
    await admin.from("game_players").delete().eq("game_id", game.id).eq("player_id", userId);
    return json({ left: true, cashed_out: me.stack });
  }

  // --- Mid-hand: leaving is a fold that cashes out the remaining stack. ---
  const cashOut = me.stack;

  // Finalise: move uncommitted chips back to the balance and mark the seat left.
  // We KEEP the row (not delete) so the current hand's pot accounting stays intact;
  // status 'left' excludes them from the next deal.
  const finishLeave = async () => {
    if (game.stake_type === "chips" && cashOut > 0) await adjustChips(admin, userId, cashOut);
    await admin.from("game_players").update({ status: "left", stack: 0 })
      .eq("game_id", game.id).eq("player_id", userId);
  };

  // All-in and still contesting the pot: can't bail on chips already committed.
  if (me.in_hand && !me.has_folded && me.is_all_in) {
    return json({ error: "You're all-in — you can leave once the hand finishes." }, 409);
  }

  // Already out of the hand (folded or sitting out): nothing to resolve.
  if (!me.in_hand || me.has_folded) {
    await finishLeave();
    return json({ left: true, cashed_out: cashOut });
  }

  // It's your turn: a fold, resolved through the shared engine (advances the
  // street, runs out an all-in, or ends the hand as needed).
  if (game.current_seat === me.seat) {
    me.stack = 0;
    const r = await applyAndResolve(admin, game, players, me, "fold", 0);
    if (r.error) return json({ error: r.error }, r.code ?? 409);
    await finishLeave();
    return json({ left: true, cashed_out: cashOut, folded: true, hand_finished: r.hand_over ?? false });
  }

  // Not your turn: fold them out. The hand ends only if they were the last live
  // opponent; otherwise play simply continues without them.
  me.has_folded = true; me.has_acted = true; me.stack = 0;
  const live = players.filter((p) => p.in_hand && !p.has_folded);

  if (live.length === 1) {
    const w = live[0];
    w.stack += game.pot;
    const claimed = await claimGame(admin, game.id, game.version, {
      status: "active", street: "idle", current_seat: null, current_bet: 0, min_raise: 0,
      last_aggressor_seat: null, pot: 0, winner_ids: [w.player_id], turn_deadline: null,
    });
    if (!claimed) return json({ error: "Table state changed, try again" }, 409);
    await admin.from("game_players").update({ stack: w.stack }).eq("game_id", game.id).eq("player_id", w.player_id);
    await admin.from("game_players").update({ has_folded: true }).eq("game_id", game.id).eq("player_id", userId);
    await admin.from("actions").insert({
      game_id: game.id, hand_no: game.hand_no, player_id: w.player_id, seat: w.seat,
      street: game.street, action: "win", amount: game.pot,
    });
    await finishLeave();
    return json({ left: true, cashed_out: cashOut, hand_finished: true });
  }

  // Hand continues without them. Bump version (CAS) to invalidate any racing act.
  const claimed = await claimGame(admin, game.id, game.version, {});
  if (!claimed) return json({ error: "Table state changed, try again" }, 409);
  await admin.from("game_players").update({ has_folded: true, has_acted: true })
    .eq("game_id", game.id).eq("player_id", userId);
  await finishLeave();
  return json({ left: true, cashed_out: cashOut });
});
