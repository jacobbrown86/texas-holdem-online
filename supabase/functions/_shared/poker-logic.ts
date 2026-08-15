// _shared/poker-logic.ts
// Single source of truth for the poker rules engine + the request plumbing every
// Edge Function shares (ported from Snake Eyes' game-logic.ts).
//
// What lives here:
//   * Request plumbing: corsHeaders, json, getCtx, claimGame, loadGame,
//     inviteCode, adjustChips  (identical patterns to Snake Eyes).
//   * Card encoding + a crypto-grade shuffled deck (used by start-hand, Phase 3).
//   * Types shared across functions.
//
// Still to come (Phase 3+): the betting engine (legal actions, min-raise, all-in),
// the 7-card hand evaluator, side-pot splitting, and blind/button rotation. They
// belong HERE, nowhere else — clients only ever render outcomes.

import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2";

/* ---------------- types ---------------- */
export interface Game {
  id: string;
  invite_code: string;
  status: "lobby" | "active" | "finished" | "abandoned";
  mode: "live" | "async";
  stake_type: "chips" | "ledger" | "none";
  small_blind: number;
  big_blind: number;
  buy_in: number;
  hand_no: number;
  button_seat: number | null;
  street: "idle" | "preflop" | "flop" | "turn" | "river" | "showdown";
  board: number[];
  current_seat: number | null;
  current_bet: number;
  min_raise: number;
  last_aggressor_seat: number | null;
  pot: number;
  turn_deadline: string | null;
  version: number;
  created_by: string;
  winner_ids: string[] | null;
}

export interface GamePlayer {
  game_id: string;
  player_id: string;
  seat: number;
  stack: number;
  total_bet: number;
  status: "seated" | "sitting_out" | "left";
  in_hand: boolean;
  has_folded: boolean;
  street_bet: number;
  has_acted: boolean;
  is_all_in: boolean;
}

/* ---------------- card encoding ----------------
 * A card is 0..51.  rank = card % 13  (0 = 2, 8 = 10, 9 = J, 10 = Q, 11 = K, 12 = A)
 *                   suit = floor(card / 13)  (0♣ 1♦ 2♥ 3♠)
 */
export const RANKS = ["2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A"];
export const SUITS = ["♣", "♦", "♥", "♠"];

export const rankOf = (card: number): number => card % 13;
export const suitOf = (card: number): number => Math.floor(card / 13);
export const cardName = (card: number): string => `${RANKS[rankOf(card)]}${SUITS[suitOf(card)]}`;

