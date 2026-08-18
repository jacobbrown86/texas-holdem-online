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

// Vs-computer (and, later, in-person) — the poker engine runs entirely on this
// device. Reuses PlayView so it looks and plays exactly like an online table.
export default function LocalGame() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const mode = params.get("mode") === "inperson" ? "inperson" : "cpu";

  const [view, setView] = useState("setup"); // setup | game
  const [gs, setGs] = useState(null);
  const [opponents, setOpponents] = useState(2);
  const [bigBlind, setBigBlind] = useState(20);

  // Resume a saved game on mount.
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(SAVE_KEY) || "null");
      if (saved?.phase === "game" && saved.gs) { setGs(saved.gs); setView("game"); }
    } catch { /* ignore */ }
  }, []);

  // Persist while a game is live; drop the save once it's over.
  useEffect(() => {
    if (view === "game" && gs?.status === "active") {
      localStorage.setItem(SAVE_KEY, JSON.stringify({ phase: "game", mode, gs }));
    } else if (gs?.status === "finished") {
      localStorage.removeItem(SAVE_KEY);
    }
  }, [gs, view, mode]);

  // Bots act automatically, with a short "thinking" delay for feel.
  useEffect(() => {
    if (!gs || gs.status !== "active" || gs.street === "idle") return;
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

  function start() {
    const names = [ "You", ...BOT_NAMES.slice(0, opponents) ];
    setGs(startHand(newLocalGame({ names, bigBlind, buyIn: bigBlind * 100, mode: "cpu" })));
    setView("game");
  }

  function quit() {
    localStorage.removeItem(SAVE_KEY);
    navigate("/");
  }

  if (mode === "inperson") {
    return (
      <Felt>
        <Marquee bottom="IN PERSON" />
        <Panel title="In person">
          <p className="hint" style={{ marginTop: 0 }}>
            One-phone pass-and-hide mode is coming in a later update. For now, try{" "}
            <b>Vs the computer</b> or start an <b>Online</b> table.
          </p>
          <button className="bigBtn green" onClick={() => navigate("/local?mode=cpu")}>PLAY VS COMPUTER</button>
          <button className="ghost" onClick={() => navigate("/")}>← BACK TO HOME</button>
        </Panel>
      </Felt>
    );
  }

  /* ---------- setup ---------- */
  if (view === "setup" || !gs) {
    return (
      <Felt>
        <Marquee bottom="VS THE COMPUTER" />
        <Panel title="Opponents" sub={`· ${opponents} bot${opponents > 1 ? "s" : ""}`}>
          <div className="toggleRow">
            {[1, 2, 3, 4, 5].map((n) => (
              <button key={n} type="button" className={"toggle" + (opponents === n ? " on" : "")} onClick={() => setOpponents(n)}>
                {n}
              </button>
            ))}
          </div>
        </Panel>
        <Panel title="Blinds" sub={`· ${Math.max(1, Math.floor(bigBlind / 2))}/${bigBlind}`}>
          <div className="toggleRow">
            {BLINDS.map((b) => (
              <button key={b} type="button" className={"toggle" + (bigBlind === b ? " on" : "")} onClick={() => setBigBlind(b)}>
                ${b}
              </button>
            ))}
          </div>
          <p className="hint">Everyone starts with 100× the big blind (${bigBlind * 100}).</p>
        </Panel>
        <button className="bigBtn green" onClick={start}>DEAL ME IN</button>
        <button className="ghost" onClick={() => navigate("/")}>← BACK TO HOME</button>
      </Felt>
    );
  }

  /* ---------- game ---------- */
  const game = {
    status: gs.status === "finished" ? "finished" : "active",
    street: gs.street, current_seat: gs.currentSeat, current_bet: gs.currentBet,
    min_raise: gs.minRaise, big_blind: gs.bigBlind, small_blind: gs.smallBlind, buy_in: gs.buyIn,
    pot: gs.pot, board: gs.board, hand_no: gs.handNo, button_seat: gs.button,
    winner_ids: gs.winners, turn_deadline: null, mode: "cpu", stake_type: "none", created_by: HUMAN_ID,
  };
  const players = gs.players.map((p) => ({
    seat: p.seat, stack: p.stack, status: "seated", in_hand: p.inHand,
    has_folded: p.folded, street_bet: p.streetBet, is_all_in: p.allIn,
    player_id: p.id, profile: { username: p.name }, total_bet: p._bought,
  }));
  const me = players.find((p) => p.player_id === HUMAN_ID);
  const human = gs.players.find((p) => p.id === HUMAN_ID);
  const myHole = human?.inHand && human.hole.length ? human.hole : null;
  const showdowns = gs.showdown.map((r) => ({ player_id: r.id, cards: r.cards, hand_rank: r.rank, won: r.won }));

  if (gs.status === "finished") {
    const net = (p) => p.stack - p.total_bet;
    const best = Math.max(...players.map(net));
    const finGame = { ...game, winner_ids: players.filter((p) => net(p) === best).map((p) => p.player_id) };
    return (
      <Felt>
        <Marquee bottom="GAME OVER" winner />
        <FinishedView game={finGame} players={players} me={me} onHome={quit} busy={false} />
      </Felt>
    );
  }

  return (
    <Felt>
      <Marquee bottom="VS THE COMPUTER" winner={gs.street === "idle"} />
      <PlayView
        game={game} players={players} me={me} myHole={myHole} showdowns={showdowns}
        onAct={(a, amt) => setGs((s) => applyAction(s, a, amt))}
        onNextHand={() => setGs((s) => startHand(s))}
        onRebuy={() => setGs((s) => localRebuy(s, HUMAN_ID))}
        onEndTable={() => setGs((s) => ({ ...s, status: "finished" }))}
        busy={false} isHost error="" onHome={quit}
      />
    </Felt>
  );
}
