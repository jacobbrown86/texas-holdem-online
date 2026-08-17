import { Panel } from "../components/Marquee";

// End-of-session settlement. Shows each player's net result (what they walked
// away with minus what they bought in for). Chips already moved to balances;
// ledger tables settle privately off-app.
export default function FinishedView({ game, players, me, onHome, busy }) {
  const winners = game.winner_ids ?? [];
  const net = (p) => p.stack - p.total_bet;
  const board = [...players].filter((p) => p.status !== "left").sort((a, b) => net(b) - net(a) || a.seat - b.seat);
  const iWon = me && winners.includes(me.player_id);
  const staked = game.stake_type !== "none";
  const winnerNames = board
    .filter((p) => winners.includes(p.player_id))
    .map((p) => p.profile?.username ?? "player")
    .join(" & ");
  const myNet = me ? net(me) : 0;

  const money = (n) => (n > 0 ? `+$${n}` : n < 0 ? `-$${-n}` : "$0");

  return (
    <>
      <div className="finalBanner" style={{ fontSize: 22 }}>
        {iWon ? "🏆 YOU CAME OUT ON TOP" : winnerNames ? `${winnerNames} WINS` : "GAME OVER"}
      </div>

      {staked && me && (
        <div className="panel">
          {myNet > 0 ? (
            <b>You finished up {money(myNet)}{game.stake_type === "chips" ? " chips" : ""}.</b>
          ) : myNet < 0 ? (
            <>You finished down <b>{money(myNet)}</b>{game.stake_type === "chips" ? " chips" : ""}.</>
          ) : (
            <>You broke even.</>
          )}
          {game.stake_type === "ledger" && (
            <p className="hint">Ledger game — settle up privately. Nothing was charged.</p>
          )}
        </div>
      )}

      <Panel title="Settlement">
        <table className="scoreTable">
          <thead>
            <tr>
              <th>Player</th>
              <th style={{ textAlign: "right" }}>Bought in</th>
              <th style={{ textAlign: "right" }}>Ended</th>
              <th style={{ textAlign: "right" }}>Net</th>
            </tr>
          </thead>
          <tbody>
            {board.map((p) => (
              <tr key={p.player_id} className={winners.includes(p.player_id) ? "curRow" : ""}>
                <td>
                  {p.profile?.username ?? "player"}
                  {p.player_id === me?.player_id && " (you)"}
                  {winners.includes(p.player_id) && " 👑"}
                </td>
                <td className="num" style={{ textAlign: "right" }}>${p.total_bet}</td>
                <td className="num" style={{ textAlign: "right" }}>${p.stack}</td>
                <td className="num" style={{ textAlign: "right", color: net(p) > 0 ? "#8fe094" : net(p) < 0 ? "#ff8a9a" : "#c9d8c9" }}>
                  {money(net(p))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {game.stake_type === "chips" && (
          <p className="hint">Chips have been returned to everyone's balance.</p>
        )}
      </Panel>

      <button className="ghost" disabled={busy} onClick={onHome}>← BACK TO HOME</button>
    </>
  );
}
