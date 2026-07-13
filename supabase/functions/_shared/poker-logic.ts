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
