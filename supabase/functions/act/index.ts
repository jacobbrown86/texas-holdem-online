// supabase/functions/act/index.ts
// The referee. Validates the caller's action, applies it, and — when the betting
// round closes — progresses the streets and resolves the showdown entirely
// server-side, so clients only ever render outcomes. Never trusts the client.
import {
  getCtx, json, corsHeaders, loadGame, claimGame, turnDeadline,
  nextToAct, nextSeat, roundClosed, notDone, nextStreet, boardCount,
  evaluate7, compareScore, buildSidePots, splitPot,
  type GamePlayer,
} from "../_shared/poker-logic.ts";
import { notifyTurn } from "../_shared/push.ts";

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

  const toCall = game.current_bet - me.street_bet;
  let paid = 0;
  let reopened = false;
  let curBet = game.current_bet;
  let minRaise = game.min_raise;
  let aggressor = game.last_aggressor_seat;

  switch (action) {
    case "fold":
      me.has_folded = true; me.has_acted = true;
      break;
    case "check":
      if (toCall !== 0) return json({ error: "There's a bet to call — can't check" }, 409);
      me.has_acted = true;
      break;
    case "call": {
      if (toCall <= 0) return json({ error: "Nothing to call — check instead" }, 409);
      paid = Math.min(toCall, me.stack);
      me.stack -= paid; me.street_bet += paid; me.is_all_in = me.stack === 0; me.has_acted = true;
      break;
    }
    case "bet": {
      if (game.current_bet !== 0) return json({ error: "There's already a bet — raise instead" }, 409);
      const max = me.street_bet + me.stack;
      const min = Math.min(game.big_blind, max);
      if (!Number.isInteger(amount) || amount < min || amount > max) {
        return json({ error: `Bet must be between ${min} and ${max}` }, 409);
      }
      paid = amount - me.street_bet;
      me.stack -= paid; me.street_bet = amount; me.is_all_in = me.stack === 0; me.has_acted = true;
      curBet = amount; minRaise = amount; aggressor = me.seat; reopened = true;
      break;
    }
    case "raise": {
      if (game.current_bet === 0) return json({ error: "Nothing to raise — bet instead" }, 409);
      const max = me.street_bet + me.stack;
      const minTo = game.current_bet + game.min_raise;
      if (!Number.isInteger(amount) || amount > max) return json({ error: "Invalid raise amount" }, 409);
      // Must be a full min-raise, unless it's an all-in shove for everything you have.
      if (amount < minTo && amount !== max) return json({ error: `Raise must be to at least ${minTo}` }, 409);
      paid = amount - me.street_bet;
      me.stack -= paid; me.street_bet = amount; me.is_all_in = me.stack === 0; me.has_acted = true;
      minRaise = amount - game.current_bet; curBet = amount; aggressor = me.seat; reopened = true;
      break;
    }
    case "all_in": {
      paid = me.stack;
      if (paid <= 0) return json({ error: "No chips to move" }, 409);
      const newBet = me.street_bet + paid;
      me.stack = 0; me.street_bet = newBet; me.is_all_in = true; me.has_acted = true;
      if (newBet > game.current_bet) {
        const inc = newBet - game.current_bet;
        curBet = newBet;
        if (inc >= game.min_raise) { minRaise = inc; aggressor = me.seat; reopened = true; }
      }
      break;
    }
    default:
      return json({ error: "Unknown action" }, 400);
  }

  let pot = game.pot + paid;

  // A full bet/raise reopens the round: everyone still live must act again.
  if (reopened) {
    for (const p of players) {
      if (p.in_hand && notDone(p) && p.seat !== me.seat) p.has_acted = false;
    }
  }

  const myActionRow = {
    game_id: game.id, hand_no: game.hand_no, player_id: me.player_id,
    seat: me.seat, street: game.street, action, amount: paid,
  };
  const extraActions: Record<string, unknown>[] = [];
  const showdownRows: Record<string, unknown>[] = [];
  const payout: Record<number, number> = {};      // seat -> chips won
  let winnerSeats: number[] = [];

  let gamePatch: Record<string, unknown>;

  if (!roundClosed(players, curBet)) {
    // Round continues — pass action to the next player.
    const seatToAct = nextToAct(players, me.seat, curBet);
    gamePatch = {
      current_bet: curBet, min_raise: minRaise, last_aggressor_seat: aggressor,
      pot, current_seat: seatToAct, turn_deadline: turnDeadline(game.mode),
    };
    const claimed = await claimGame(admin, game.id, game.version, gamePatch);
    if (!claimed) return json({ error: "Table state changed, try again" }, 409);
    await persistPlayers(admin, game.id, players);
    await admin.from("actions").insert(myActionRow);
    // @ts-ignore EdgeRuntime provided by the Supabase runtime
    EdgeRuntime.waitUntil(notifyTurn(admin, game, players, seatToAct));
    return json({ ok: true, current_seat: seatToAct });
  }

  // --- Round closed: progress streets / resolve the hand server-side. ---
  const { data: hs } = await admin.from("hand_state")
    .select("board").eq("game_id", game.id).eq("hand_no", game.hand_no).single();
  const fullBoard: number[] = hs?.board ?? [];

  let street = game.street;
  let board = game.board;
  let waitSeat: number | null = null;
  let handOver = false;

  while (true) {
    const live = players.filter((p) => p.in_hand && !p.has_folded);
    if (live.length === 1) {
      // Everyone else folded — uncontested pot, no cards revealed.
      winnerSeats = [live[0].seat];
      payout[live[0].seat] = pot;
      handOver = true;
      break;
    }
    // Close the street: its bets are already in the pot. Reset for the next one.
    for (const p of players) { if (p.in_hand) { p.street_bet = 0; p.has_acted = false; } }
    curBet = 0;

    const ns = nextStreet(street);
    if (ns === "showdown") {
      street = "showdown";
      board = fullBoard.slice(0, 5);
      await resolveShowdown();
      handOver = true;
      break;
    }
    street = ns;
    board = fullBoard.slice(0, boardCount(street));

    const canAct = live.filter((p) => !p.is_all_in);
    if (canAct.length >= 2) {
      // Betting happens on this street — first to act is left of the button.
      waitSeat = nextSeat(players, game.button_seat!, (p) => notDone(p));
      break;
    }
    // Fewer than two can act (all-in situation) → deal the next street too.
  }

  if (handOver) {
    for (const [seat, amt] of Object.entries(payout)) {
      const p = players.find((x) => x.seat === Number(seat));
      if (p) p.stack += amt;
    }
    for (const s of winnerSeats) {
      const p = players.find((x) => x.seat === s);
      if (p) extraActions.push({
        game_id: game.id, hand_no: game.hand_no, player_id: p.player_id,
        seat: s, street, action: "win", amount: payout[s] ?? 0,
      });
    }
    const winnerIds = winnerSeats
      .map((s) => players.find((p) => p.seat === s)?.player_id)
      .filter(Boolean);
    gamePatch = {
      status: "active", street: "idle", current_seat: null, current_bet: 0, min_raise: 0,
      last_aggressor_seat: null, board, pot: 0, winner_ids: winnerIds, turn_deadline: null,
    };
  } else {
    gamePatch = {
      street, board, current_bet: 0, min_raise: game.big_blind, last_aggressor_seat: null,
      pot, current_seat: waitSeat, turn_deadline: turnDeadline(game.mode),
    };
  }

  const claimed = await claimGame(admin, game.id, game.version, gamePatch);
  if (!claimed) return json({ error: "Table state changed, try again" }, 409);

  await persistPlayers(admin, game.id, players);
  await admin.from("actions").insert([myActionRow, ...extraActions]);
  if (showdownRows.length) await admin.from("showdowns").insert(showdownRows);

  if (!handOver && waitSeat !== null) {
    // @ts-ignore EdgeRuntime provided by the Supabase runtime
    EdgeRuntime.waitUntil(notifyTurn(admin, game, players, waitSeat));
  }

  return json({ ok: true, hand_over: handOver, street: gamePatch.street });

  /* ---- showdown: evaluate hands, split side pots, reveal ---- */
  async function resolveShowdown() {
    const revealSeats = players.filter((p) => p.in_hand && !p.has_folded).map((p) => p.seat);

    const { data: holeRows } = await admin.from("hole_cards")
      .select("player_id, cards").eq("game_id", game!.id).eq("hand_no", game!.hand_no);
    const holeBySeat: Record<number, number[]> = {};
    for (const p of players) {
      const row = (holeRows ?? []).find((h) => h.player_id === p.player_id);
      if (row) holeBySeat[p.seat] = row.cards;
    }

    // Total each player put in this hand = sum of their logged action amounts,
    // plus the current (not-yet-inserted) action.
    const { data: actRows } = await admin.from("actions")
      .select("seat, amount, action").eq("game_id", game!.id).eq("hand_no", game!.hand_no);
    const contribSum: Record<number, number> = {};
    const COUNTS = ["post_sb", "post_bb", "call", "bet", "raise", "all_in"];
    for (const r of actRows ?? []) {
      if (r.seat != null && COUNTS.includes(r.action)) contribSum[r.seat] = (contribSum[r.seat] ?? 0) + r.amount;
    }
    if (me.seat != null && paid > 0) contribSum[me.seat] = (contribSum[me.seat] ?? 0) + paid;

    const contribs = players
      .filter((p) => p.in_hand)
      .map((p) => ({ seat: p.seat, amount: contribSum[p.seat] ?? 0, folded: p.has_folded }));
    const pots = buildSidePots(contribs);

    const evalBySeat: Record<number, { score: number[]; name: string }> = {};
    for (const s of revealSeats) {
      evalBySeat[s] = evaluate7([...(holeBySeat[s] ?? []), ...fullBoard]);
    }

    for (const p of pots) {
      const contenders = p.eligible.filter((s) => revealSeats.includes(s));
      if (!contenders.length) continue;
      let best: number[] | null = null;
      let winners: number[] = [];
      for (const s of contenders) {
        const sc = evalBySeat[s].score;
        if (!best || compareScore(sc, best) > 0) { best = sc; winners = [s]; }
        else if (compareScore(sc, best) === 0) winners.push(s);
      }
      const split = splitPot(p.amount, winners, game!.button_seat!);
      for (const [seat, amt] of Object.entries(split)) payout[Number(seat)] = (payout[Number(seat)] ?? 0) + amt;
      for (const w of winners) if (!winnerSeats.includes(w)) winnerSeats.push(w);
    }

    for (const s of revealSeats) {
      const p = players.find((x) => x.seat === s)!;
      showdownRows.push({
        game_id: game!.id, hand_no: game!.hand_no, player_id: p.player_id,
        cards: holeBySeat[s] ?? [], hand_rank: evalBySeat[s]?.name ?? null, won: payout[s] ?? 0,
      });
    }
  }
});

// Write back the per-hand mutable state for every player at the table.
async function persistPlayers(admin: any, gameId: string, players: GamePlayer[]) {
  for (const p of players) {
    await admin.from("game_players").update({
      stack: p.stack, street_bet: p.street_bet, has_acted: p.has_acted,
      has_folded: p.has_folded, is_all_in: p.is_all_in, in_hand: p.in_hand,
    }).eq("game_id", gameId).eq("player_id", p.player_id);
  }
}
