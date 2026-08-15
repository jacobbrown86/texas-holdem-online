import { RANKS, SUITS, rankOf, suitOf, isRed } from "../lib/cards";

// A single playing card. Pass a 0..51 number for a face-up card, or nothing (or
// down) for a face-down back (opponents' hole cards before showdown).
export default function Card({ card, down = false, muck = false, small = false }) {
  const cls = ["card", small ? "small" : "", muck ? "muck" : ""].filter(Boolean).join(" ");
  if (down || card == null) return <div className={cls + " back"} aria-label="face-down card" />;
  return (
    <div className={cls + (isRed(card) ? " red" : " black")}>
      <span className="rank">{RANKS[rankOf(card)]}</span>
      <span className="suit">{SUITS[suitOf(card)]}</span>
    </div>
  );
}
