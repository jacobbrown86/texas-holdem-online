// Client-side poker engine for the local modes (vs-computer, in-person).
// This is the SAME ruleset as the server (_shared/poker-logic.ts + engine.ts),
// ported to synchronous JS. Online play still goes through the server; these
// modes run entirely on the device. The pure evaluator/side-pot math here is the
// same logic covered by the server's unit tests.
import { rankOf, suitOf } from "./cards.js";

/* ---------------- hand evaluation ---------------- */
const CATEGORY_NAMES = [
  "High card", "Pair", "Two pair", "Three of a kind", "Straight",
  "Flush", "Full house", "Four of a kind", "Straight flush",
];
const rankVal = (card) => (card % 13) + 2;

function score5(cards) {
  const rv = cards.map(rankVal).sort((a, b) => b - a);
  const suits = cards.map((c) => Math.floor(c / 13));
  const isFlush = suits.every((s) => s === suits[0]);
  const uniq = [...new Set(rv)].sort((a, b) => b - a);
  let straightHigh = 0;
  if (uniq.length === 5) {
    if (uniq[0] - uniq[4] === 4) straightHigh = uniq[0];
    else if (uniq[0] === 14 && uniq[1] === 5 && uniq[2] === 4 && uniq[3] === 3 && uniq[4] === 2) straightHigh = 5;
  }
  const cnt = {};
  for (const r of rv) cnt[r] = (cnt[r] ?? 0) + 1;
  const groups = Object.entries(cnt).map(([r, c]) => [c, Number(r)]).sort((a, b) => b[0] - a[0] || b[1] - a[1]);
  const counts = groups.map((g) => g[0]);
  const byCount = groups.map((g) => g[1]);
  const isStraight = straightHigh > 0;
  if (isStraight && isFlush) return [8, straightHigh];
  if (counts[0] === 4) return [7, byCount[0], byCount[1]];
  if (counts[0] === 3 && counts[1] === 2) return [6, byCount[0], byCount[1]];
  if (isFlush) return [5, ...rv];
  if (isStraight) return [4, straightHigh];
  if (counts[0] === 3) return [3, ...byCount];
  if (counts[0] === 2 && counts[1] === 2) return [2, byCount[0], byCount[1], byCount[2]];
  if (counts[0] === 2) return [1, ...byCount];
  return [0, ...rv];
}

export function compareScore(a, b) {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) { const d = (a[i] ?? 0) - (b[i] ?? 0); if (d !== 0) return d; }
  return 0;
}

function combos(arr, k) {
  const out = [];
  const rec = (start, pick) => {
    if (pick.length === k) { out.push(pick.slice()); return; }
    for (let i = start; i < arr.length; i++) { pick.push(arr[i]); rec(i + 1, pick); pick.pop(); }
  };
  rec(0, []);
  return out;
}

// Best 5-card score from any 5..7 cards.
export function evaluateBest(cards) {
  if (cards.length < 5) return { score: [0], name: "—" };
  let best = null;
  for (const five of combos(cards, 5)) {
    const s = score5(five);
    if (!best || compareScore(s, best) > 0) best = s;
  }
  return { score: best, name: CATEGORY_NAMES[best[0]] };
}

/* ---------------- side pots ---------------- */
export function buildSidePots(contribs) {
  const pots = [];
  let rem = contribs.filter((c) => c.amount > 0).map((c) => ({ ...c }));
  while (rem.length) {
    const min = Math.min(...rem.map((c) => c.amount));
    const amount = min * rem.length;
    const eligible = rem.filter((c) => !c.folded).map((c) => c.seat).sort((a, b) => a - b);
    const prev = pots[pots.length - 1];
    if (prev && prev.eligible.length === eligible.length && prev.eligible.every((s, i) => s === eligible[i])) prev.amount += amount;
    else if (eligible.length) pots.push({ amount, eligible });
    else if (prev) prev.amount += amount;
    rem = rem.map((c) => ({ ...c, amount: c.amount - min })).filter((c) => c.amount > 0);
  }
  return pots;
}

const seatDistance = (from, seat) => ((seat - from + 10 - 1) % 10) + 1;
export function splitPot(amount, winnerSeats, buttonSeat) {
  const out = {}; const n = winnerSeats.length; if (!n) return out;
  const share = Math.floor(amount / n); let odd = amount - share * n;
  const ordered = [...winnerSeats].sort((a, b) => seatDistance(buttonSeat, a) - seatDistance(buttonSeat, b));
  for (const s of ordered) { out[s] = share + (odd > 0 ? 1 : 0); if (odd > 0) odd--; }
  return out;
}

