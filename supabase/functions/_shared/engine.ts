// _shared/engine.ts
// Applies one player's action and, when the betting round closes, progresses the
// streets and resolves the showdown — persisting everything. Shared by `act`
// (a human's move) and `timeout-sweep` (an auto-check/fold for a player who ran
// out the clock), so both go through identical, server-authoritative logic.
import {
  claimGame, turnDeadline, nextToAct, nextSeat, roundClosed, notDone,
  nextStreet, boardCount, evaluate7, compareScore, buildSidePots, splitPot,
  type Game, type GamePlayer,
} from "./poker-logic.ts";
import { notifyTurn } from "./push.ts";

// deno-lint-ignore no-explicit-any
type Admin = any;

export interface ActResult {
  error?: string;
  code?: number;
  ok?: boolean;
  hand_over?: boolean;
  current_seat?: number | null;
  street?: string;
}

// `me` must already be validated as the current actor (act does this; the sweep
// picks the current_seat player). Mutates `players` in memory and writes back.
export async function applyAndResolve(
  admin: Admin, game: Game, players: GamePlayer[], me: GamePlayer, action: string, amount: number,
): Promise<ActResult> {
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
      if (toCall !== 0) return { error: "There's a bet to call — can't check", code: 409 };
      me.has_acted = true;
      break;
    case "call": {
      if (toCall <= 0) return { error: "Nothing to call — check instead", code: 409 };
      paid = Math.min(toCall, me.stack);
      me.stack -= paid; me.street_bet += paid; me.is_all_in = me.stack === 0; me.has_acted = true;
      break;
    }
    case "bet": {
      if (game.current_bet !== 0) return { error: "There's already a bet — raise instead", code: 409 };
      const max = me.street_bet + me.stack;
      const min = Math.min(game.big_blind, max);
      if (!Number.isInteger(amount) || amount < min || amount > max) {
        return { error: `Bet must be between ${min} and ${max}`, code: 409 };
      }
      paid = amount - me.street_bet;
      me.stack -= paid; me.street_bet = amount; me.is_all_in = me.stack === 0; me.has_acted = true;
      curBet = amount; minRaise = amount; aggressor = me.seat; reopened = true;
      break;
    }
    case "raise": {
      if (game.current_bet === 0) return { error: "Nothing to raise — bet instead", code: 409 };
      const max = me.street_bet + me.stack;
      const minTo = game.current_bet + game.min_raise;
      if (!Number.isInteger(amount) || amount > max) return { error: "Invalid raise amount", code: 409 };
      if (amount < minTo && amount !== max) return { error: `Raise must be to at least ${minTo}`, code: 409 };
      paid = amount - me.street_bet;
      me.stack -= paid; me.street_bet = amount; me.is_all_in = me.stack === 0; me.has_acted = true;
      minRaise = amount - game.current_bet; curBet = amount; aggressor = me.seat; reopened = true;
      break;
    }
    case "all_in": {
      paid = me.stack;
      if (paid <= 0) return { error: "No chips to move", code: 409 };
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
      return { error: "Unknown action", code: 400 };
  }

  let pot = game.pot + paid;

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
  const payout: Record<number, number> = {};
  let winnerSeats: number[] = [];
  let gamePatch: Record<string, unknown>;

  if (!roundClosed(players, curBet)) {
    const seatToAct = nextToAct(players, me.seat, curBet);
    gamePatch = {
      current_bet: curBet, min_raise: minRaise, last_aggressor_seat: aggressor,
      pot, current_seat: seatToAct, turn_deadline: turnDeadline(game.mode),
    };
    const claimed = await claimGame(admin, game.id, game.version, gamePatch);
    if (!claimed) return { error: "Table state changed, try again", code: 409 };
    await persistPlayers(admin, game.id, players);
    await admin.from("actions").insert(myActionRow);
    // @ts-ignore EdgeRuntime provided by the Supabase runtime
    EdgeRuntime.waitUntil(notifyTurn(admin, game, players, seatToAct));
    return { ok: true, current_seat: seatToAct };
  }

  // --- Round closed: progress streets / resolve the hand. ---
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
      winnerSeats = [live[0].seat];
      payout[live[0].seat] = pot;
      handOver = true;
      break;
    }
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
      waitSeat = nextSeat(players, game.button_seat!, (p) => notDone(p));
      break;
    }
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
  if (!claimed) return { error: "Table state changed, try again", code: 409 };

  await persistPlayers(admin, game.id, players);
  await admin.from("actions").insert([myActionRow, ...extraActions]);
  if (showdownRows.length) await admin.from("showdowns").insert(showdownRows);

  if (!handOver && waitSeat !== null) {
    // @ts-ignore EdgeRuntime provided by the Supabase runtime
    EdgeRuntime.waitUntil(notifyTurn(admin, game, players, waitSeat));
  }

  return { ok: true, hand_over: handOver, street: gamePatch.street as string };

  async function resolveShowdown() {
    const revealSeats = players.filter((p) => p.in_hand && !p.has_folded).map((p) => p.seat);

    const { data: holeRows } = await admin.from("hole_cards")
      .select("player_id, cards").eq("game_id", game.id).eq("hand_no", game.hand_no);
    const holeBySeat: Record<number, number[]> = {};
    for (const p of players) {
      const row = (holeRows ?? []).find((h: { player_id: string }) => h.player_id === p.player_id);
      if (row) holeBySeat[p.seat] = row.cards;
    }

    const { data: actRows } = await admin.from("actions")
      .select("seat, amount, action").eq("game_id", game.id).eq("hand_no", game.hand_no);
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
      const split = splitPot(p.amount, winners, game.button_seat!);
      for (const [seat, amt] of Object.entries(split)) payout[Number(seat)] = (payout[Number(seat)] ?? 0) + amt;
      for (const w of winners) if (!winnerSeats.includes(w)) winnerSeats.push(w);
    }

    for (const s of revealSeats) {
      const p = players.find((x) => x.seat === s)!;
      showdownRows.push({
        game_id: game.id, hand_no: game.hand_no, player_id: p.player_id,
        cards: holeBySeat[s] ?? [], hand_rank: evalBySeat[s]?.name ?? null, won: payout[s] ?? 0,
      });
    }
  }
}

async function persistPlayers(admin: Admin, gameId: string, players: GamePlayer[]) {
  for (const p of players) {
    await admin.from("game_players").update({
      stack: p.stack, street_bet: p.street_bet, has_acted: p.has_acted,
      has_folded: p.has_folded, is_all_in: p.is_all_in, in_hand: p.in_hand,
    }).eq("game_id", gameId).eq("player_id", p.player_id);
  }
}
