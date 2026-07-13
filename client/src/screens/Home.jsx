import { useEffect, useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { useAuth } from "../auth/AuthProvider";
import { Felt, Marquee, Panel } from "../components/Marquee";
import { pushStatus, enablePush, disablePush, pushConfigured } from "../lib/push";

const STATUS_LABEL = {
  lobby: "In the lobby",
  active: "Playing",
  finished: "Finished",
  abandoned: "Abandoned",
};

export default function Home() {
  const { profile, user, signOut } = useAuth();
  const navigate = useNavigate();
  const [games, setGames] = useState(null);
  const [invites, setInvites] = useState([]);
  const [joinInput, setJoinInput] = useState("");
  const [push, setPush] = useState("off");

  useEffect(() => {
    pushStatus().then(setPush);
  }, []);

  async function togglePush() {
    try {
      setPush(push === "on" ? await disablePush() : await enablePush(user.id));
    } catch (e) {
      alert(e.message);
    }
  }

  const [hidden, setHidden] = useState(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem("th_hidden_games") || "[]"));
    } catch {
      return new Set();
    }
  });

  function hideGame(id) {
    setHidden((h) => {
      const next = new Set(h);
      next.add(id);
      localStorage.setItem("th_hidden_games", JSON.stringify([...next]));
      return next;
    });
  }

  function joinByCode(e) {
    e.preventDefault();
    const raw = joinInput.trim();
    if (!raw) return;
    // Accept a full invite link (…/g/CODE) or a bare code.
    const match = raw.match(/\/g\/([A-Za-z0-9]+)/);
    const code = (match ? match[1] : raw).toUpperCase();
    navigate(`/g/${code}`);
  }

  const load = useCallback(async () => {
    // My seat rows joined to their games. RLS lets me read games I'm seated in.
    const { data } = await supabase
      .from("game_players")
      .select(
        "seat, status, game:games(id, invite_code, status, mode, stake_type, small_blind, big_blind, buy_in, current_seat, created_at)",
      )
      .eq("player_id", user.id);

    const rows = (data ?? [])
      .map((r) => ({ ...r.game, seat: r.seat, myStatus: r.status }))
      .filter((g) => g.id && g.status !== "abandoned")
      .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
    setGames(rows);

    // Pending invites for lobby games I'm not already seated in.
    const myGameIds = new Set(rows.map((g) => g.id));
    const { data: inv } = await supabase
      .from("invites")
      .select("id, game_id, inviter:profiles!invites_inviter_fkey(username), game:games(invite_code, status)")
      .eq("invitee", user.id)
      .eq("status", "pending");
    const pending = (inv ?? [])
      .filter((r) => r.game?.status === "lobby" && !myGameIds.has(r.game_id))
      .map((r) => ({ id: r.id, code: r.game.invite_code, from: r.inviter?.username ?? "someone" }));
    setInvites(pending);
  }, [user.id]);

  useEffect(() => {
    load();
    // Keep the list (and "your turn" badges) fresh automatically.
    const id = setInterval(load, 5000);
    const onVisible = () => document.visibilityState === "visible" && load();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [load]);

  const yourTurn = (g) => g.status === "active" && g.current_seat === g.seat;

  const stakes = (g) =>
    g.stake_type === "none"
      ? "for fun"
      : `${g.small_blind}/${g.big_blind} blinds · ${g.stake_type}`;

  const visible = (games ?? []).filter((g) => !hidden.has(g.id));
  // A game you've left drops into Finished for you.
  const activeGames = visible.filter((g) => g.status !== "finished" && g.myStatus !== "left");
  const finishedGames = visible.filter((g) => g.status === "finished" || g.myStatus === "left");

  // An in-progress in-person game (saved locally on this device).
  const localActive = (() => {
    try {
      return JSON.parse(localStorage.getItem("th_local_game") || "null")?.phase === "game";
    } catch {
      return false;
    }
  })();

  return (
    <Felt>
      <Marquee bottom={profile ? `@${profile.username} · ${profile.chips} chips` : ""} />

      <Panel title="Start a game">
        <div className="modePick">
          <button className="modeBtn" onClick={() => navigate("/new")}>
            <b>🌐 Online</b>
            <span>Everyone on their own device. Invite by link, code, or username.</span>
          </button>
          <button className="modeBtn" onClick={() => navigate("/local?mode=inperson")}>
            <b>🃏 In person</b>
            <span>One phone, passed around the table. Cards stay private behind a tap.</span>
          </button>
          <button className="modeBtn" onClick={() => navigate("/local?mode=cpu")}>
            <b>🤖 Vs the computer</b>
            <span>Practice against AI opponents on this device.</span>
          </button>
        </div>
      </Panel>

      {invites.length > 0 && (
        <Panel title="You're invited">
          {invites.map((iv) => (
            <button key={iv.id} className="gameRow" onClick={() => navigate(`/g/${iv.code}`)}>
              <div className="gameRowMain">
                <span className="gameCode">{iv.code}</span>
                <span className="gameMeta">from @{iv.from}</span>
              </div>
              <span className="badge hot">JOIN</span>
            </button>
          ))}
        </Panel>
      )}

      <Panel title="Join a table">
        <form onSubmit={joinByCode} className="shareRow">
          <input
            value={joinInput}
            onChange={(e) => setJoinInput(e.target.value)}
            placeholder="Enter code or paste invite link"
            autoCapitalize="characters"
          />
          <button className="mini gold" style={{ width: "auto", padding: "0 16px" }} disabled={!joinInput.trim()}>
            JOIN
          </button>
        </form>
      </Panel>

      <Panel title="Your tables">
        {games === null && <p className="hint">Loading…</p>}
        {games !== null && activeGames.length === 0 && !localActive && (
          <p className="hint">No active tables. Start one above.</p>
        )}
        {localActive && (
          <button className="gameRow" onClick={() => navigate("/local")}>
            <div className="gameRowMain">
              <span className="gameCode">LIVE GAME</span>
              <span className="gameMeta">in person · one phone</span>
            </div>
            <span className="badge hot">RESUME</span>
          </button>
        )}
        {activeGames.map((g) => (
          <button
            key={g.id}
            className="gameRow"
            onClick={() => navigate(`/g/${g.invite_code}`)}
          >
            <div className="gameRowMain">
              <span className="gameCode">{g.invite_code}</span>
              <span className="gameMeta">
                {g.mode} · {stakes(g)}
              </span>
            </div>
            <span className={"badge" + (yourTurn(g) ? " hot" : "")}>
              {yourTurn(g) ? "YOUR TURN" : STATUS_LABEL[g.status] ?? g.status}
            </span>
          </button>
        ))}
      </Panel>

      {finishedGames.length > 0 && (
        <Panel title="Finished tables">
          {finishedGames.map((g) => (
            <div key={g.id} className="gameRow" style={{ cursor: "default" }}>
              <div
                className="gameRowMain"
                style={{ cursor: "pointer" }}
                onClick={() => navigate(`/g/${g.invite_code}`)}
              >
                <span className="gameCode">{g.invite_code}</span>
                <span className="gameMeta">
                  {g.mode} · {stakes(g)}
                </span>
              </div>
              <button className="deleteX" onClick={() => hideGame(g.id)} aria-label="Delete game">
                ✕
              </button>
            </div>
          ))}
        </Panel>
      )}

      {pushConfigured && push !== "unsupported" && (
        <button className="ghost" onClick={togglePush}>
          {push === "on"
            ? "🔔 NOTIFICATIONS ON"
            : push === "denied"
              ? "🔕 NOTIFICATIONS BLOCKED"
              : "🔔 TURN ON NOTIFICATIONS"}
        </button>
      )}
      <div className="footRow">
        <button className="ghost" style={{ flex: 1 }} onClick={() => window.location.reload()}>
          ↻ REFRESH
        </button>
        <button className="ghost" style={{ flex: 1 }} onClick={signOut}>
          SIGN OUT
        </button>
      </div>
    </Felt>
  );
}