/* ---------------- deck ---------------- */
function shuffledDeck() {
  const d = Array.from({ length: 52 }, (_, i) => i);
  for (let i = d.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}

/* ---------------- seat helpers ---------------- */
const inHandPlayers = (s) => s.players.filter((p) => p.inHand);
const notDone = (p) => !p.folded && !p.allIn;

function nextSeat(state, fromSeat, pred) {
  const seats = inHandPlayers(state).map((p) => p.seat).sort((a, b) => a - b);
  if (!seats.length) return null;
  const ordered = [...seats.filter((s) => s > fromSeat), ...seats.filter((s) => s <= fromSeat)];
  for (const s of ordered) {
    const p = state.players.find((x) => x.seat === s);
    if (pred(p)) return s;
  }
  return null;
}
const nextToAct = (state, fromSeat) =>
  nextSeat(state, fromSeat, (p) => notDone(p) && (!p.acted || p.streetBet < state.currentBet));
const roundClosed = (state) =>
  !state.players.some((p) => p.inHand && notDone(p) && (!p.acted || p.streetBet < state.currentBet));

const STREETS = ["preflop", "flop", "turn", "river", "showdown"];
const nextStreet = (s) => STREETS[Math.min(STREETS.indexOf(s) + 1, STREETS.length - 1)];
const boardCount = (s) => (s === "flop" ? 3 : s === "turn" ? 4 : s === "river" || s === "showdown" ? 5 : 0);

/* ---------------- game lifecycle ---------------- */
export function newLocalGame({ names, bigBlind = 10, buyIn = 1000, mode = "cpu" }) {
  const players = names.map((name, i) => ({
    id: `p${i}`, name, isBot: mode === "cpu" ? i > 0 : false, seat: i,
    stack: buyIn, inHand: false, folded: false, streetBet: 0, acted: false, allIn: false, hole: [],
    _hand: 0, _bought: buyIn, // per-hand contribution + lifetime buy-ins (for settlement)
  }));
  return {
    mode, handNo: 0, button: null,
    smallBlind: Math.max(1, Math.floor(bigBlind / 2)), bigBlind, buyIn,
    street: "idle", board: [], fullBoard: [],
    pot: 0, currentBet: 0, minRaise: 0, currentSeat: null, lastAggressor: null,
    players, winners: [], showdown: [], status: "active", message: "",
  };
}

const clone = (s) => ({ ...s, players: s.players.map((p) => ({ ...p, hole: [...p.hole] })), board: [...s.board], fullBoard: [...s.fullBoard], winners: [...s.winners], showdown: s.showdown.map((x) => ({ ...x })) });

export function startHand(prev) {
  const s = clone(prev);
  const parts = s.players.filter((p) => p.stack > 0).sort((a, b) => a.seat - b.seat);
  if (parts.length < 2) { s.status = "finished"; s.street = "idle"; return s; }

  for (const p of s.players) {
    p.inHand = p.stack > 0;
    p.folded = false; p.streetBet = 0; p.acted = false; p.allIn = false; p.hole = []; p._hand = 0;
  }
  s.button = s.button == null ? parts[0].seat : nextSeat(s, s.button, () => true);
  const heads = parts.length === 2;
  const sb = heads ? s.button : nextSeat(s, s.button, () => true);
  const bb = nextSeat(s, sb, () => true);
  const utg = heads ? s.button : nextSeat(s, bb, () => true);

  const post = (seat, blind) => {
    const p = s.players.find((x) => x.seat === seat);
    const pay = Math.min(blind, p.stack);
    p.stack -= pay; p.streetBet = pay; p._hand += pay; p.allIn = p.stack === 0;
  };
  post(sb, s.smallBlind);
  post(bb, s.bigBlind);

  const deck = shuffledDeck();
  let k = 0;
  for (const p of [...s.players].filter((p) => p.inHand).sort((a, b) => a.seat - b.seat)) p.hole = [deck[k++], deck[k++]];
  s.fullBoard = [deck[k++], deck[k++], deck[k++], deck[k++], deck[k++]];
  s.board = [];

  s.currentBet = Math.max(...s.players.filter((p) => p.inHand).map((p) => p.streetBet));
  s.pot = s.players.reduce((t, p) => t + p.streetBet, 0);
  s.minRaise = s.bigBlind;
  s.lastAggressor = bb;
  s.currentSeat = utg;
  s.street = "preflop";
  s.handNo += 1;
  s.winners = []; s.showdown = []; s.message = "";
  return s;
}

// Apply the current player's action. `action` in fold/check/call/bet/raise/all_in.
// `amount` is the raise/bet TO-value. Returns a new state.
export function applyAction(prev, action, amount) {
  const s = clone(prev);
  const me = s.players.find((p) => p.seat === s.currentSeat);
  if (!me) return s;
  const toCall = s.currentBet - me.streetBet;
  let paid = 0, reopened = false;

  if (action === "fold") { me.folded = true; me.acted = true; }
  else if (action === "check") { if (toCall !== 0) return s; me.acted = true; }
  else if (action === "call") {
    paid = Math.min(Math.max(0, toCall), me.stack);
    me.stack -= paid; me.streetBet += paid; me.allIn = me.stack === 0; me.acted = true;
  } else if (action === "bet") {
    const max = me.streetBet + me.stack;
    amount = Math.max(Math.min(s.bigBlind, max), Math.min(amount, max));
    paid = amount - me.streetBet;
    me.stack -= paid; me.streetBet = amount; me.allIn = me.stack === 0; me.acted = true;
    s.currentBet = amount; s.minRaise = amount; s.lastAggressor = me.seat; reopened = true;
  } else if (action === "raise") {
    const max = me.streetBet + me.stack;
    amount = Math.min(amount, max);
    paid = amount - me.streetBet;
    me.stack -= paid; me.streetBet = amount; me.allIn = me.stack === 0; me.acted = true;
    s.minRaise = amount - s.currentBet; s.currentBet = amount; s.lastAggressor = me.seat; reopened = true;
  } else if (action === "all_in") {
    paid = me.stack;
    const newBet = me.streetBet + paid;
    me.stack = 0; me.streetBet = newBet; me.allIn = true; me.acted = true;
    if (newBet > s.currentBet) {
      const inc = newBet - s.currentBet;
      s.currentBet = newBet;
      if (inc >= s.minRaise) { s.minRaise = inc; s.lastAggressor = me.seat; reopened = true; }
    }
  }
  me._hand = (me._hand ?? 0) + paid;
  s.pot += paid;
  if (reopened) for (const p of s.players) if (p.inHand && notDone(p) && p.seat !== me.seat) p.acted = false;

  if (!roundClosed(s)) {
    s.currentSeat = nextToAct(s, me.seat);
    return s;
  }
  return resolve(s);
}

function resolve(s) {
  while (true) {
    const live = s.players.filter((p) => p.inHand && !p.folded);
    if (live.length === 1) {
      live[0].stack += s.pot;
      s.winners = [live[0].id];
      return endHand(s);
    }
    for (const p of s.players) if (p.inHand) { p.streetBet = 0; p.acted = false; }
    s.currentBet = 0;
    const ns = nextStreet(s.street);
    if (ns === "showdown") { s.street = "showdown"; s.board = s.fullBoard.slice(0, 5); showdown(s); return endHand(s); }
    s.street = ns;
    s.board = s.fullBoard.slice(0, boardCount(ns));
    const canAct = live.filter((p) => !p.allIn);
    if (canAct.length >= 2) {
      s.minRaise = s.bigBlind; s.lastAggressor = null;
      s.currentSeat = nextSeat(s, s.button, (p) => notDone(p));
      return s;
    }
  }
}

function showdown(s) {
  const reveal = s.players.filter((p) => p.inHand && !p.folded);
  // Per-hand contribution tally (p._hand) drives the side pots — chips in from
  // everyone dealt in this hand, including folders (their chips stay in the pot).
  const contribs = s.players.filter((p) => p.inHand).map((p) => ({ seat: p.seat, amount: p._hand ?? 0, folded: p.folded }));
  const pots = buildSidePots(contribs);
  const evalBySeat = {};
  for (const p of reveal) evalBySeat[p.seat] = evaluateBest([...p.hole, ...s.fullBoard]);
  const payout = {};
  const winners = new Set();
  for (const pot of pots) {
    const contenders = pot.eligible.filter((seat) => reveal.some((p) => p.seat === seat));
    if (!contenders.length) continue;
    let best = null, w = [];
    for (const seat of contenders) {
      const sc = evalBySeat[seat].score;
      if (!best || compareScore(sc, best) > 0) { best = sc; w = [seat]; }
      else if (compareScore(sc, best) === 0) w.push(seat);
    }
    const split = splitPot(pot.amount, w, s.button);
    for (const [seat, amt] of Object.entries(split)) payout[seat] = (payout[seat] ?? 0) + amt;
    w.forEach((x) => winners.add(x));
  }
  for (const p of reveal) {
    const won = payout[p.seat] ?? 0;
    p.stack += won;
    s.showdown.push({ id: p.id, cards: [...p.hole], rank: evalBySeat[p.seat].name, won });
  }
  s.winners = [...winners].map((seat) => s.players.find((p) => p.seat === seat).id);
}

function endHand(s) {
  s.street = "idle"; s.currentSeat = null; s.currentBet = 0; s.minRaise = 0; s.lastAggressor = null;
  s.pot = 0;
  return s;
}

/* ---------------- heuristic AI ----------------
 * A simple but sensible bot: estimate hand strength (0..1), weigh it against pot
 * odds, and fold weak / call medium / raise strong — with a little randomness so
 * it isn't a robot. Good enough to practise against; not a solver.
 */
function preflopStrength(hole) {
  const r1 = rankVal(hole[0]), r2 = rankVal(hole[1]);
  const hi = Math.max(r1, r2), lo = Math.min(r1, r2);
  const suited = Math.floor(hole[0] / 13) === Math.floor(hole[1] / 13);
  const gap = hi - lo;
  if (r1 === r2) return Math.min(0.98, 0.5 + (r1 - 2) / 12 * 0.48); // pairs: 22≈.5 … AA≈.98
  let s = (hi / 14) * 0.42 + (lo / 14) * 0.16;
  if (suited) s += 0.08;
  if (gap === 1) s += 0.06; else if (gap === 2) s += 0.03; // connectors
  if (hi === 14) s += 0.05;                                 // ace kicker
  return Math.max(0.05, Math.min(0.9, s));
}

function categoryStrength(cat) {
  return [0.16, 0.45, 0.66, 0.78, 0.85, 0.9, 0.95, 0.98, 0.995][cat] ?? 0.16;
}

export function botDecision(s) {
  const me = s.players.find((p) => p.seat === s.currentSeat);
  const toCall = s.currentBet - me.streetBet;
  const max = me.streetBet + me.stack;
  const potOdds = toCall > 0 ? toCall / (s.pot + toCall) : 0;

  let strength = s.street === "preflop"
    ? preflopStrength(me.hole)
    : categoryStrength(evaluateBest([...me.hole, ...s.board]).score[0]);
  strength += (Math.random() - 0.5) * 0.14; // jitter
  strength = Math.max(0, Math.min(1, strength));

  const bb = s.bigBlind;
  const shortStacked = me.stack <= 6 * bb;
  const raiseTo = (frac) => {
    const target = s.currentBet + Math.max(s.minRaise || bb, Math.round((s.pot || bb) * frac));
    return Math.min(max, target);
  };

  if (toCall === 0) {
    // Check or bet.
    if (strength > 0.78 || (strength > 0.6 && Math.random() < 0.6)) {
      if (shortStacked && strength > 0.7) return ["all_in"];
      const to = raiseTo(strength > 0.85 ? 0.9 : 0.55);
      return to >= max ? ["all_in"] : [s.currentBet === 0 ? "bet" : "raise", to];
    }
    if (strength > 0.4 && Math.random() < 0.25) {
      const to = raiseTo(0.4);
      return to >= max ? ["all_in"] : [s.currentBet === 0 ? "bet" : "raise", to];
    }
    return ["check"];
  }

  // Facing a bet: fold / call / raise.
  if (toCall >= me.stack) {
    // Would be all-in to call.
    return strength > 0.6 ? ["all_in"] : Math.random() < 0.1 && strength > 0.45 ? ["all_in"] : ["fold"];
  }
  if (strength > 0.82) {
    if (shortStacked) return ["all_in"];
    const to = raiseTo(strength > 0.9 ? 1 : 0.6);
    return to >= max ? ["all_in"] : ["raise", to];
  }
  if (strength > potOdds + 0.12) return ["call"];
  if (strength > 0.45 && toCall <= 3 * bb) return ["call"];
  if (Math.random() < 0.05) return ["raise", raiseTo(0.5)]; // occasional bluff
  return ["fold"];
}

export function localRebuy(prev, id) {
  const s = clone(prev);
  const p = s.players.find((x) => x.id === id);
  if (p && p.stack === 0) { p.stack = s.buyIn; p._bought += s.buyIn; }
  return s;
}
