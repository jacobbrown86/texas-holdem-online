import { RANKS, SUITS, rankOf, suitOf, isRed } from "../lib/cards";

// A single playing card. Pass a 0..51 number for a face-up card, or `down` for a
// face-down back. `deal` plays a deal-in animation on mount; `flip` plays a
// turn-over reveal (used for community cards as each street lands).
export default function Card({ card, down = false, muck = false, small = false, deal = false, flip = false, style }) {
  const cls = ["card", small && "small", muck && "muck", deal && "dealIn", flip && "flipIn"]
    .filter(Boolean).join(" ");
  if (down || card == null) return <div className={cls + " back"} style={style} aria-label="face-down card" />;
  return (
    <div className={cls + (isRed(card) ? " red" : " black")} style={style}>
      <span className="rank">{RANKS[rankOf(card)]}</span>
      <span className="suit">{SUITS[suitOf(card)]}</span>
    </div>
  );
}