// A fresh 52-card deck shuffled with a crypto-grade Fisher–Yates. No modulo bias:
// each swap index is drawn by rejection sampling. Server-only — the deck order is
// never sent to clients; only the specific cards each player/board needs.
export function shuffledDeck(): number[] {
  const deck = Array.from({ length: 52 }, (_, i) => i);
  for (let i = deck.length - 1; i > 0; i--) {
    const j = randInt(i + 1);
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

// Uniform random integer in [0, n) via rejection sampling on crypto bytes.
export function randInt(n: number): number {
  if (n <= 0) return 0;
  const max = Math.floor(256 / n) * n; // largest multiple of n below 256
  const buf = new Uint8Array(1);
  while (true) {
    crypto.getRandomValues(buf);
    if (buf[0] < max) return buf[0] % n;
  }
}

/* ---------------- request plumbing shared by every function ---------------- */
export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

export interface Ctx {
  admin: SupabaseClient;
  userId: string;
}

// Authenticates the caller and returns a service-role client for mutations.
export async function getCtx(req: Request): Promise<Ctx | Response> {
  const url = Deno.env.get("SUPABASE_URL")!;
  // Prefer the new API keys (set as function secrets); fall back to the legacy
  // injected keys so nothing breaks until the legacy keys are revoked.
  const anon = Deno.env.get("SB_PUBLISHABLE_KEY") ?? Deno.env.get("SUPABASE_ANON_KEY")!;
  const service = Deno.env.get("SB_SECRET_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return json({ error: "Missing auth header" }, 401);

  const userClient = createClient(url, anon, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: { user }, error } = await userClient.auth.getUser();
  if (error || !user) return json({ error: "Unauthorized" }, 401);

  return { admin: createClient(url, service), userId: user.id };
}

// Optimistic concurrency: claim the game by bumping version.
// Exactly one concurrent request wins; losers get false and should return 409.
export async function claimGame(
  admin: SupabaseClient,
  gameId: string,
  expectedVersion: number,
  patch: Record<string, unknown>,
): Promise<boolean> {
  const { data, error } = await admin
    .from("games")
    .update({ ...patch, version: expectedVersion + 1 })
    .eq("id", gameId)
    .eq("version", expectedVersion)
    .select("id");
  if (error) throw error;
  return (data?.length ?? 0) === 1;
}

// Load game + players in one shot.
export async function loadGame(admin: SupabaseClient, gameId: string): Promise<{
  game: Game | null;
  players: GamePlayer[];
}> {
  const { data: game } = await admin.from("games").select("*").eq("id", gameId).single();
  const { data: players } = await admin
    .from("game_players").select("*").eq("game_id", gameId);
  return { game: game as Game | null, players: (players ?? []) as GamePlayer[] };
}

export async function adjustChips(admin: SupabaseClient, playerId: string, delta: number) {
  // Small helper; service role bypasses RLS. Reads then writes — fine at this
  // scale because all chip changes flow through version-gated game actions.
  const { data } = await admin.from("profiles").select("chips").eq("id", playerId).single();
  if (data) {
    await admin.from("profiles").update({ chips: data.chips + delta }).eq("id", playerId);
  }
}

export function inviteCode(): string {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no confusable 0/O/1/I/L
  const buf = new Uint8Array(6);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => chars[b % chars.length]).join("");
}

/* ============================================================
 * The betting engine + hand evaluator. Pure functions — no IO — so the exact
 * same rules can (later) run client-side for in-person/vs-computer modes.
 * The Edge Functions (start-hand, act) load state, call these, and persist.
 * ============================================================ */

// Seats of players still in the hand, ascending.
export function handSeats(players: GamePlayer[]): number[] {
  return players.filter((p) => p.in_hand).map((p) => p.seat).sort((a, b) => a - b);
}

// The next in-hand seat clockwise (increasing, wrapping) after `fromSeat` that
// satisfies `pred`. `fromSeat` itself is only considered last. null if none.
export function nextSeat(
  players: GamePlayer[],
  fromSeat: number,
  pred: (p: GamePlayer) => boolean,
): number | null {
  const seats = handSeats(players);
  if (!seats.length) return null;
  const after = seats.filter((s) => s > fromSeat);
  const wrap = seats.filter((s) => s <= fromSeat);
  for (const s of [...after, ...wrap]) {
    const p = players.find((x) => x.seat === s)!;
    if (pred(p)) return s;
  }
  return null;
}

export const notDone = (p: GamePlayer) => !p.has_folded && !p.is_all_in;

// Whose action is it after `fromSeat`? First player who still needs to act:
// not folded, not all-in, and either hasn't acted or is short of the current bet.
export function nextToAct(players: GamePlayer[], fromSeat: number, currentBet: number): number | null {
  return nextSeat(players, fromSeat, (p) => notDone(p) && (!p.has_acted || p.street_bet < currentBet));
}

// A betting round is closed when nobody still needs to act.
export function roundClosed(players: GamePlayer[], currentBet: number): boolean {
  return !players.some((p) => p.in_hand && notDone(p) && (!p.has_acted || p.street_bet < currentBet));
}

export function turnDeadline(mode: "live" | "async"): string {
  const ms = mode === "live" ? 60_000 : 48 * 3600_000;
  return new Date(Date.now() + ms).toISOString();
}

export const STREET_ORDER = ["preflop", "flop", "turn", "river", "showdown"] as const;
export function nextStreet(s: string): string {
  const i = STREET_ORDER.indexOf(s as typeof STREET_ORDER[number]);
  return STREET_ORDER[Math.min(i + 1, STREET_ORDER.length - 1)];
}
// How many community cards are shown on a given street.
export function boardCount(street: string): number {
  return street === "flop" ? 3 : street === "turn" ? 4 : street === "river" || street === "showdown" ? 5 : 0;
}

/* ---------------- 7-card hand evaluator ----------------
 * Returns a comparable score array [category, ...tiebreakers] (bigger = better)
 * plus a human-readable name. Categories: 0 high card … 8 straight flush.
 * Evaluates the best 5 of 7 by trying all 21 five-card subsets (cheap + safe).
 */
const CATEGORY_NAMES = [
  "High card", "Pair", "Two pair", "Three of a kind", "Straight",
  "Flush", "Full house", "Four of a kind", "Straight flush",
];

// rankValue: 2..14 (A high). card%13: 0->2 … 12->A(14).
const rankVal = (card: number): number => (card % 13) + 2;

function score5(cards: number[]): number[] {
  const rv = cards.map(rankVal).sort((a, b) => b - a);        // desc
  const suits = cards.map((c) => Math.floor(c / 13));
  const isFlush = suits.every((s) => s === suits[0]);

  const uniq = [...new Set(rv)].sort((a, b) => b - a);
  let straightHigh = 0;
  if (uniq.length === 5) {
    if (uniq[0] - uniq[4] === 4) straightHigh = uniq[0];
    // wheel: A-2-3-4-5 (ace plays low)
    else if (uniq[0] === 14 && uniq[1] === 5 && uniq[2] === 4 && uniq[3] === 3 && uniq[4] === 2) straightHigh = 5;
  }

  const cnt: Record<number, number> = {};
  for (const r of rv) cnt[r] = (cnt[r] ?? 0) + 1;
  // groups sorted by count desc, then rank desc
  const groups = Object.entries(cnt)
    .map(([r, c]) => [c, Number(r)] as [number, number])
    .sort((a, b) => b[0] - a[0] || b[1] - a[1]);
  const counts = groups.map((g) => g[0]);
  const ranksByCount = groups.map((g) => g[1]);
  const isStraight = straightHigh > 0;

  if (isStraight && isFlush) return [8, straightHigh];
  if (counts[0] === 4) return [7, ranksByCount[0], ranksByCount[1]];
  if (counts[0] === 3 && counts[1] === 2) return [6, ranksByCount[0], ranksByCount[1]];
  if (isFlush) return [5, ...rv];
  if (isStraight) return [4, straightHigh];
  if (counts[0] === 3) return [3, ...ranksByCount];
  if (counts[0] === 2 && counts[1] === 2) return [2, ranksByCount[0], ranksByCount[1], ranksByCount[2]];
  if (counts[0] === 2) return [1, ...ranksByCount];
  return [0, ...rv];
}

export function compareScore(a: number[], b: number[]): number {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d; // >0 => a wins
  }
  return 0;
}

export interface HandResult { score: number[]; name: string }

export function evaluate7(cards: number[]): HandResult {
  let best: number[] | null = null;
  // choose 5 of 7 == drop 2 of 7
  for (let i = 0; i < cards.length; i++) {
    for (let j = i + 1; j < cards.length; j++) {
      const five = cards.filter((_, k) => k !== i && k !== j);
      const s = score5(five);
      if (!best || compareScore(s, best) > 0) best = s;
    }
  }
  const score = best ?? [0];
  return { score, name: CATEGORY_NAMES[score[0]] };
}

/* ---------------- side pots ----------------
 * contribs: every player who put chips in this hand, with how much and whether
 * they folded. Returns pots from main to last side pot; each pot lists the seats
 * eligible to win it (non-folded contributors at that level).
 */
export interface Contribution { seat: number; amount: number; folded: boolean }
export interface Pot { amount: number; eligible: number[] }

export function buildSidePots(contribs: Contribution[]): Pot[] {
  const pots: Pot[] = [];
  let remaining = contribs.filter((c) => c.amount > 0).map((c) => ({ ...c }));
  while (remaining.length) {
    const min = Math.min(...remaining.map((c) => c.amount));
    const amount = min * remaining.length;
    const eligible = remaining.filter((c) => !c.folded).map((c) => c.seat).sort((a, b) => a - b);
    // Merge into the previous pot if the eligible set is identical (cleaner display).
    const prev = pots[pots.length - 1];
    if (prev && prev.eligible.length === eligible.length && prev.eligible.every((s, i) => s === eligible[i])) {
      prev.amount += amount;
    } else if (eligible.length) {
      pots.push({ amount, eligible });
    } else if (prev) {
      prev.amount += amount; // dead chips (all folded at this level) roll forward
    }
    remaining = remaining.map((c) => ({ ...c, amount: c.amount - min })).filter((c) => c.amount > 0);
  }
  return pots;
}

// Split a pot among winners; odd chips go to the earliest seat left of the button.
export function splitPot(amount: number, winnerSeats: number[], buttonSeat: number): Record<number, number> {
  const out: Record<number, number> = {};
  const n = winnerSeats.length;
  if (!n) return out;
  const share = Math.floor(amount / n);
  let odd = amount - share * n;
  // order winners by seat distance clockwise from the button (earliest first)
  const ordered = [...winnerSeats].sort((a, b) => seatDistance(buttonSeat, a) - seatDistance(buttonSeat, b));
  for (const s of ordered) {
    out[s] = share + (odd > 0 ? 1 : 0);
    if (odd > 0) odd--;
  }
  return out;
}

function seatDistance(fromSeat: number, seat: number): number {
  // clockwise distance 1..10 (seat just left of button = 1)
  return ((seat - fromSeat + 10 - 1) % 10) + 1;
}

// Card name helpers for hand descriptions ("A♠ K♦").
export function cardsName(cards: number[]): string {
  return cards.map(cardName).join(" ");
}
