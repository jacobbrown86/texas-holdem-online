// supabase/functions/start-hand/index.ts
// Deals a new hand: rotate the button, post blinds, shuffle + deal 2 PRIVATE
// hole cards to each player, pre-deal the 5 community cards into the private
// hand_state table, and open preflop betting. Host-only.
import {
  getCtx, json, corsHeaders, loadGame, claimGame, shuffledDeck, turnDeadline,
  nextSeat, type GamePlayer,
} from "../_shared/poker-logic.ts";
import { notifyTurn } from "../_shared/push.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const ctx = await getCtx(req);
  if (ctx instanceof Response) return ctx;
  const { admin, userId } = ctx;

  const { game_id } = await req.json().catch(() => ({}));
  if (!game_id) return json({ error: "game_id required" }, 400);

  const { game, players } = await loadGame(admin, game_id);
  if (!game) return json({ error: "Table not found" }, 404);
  if (game.created_by !== userId) return json({ error: "Only the host can deal" }, 403);
  if (game.status !== "lobby" && game.status !== "active") {
    return json({ error: "Table isn't ready to deal" }, 409);
  }
  if (game.street && game.street !== "idle") {
    return json({ error: "A hand is already in progress" }, 409);
  }

  // Participants: seated players with chips to post.
  const participants = players
    .filter((p) => p.status === "seated" && p.stack > 0)
    .sort((a, b) => a.seat - b.seat);
  if (participants.length < 2) return json({ error: "Need at least 2 players with chips" }, 409);

  // Mark who's in this hand so the seat helpers operate on the right set.
  const inHand: GamePlayer[] = participants.map((p) => ({
    ...p, in_hand: true, has_folded: false, street_bet: 0, has_acted: false, is_all_in: false,
  }));

  // Button: first hand picks the lowest participant seat; otherwise move one left.
  const buttonSeat = game.button_seat == null
    ? inHand[0].seat
    : (nextSeat(inHand, game.button_seat, () => true) ?? inHand[0].seat);

  const heads = inHand.length === 2;
  const sbSeat = heads ? buttonSeat : nextSeat(inHand, buttonSeat, () => true)!;
  const bbSeat = nextSeat(inHand, sbSeat, () => true)!;
  // First to act preflop: heads-up it's the button (SB); otherwise left of the BB.
  const utgSeat = heads ? buttonSeat : nextSeat(inHand, bbSeat, () => true)!;

  const post = (seat: number, blind: number) => {
    const p = inHand.find((x) => x.seat === seat)!;
    const pay = Math.min(blind, p.stack);
    p.stack -= pay;
    p.street_bet = pay;
    p.is_all_in = p.stack === 0;
  };
  post(sbSeat, game.small_blind);
  post(bbSeat, game.big_blind);

  const currentBet = Math.max(...inHand.map((p) => p.street_bet));
  const pot = inHand.reduce((s, p) => s + p.street_bet, 0);

  // Shuffle, deal 2 hole cards each (seat order), next 5 = the community board.
  const deck = shuffledDeck();
  let k = 0;
  const holes: Record<number, number[]> = {};
  for (const p of [...inHand].sort((a, b) => a.seat - b.seat)) {
    holes[p.seat] = [deck[k++], deck[k++]];
  }
  const board = [deck[k++], deck[k++], deck[k++], deck[k++], deck[k++]];

  const handNo = game.hand_no + 1;

  // Claim the game via CAS, moving it into the live hand.
  const claimed = await claimGame(admin, game.id, game.version, {
    status: "active",
    hand_no: handNo,
    button_seat: buttonSeat,
    street: "preflop",
    board: [],
    current_seat: utgSeat,
    current_bet: currentBet,
    min_raise: game.big_blind,
    last_aggressor_seat: bbSeat,
    pot,
    turn_deadline: turnDeadline(game.mode),
    winner_ids: null,
  });
  if (!claimed) return json({ error: "Table state changed, try again" }, 409);

  // Persist per-hand player state.
  for (const p of inHand) {
    await admin.from("game_players").update({
      in_hand: true, has_folded: false, has_acted: false, is_all_in: p.is_all_in,
      street_bet: p.street_bet, stack: p.stack,
    }).eq("game_id", game.id).eq("player_id", p.player_id);
  }
  // Players not dealt in (sitting out / broke) sit out this hand.
  for (const p of players) {
    if (!inHand.some((h) => h.player_id === p.player_id)) {
      await admin.from("game_players").update({
        in_hand: false, has_folded: false, has_acted: false, is_all_in: false, street_bet: 0,
      }).eq("game_id", game.id).eq("player_id", p.player_id);
    }
  }

  // Private hole cards (RLS: each player reads only their own) + hidden board.
  await admin.from("hole_cards").insert(
    inHand.map((p) => ({ game_id: game.id, player_id: p.player_id, hand_no: handNo, cards: holes[p.seat] })),
  );
  await admin.from("hand_state").insert({ game_id: game.id, hand_no: handNo, board });

  // Action feed.
  const sbP = inHand.find((p) => p.seat === sbSeat)!;
  const bbP = inHand.find((p) => p.seat === bbSeat)!;
  await admin.from("actions").insert([
    { game_id: game.id, hand_no: handNo, seat: null, street: "preflop", action: "deal", amount: 0 },
    { game_id: game.id, hand_no: handNo, player_id: sbP.player_id, seat: sbSeat, street: "preflop", action: "post_sb", amount: sbP.street_bet },
    { game_id: game.id, hand_no: handNo, player_id: bbP.player_id, seat: bbSeat, street: "preflop", action: "post_bb", amount: bbP.street_bet },
  ]);

  // Nudge the player who's up.
  // @ts-ignore EdgeRuntime provided by the Supabase runtime
  EdgeRuntime.waitUntil(notifyTurn(admin, game, inHand, utgSeat));

  return json({ hand_no: handNo, current_seat: utgSeat });
});
