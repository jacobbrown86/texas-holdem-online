import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Felt, Marquee, Panel } from "../components/Marquee";
import PlayView from "../game/PlayView";
import FinishedView from "../game/FinishedView";
import { newLocalGame, startHand, applyAction, botDecision, localRebuy } from "../lib/pokerEngine";

const BOT_NAMES = ["Ivy", "Rex", "Mia", "Ace", "Nova"];
const HUMAN_ID = "p0";
const SAVE_KEY = "th_local_game";
const BLINDS = [10, 20, 50];

// Local modes, both driven by the on-device poker engine and reusing PlayView:
//  - cpu:      you vs AI bots (bots auto-play).
//  - inperson: one phone passed around; a reveal gate hides each player's hole
//              cards until they tap, then hides again after they act.
export default function LocalGame() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const setupMode = params.get("mode") === "inperson" ? "inperson" : "cpu";

  const [view, setView] = useState("setup");
  const [gs, setGs] = useState(null);
  const [revealed, setRevealed] = useState(false);

  // cpu setup
  const [opponents, setOpponents] = useState(2);
  // in-person setup
  const [names, setNames] = useState(["Player 1", "Player 2"]);
  const [bigBlind, setBigBlind] = useState(20);

  const mode = gs?.mode ?? setupMode; // gs.mode is authoritative once a game exists

  // Resume a saved game.
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(SAVE_KEY) || "null");
      if (saved?.phase === "game" && saved.gs) { setGs(saved.gs); setView("game"); }
    } catch { /* ignore */ }
  }, []);

  // Persist while active; drop the save once it's over.
  useEffect(() => {
    if (view === "game" && gs?.status === "active") {
      localStorage.setItem(SAVE_KEY, JSON.stringify({ phase: "game", gs }));
    } else if (gs?.status === "finished") {
      localStorage.removeItem(SAVE_KEY);
    }
  }, [gs, view]);

  // In-person: hide cards again whenever the action moves to a new player / hand.
  useEffect(() => {
    if (mode === "inperson") setRevealed(false);
  }, [gs?.currentSeat, gs?.handNo, mode]);

  // cpu: bots act automatically with a short "thinking" delay.
  useEffect(() => {
    if (!gs || gs.mode !== "cpu" || gs.status !== "active" || gs.street === "idle") return;
    const cur = gs.players.find((p) => p.seat === gs.currentSeat);
    if (!cur || !cur.isBot) return;
    const seat = cur.seat;
    const t = setTimeout(() => {
      setGs((s) => {
        if (!s || s.street === "idle" || s.currentSeat !== seat) return s;
        const p = s.players.find((x) => x.seat === seat);
        if (!p || !p.isBot) return s;
        const [a, amt] = botDecision(s);
        return applyAction(s, a, amt);
      });
    }, 750 + Math.random() * 650);
    return () => clearTimeout(t);
  }, [gs]);

  function startCpu() {
    const ns = ["You", ...BOT_NAMES.slice(0, opponents)];
    setGs(startHand(newLocalGame({ names: ns, bigBlind, buyIn: bigBlind * 100, mode: "cpu" })));
    setView("game");
  }
  function startInPerson() {
    const ns = names.map((n, i) => n.trim() || `Player ${i + 1}`);
    setGs(startHand(newLocalGame({ names: ns, bigBlind, buyIn: bigBlind * 100, mode: "inperson" })));
    setView("game");
  }
  function quit() {
    localStorage.removeItem(SAVE_KEY);
    navigate("/");
  }

  /* ---------- setup ---------- */
  if (view === "setup" || !gs) {
    if (setupMode === "inperson") {
      const setName = (i, v) => setNames((a) => a.map((n, k) => (k === i ? v : n)));
      return (
        <Felt>
          <Marquee bottom="IN PERSON" />
          <Panel title="Players" sub={`· ${names.length} at the table`}>
            {names.map((n, i) => (
              <div className="nameRow" key={i}>
                <span className="seat">{i + 1}</span>
                <input value={n} maxLength={16} onChange={(e) => setName(i, e.target.value)} placeholder={`Player ${i + 1}`} />
                {names.length > 2 && (
                  <button className="nameChipX" onClick={() => setNames((a) => a.filter((_, k) => k !== i))} aria-label="Remove">✕</button>
                )}
              </div>
            ))}
            {names.length < 10 && (
              <button className="ghost" onClick={() => setNames((a) => [...a, `Player ${a.length + 1}`])}>+ ADD PLAYER</button>
            )}
          </Panel>
          <Panel title="Blinds" sub={`· ${Math.max(1, Math.floor(bigBlind / 2))}/${bigBlind}`}>
            <div className="toggleRow">
              {BLINDS.map((b) => (
                <button key={b} type="button" className={"toggle" + (bigBlind === b ? " on" : "")} onClick={() => setBigBlind(b)}>${b}</button>
              ))}
            </div>
            <p className="hint">Everyone starts with 100× the big blind (${bigBlind * 100}). Pass the phone around — cards stay hidden until you tap.</p>
          </Panel>
          <button className="bigBtn green" onClick={startInPerson}>START</button>
          <button className="ghost" onClick={() => navigate("/")}>← BACK TO HOME</button>
        </Felt>
      );
    }
    return (
      <Felt>
        <Marquee bottom="VS THE COMPUTER" />
        <Panel title="Opponents" sub={`· ${opponents} bot${opponents > 1 ? "s" : ""}`}>
          <div className="toggleRow">
            {[1, 2, 3, 4, 5].map((n) => (
              <button key={n} type="button" className={"toggle" + (opponents === n ? " on" : "")} onClick={() => setOpponents(n)}>{n}</button>
            ))}
          </div>
        </Panel>
        <Panel title="Blinds" sub={`· ${Math.max(1, Math.floor(bigBlind / 2))}/${bigBlind}`}>
          <div className="toggleRow">
            {BLINDS.map((b) => (
              <button key={b} type="button" className={"toggle" + (bigBlind === b ? " on" : "")} onClick={() => setBigBlind(b)}>${b}</button>
            ))}
          </div>
          <p className="hint">Everyone starts with 100× the big blind (${bigBlind * 100}).</p>
        </Panel>
        <button className="bigBtn green" onClick={startCpu}>DEAL ME IN</button>
        <button className="ghost" onClick={() => navigate("/")}>← BACK TO HOME</button>
      </Felt>
    );
  }

  /* ---------- shared view mapping ---------- */
  const inPerson = gs.mode === "inperson";
  const actor = gs.players.find((p) => p.seat === gs.currentSeat);
  const viewerId = inPerson ? actor?.id : HUMAN_ID;

  const game = {
    status: gs.status === "finished" ? "finished" : "active",
    street: gs.street, current_seat: gs.currentSeat, current_bet: gs.currentBet,
    min_raise: gs.minRaise, big_blind: gs.bigBlind, small_blind: gs.smallBlind, buy_in: gs.buyIn,
    pot: gs.pot, board: gs.board, hand_no: gs.handNo, button_seat: gs.button,
    winner_ids: gs.winners, turn_deadline: null, mode: "cpu", stake_type: "none", created_by: viewerId,
  };
  const players = gs.players.map((p) => ({
    seat: p.seat, stack: p.stack, status: "seated", in_hand: p.inHand,
    has_folded: p.folded, street_bet: p.streetBet, is_all_in: p.allIn,
    player_id: p.id, profile: { username: p.name }, total_bet: p._bought,
  }));
  const me = players.find((p) => p.player_id === viewerId) ?? null;
  const viewer = gs.players.find((p) => p.id === viewerId);
  // In-person only reveals the actor's cards after they tap the gate.
  const showViewerCards = inPerson ? revealed : true;
  const myHole = viewer?.inHand && viewer.hole.length && showViewerCards ? viewer.hole : null;
  const showdowns = gs.showdown.map((r) => ({ player_id: r.id, cards: r.cards, hand_rank: r.rank, won: r.won }));

  /* ---------- finished ---------- */
  if (gs.status === "finished") {
    const net = (p) => p.stack - p.total_bet;
    const best = Math.max(...players.map(net));
    const finGame = { ...game, winner_ids: players.filter((p) => net(p) === best).map((p) => p.player_id) };
    const playAgainLocal = () => {
      setRevealed(false);
      setGs(startHand(newLocalGame({
        names: gs.players.map((p) => p.name), bigBlind: gs.bigBlind, buyIn: gs.buyIn, mode: gs.mode,
      })));
    };
    return (
      <Felt>
        <Marquee bottom="GAME OVER" winner />
        <FinishedView game={finGame} players={players} me={me} onHome={quit} busy={false}
          onPlayAgain={playAgainLocal} isHost />
      </Felt>
    );
  }

  /* ---------- in-person pass gate ---------- */
  if (inPerson && gs.street !== "idle" && !revealed) {
    return (
      <Felt>
        <Marquee bottom="IN PERSON" />
        <div className="passGate">
          <div className="passInner">
            <div className="passTitle">Pass the phone to</div>
            <div className="passName">{actor?.name ?? "next player"}</div>
            <p className="hint">Make sure only {actor?.name ?? "you"} can see the screen.</p>
            <button className="bigBtn gold" onClick={() => setRevealed(true)}>TAP TO SEE MY CARDS</button>
          </div>
        </div>
      </Felt>
    );
  }

  const onAct = (a, amt) => {
    setGs((s) => applyAction(s, a, amt));
    if (inPerson) setRevealed(false); // hide immediately after acting, before the pass
  };

  return (
    <Felt>
      <Marquee bottom={inPerson ? "IN PERSON" : "VS THE COMPUTER"} winner={gs.street === "idle"} />
      <PlayView
        game={game} players={players} me={me} myHole={myHole} showdowns={showdowns}
        onAct={onAct}
        onNextHand={() => setGs((s) => startHand(s))}
        onRebuy={() => setGs((s) => localRebuy(s, viewerId))}
        onEndTable={() => setGs((s) => ({ ...s, status: "finished" }))}
        busy={false} isHost error="" onHome={quit}
      />
    </Felt>
  );
}
