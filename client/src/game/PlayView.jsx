import { useEffect, useState } from "react";
import { Panel } from "../components/Marquee";
import Card from "../components/Card";

const STREET_LABEL = { preflop: "Preflop", flop: "Flop", turn: "Turn", river: "River", showdown: "Showdown" };

// Live countdown to the current player's turn_deadline. Only meaningful in live
// mode (60s turns); async deadlines are 48h so we hide those.
function Countdown({ deadline, mode }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);
  if (!deadline || mode !== "live") return null;
  const secs = Math.max(0, Math.round((new Date(deadline).getTime() - Date.now()) / 1000));
  if (secs > 60) return null;
  return <span className={"clock" + (secs <= 10 ? " low" : "")}>{secs}s</span>;
}

// The live poker table: board, pot, seats, your private hole cards, and the
// action bar. All betting math is validated server-side; this mirrors the legal
// options for UX only.
export default function PlayView({
  game, players, me, myHole, showdowns = [], onAct, onNextHand, onRebuy, onEndTable,
  busy, isHost, error, onHome, onLeave,
}) {
  const live = ["preflop", "flop", "turn", "river"].includes(game.street);
  const betweenHands = game.street === "idle" && (game.winner_ids?.length ?? 0) > 0;
  const myTurn = live && me && me.seat === game.current_seat && !me.has_folded && !me.is_all_in;
  const toCall = Math.max(0, game.current_bet - (me?.street_bet ?? 0));
  const myMax = me ? me.street_bet + me.stack : 0;                       // raise-to ceiling (all-in)
  const canRaise = myTurn && me.stack > toCall;
  const minRaiseTo = Math.min(
    game.current_bet === 0 ? game.big_blind : game.current_bet + game.min_raise,
    myMax,
  );

  const [raiseTo, setRaiseTo] = useState(minRaiseTo);
  useEffect(() => { setRaiseTo(minRaiseTo); }, [game.current_bet, game.street, game.current_seat, minRaiseTo]);

  const showdownBySeat = {};
  for (const s of showdowns) {
    const p = players.find((x) => x.player_id === s.player_id);
    if (p) showdownBySeat[p.seat] = s;
  }
  const winners = game.winner_ids ?? [];
  const nameOf = (pid) => players.find((p) => p.player_id === pid)?.profile?.username ?? "player";
  const currentName = players.find((p) => p.seat === game.current_seat)?.profile?.username;

  const badges = (p) => {
    const b = [];
    if (p.seat === game.button_seat) b.push("D");
    if (p.is_all_in) b.push("ALL-IN");
    else if (p.has_folded) b.push("FOLD");
    return b;
  };

  return (
    <>
      <div className="rail">
        <div className="potBox">
          <span className="potLbl">POT</span>
          <span className="potAmt">${game.pot}</span>
        </div>
        <div className="leaders">
          <div className="leader">
            <span className="ldName">
              {STREET_LABEL[game.street] ?? "Hand over"} · blinds {game.small_blind}/{game.big_blind}
            </span>
          </div>
          <div className="leader">
            <span className="ldName">
              {live
                ? myTurn ? "Your action" : `Waiting for @${currentName ?? "…"}`
                : betweenHands ? `Winner: ${winners.map(nameOf).join(" & ")}` : "Hand complete"}
            </span>
            {live && <Countdown deadline={game.turn_deadline} mode={game.mode} />}
          </div>
        </div>
      </div>

      {/* Community board */}
      <div className="panel">
        <div className="cardRow">
          {Array.from({ length: 5 }, (_, i) =>
            game.board[i] != null ? <Card key={i} card={game.board[i]} /> : <div key={i} className="card slot" />,
          )}
        </div>
      </div>

      {/* Seats */}
      <Panel title="Table">
        {[...players].sort((a, b) => a.seat - b.seat).map((p) => {
          const isMe = p.player_id === me?.player_id;
          const reveal = showdownBySeat[p.seat];
          const inHand = p.in_hand && !p.has_folded;
          const won = reveal?.won ?? 0;
          return (
            <div
              key={p.player_id}
              className={"seatRow" + (p.seat === game.current_seat && live ? " turn" : "") + (p.has_folded ? " folded" : "")}
            >
              <div className="seatWho">
                <span className="seatName">
                  {p.profile?.username ?? "player"}{isMe && " (you)"}
                </span>
                <span className="seatStack">
                  ${p.stack}
                  {p.street_bet > 0 && <span className="inFront"> · bet ${p.street_bet}</span>}
                  {badges(p).map((b) => <span key={b} className={"pBadge " + b.toLowerCase().replace("-", "")}>{b}</span>)}
                </span>
                {reveal && (
                  <span className="seatRank">{reveal.hand_rank}{won > 0 && ` · won $${won}`}</span>
                )}
              </div>
              <div className="seatCards">
                {isMe ? (
                  myHole ? myHole.map((c, i) => <Card key={i} card={c} small />) : null
                ) : reveal ? (
                  reveal.cards.map((c, i) => <Card key={i} card={c} small />)
                ) : inHand ? (
                  <><Card small down /><Card small down /></>
                ) : null}
              </div>
            </div>
          );
        })}
      </Panel>

      {/* My hole cards, large */}
      {me?.in_hand && myHole && (
        <div className="panel myHole">
          <div className="panelSub" style={{ marginTop: 0 }}>Your hand{me.has_folded ? " (folded)" : ""}</div>
          <div className="cardRow">
            {myHole.map((c, i) => <Card key={i} card={c} muck={me.has_folded} />)}
          </div>
        </div>
      )}

      {error && <p className="errText">{error}</p>}

      {/* Action bar */}
      {myTurn && (
        <div className="panel actionBar">
          <div className="actRow">
            <button className="bigBtn slate" disabled={busy} onClick={() => onAct("fold")}>FOLD</button>
            {toCall === 0 ? (
              <button className="bigBtn green" disabled={busy} onClick={() => onAct("check")}>CHECK</button>
            ) : (
              <button className="bigBtn green" disabled={busy} onClick={() => onAct("call")}>
                CALL ${Math.min(toCall, me.stack)}
              </button>
            )}
          </div>

          {canRaise && (
            <>
              <div className="raiseHead">
                <span>{game.current_bet === 0 ? "Bet" : "Raise to"}</span>
                <b>${raiseTo}</b>
              </div>
              <input
                type="range" min={minRaiseTo} max={myMax} step={1} value={raiseTo}
                onChange={(e) => setRaiseTo(Number(e.target.value))}
              />
              <div className="raiseQuick">
                <button className="mini" onClick={() => setRaiseTo(minRaiseTo)}>MIN</button>
                <button className="mini" onClick={() => setRaiseTo(Math.min(myMax, game.current_bet + Math.round(game.pot / 2) || minRaiseTo))}>½ POT</button>
                <button className="mini" onClick={() => setRaiseTo(Math.min(myMax, game.current_bet + game.pot || minRaiseTo))}>POT</button>
                <button className="mini" onClick={() => setRaiseTo(myMax)}>MAX</button>
              </div>
              <div className="actRow">
                <button className="bigBtn gold" disabled={busy || raiseTo < minRaiseTo}
                  onClick={() => onAct(game.current_bet === 0 ? "bet" : "raise", raiseTo)}>
                  {game.current_bet === 0 ? `BET $${raiseTo}` : `RAISE TO $${raiseTo}`}
                </button>
                <button className="bigBtn hot" disabled={busy} onClick={() => onAct("all_in")}>
                  ALL-IN ${me.stack}
                </button>
              </div>
            </>
          )}
          {!canRaise && toCall > 0 && me.stack <= toCall && (
            <p className="hint">Calling puts you all-in for ${me.stack}.</p>
          )}
        </div>
      )}

      {/* Not my turn, still in the hand */}
      {live && !myTurn && (
        <p className="finalBanner">{me?.has_folded ? "YOU FOLDED" : me?.is_all_in ? "YOU'RE ALL-IN" : `WAITING FOR @${currentName ?? "…"}`}</p>
      )}

      {/* Between hands */}
      {betweenHands && (
        <div className="panel">
          <div className="panelTitle">Hand {game.hand_no} complete</div>
          {(() => {
            const wonTotal = showdowns.reduce((s, r) => s + (r.won || 0), 0);
            const winRank = showdownBySeat[players.find((p) => winners.includes(p.player_id))?.seat]?.hand_rank;
            return (
              <p className="potPreview">
                <b>{winners.map(nameOf).join(" & ")}</b> won the pot
                {wonTotal > 0 ? ` of $${wonTotal}` : ""}
                {winRank ? ` — ${winRank}` : ""}.
              </p>
            );
          })()}
          {me && me.stack === 0 && (
            <>
              <p className="hint" style={{ color: "#ff8a9a" }}>You're out of chips.</p>
              <button className="bigBtn gold" disabled={busy} onClick={onRebuy}>
                {busy ? "…" : `REBUY $${game.buy_in}`}
              </button>
            </>
          )}
          {isHost ? (
            <>
              <button className="bigBtn green" disabled={busy} onClick={onNextHand}>
                {busy ? "DEALING…" : "DEAL NEXT HAND"}
              </button>
              <button className="ghost" disabled={busy} onClick={onEndTable}>
                END TABLE & SETTLE UP
              </button>
            </>
          ) : (
            <p className="hint">Waiting for the host to deal the next hand.</p>
          )}
        </div>
      )}

      <div className="footRow">
        <button className="ghost" style={{ flex: 1 }} onClick={onHome}>← HOME</button>
        {!isHost && <button className="ghost" style={{ flex: 1 }} onClick={onLeave}>LEAVE</button>}
      </div>
    </>
  );
}
