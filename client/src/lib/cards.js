// Client-side card helpers. A card is 0..51 (must match _shared/poker-logic.ts):
//   rank = card % 13  (0=2 … 8=10, 9=J, 10=Q, 11=K, 12=A)
//   suit = floor(card / 13)  (0♣ 1♦ 2♥ 3♠)
export const RANKS = ["2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A"];
export const SUITS = ["♣", "♦", "♥", "♠"];

export const rankOf = (card) => card % 13;
export const suitOf = (card) => Math.floor(card / 13);
export const isRed = (card) => suitOf(card) === 1 || suitOf(card) === 2; // ♦ ♥
export const cardLabel = (card) => `${RANKS[rankOf(card)]}${SUITS[suitOf(card)]}`;
