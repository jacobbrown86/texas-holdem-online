import { useEffect, useState, useCallback, useRef } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { createGame, joinGame, startHand, act, rebuy, endTable, cancelGame, leaveTable, invitePlayer } from "../lib/api";
import { useAuth } from "../auth/AuthProvider";
import { Felt, Marquee, Panel } from "../components/Marquee";
import LobbyView from "../game/LobbyView";
import PlayView from "../game/PlayView";
import FinishedView from "../game/FinishedView";
import Chat from "../game/Chat";

const PLAYER_SELECT =
  "seat, stack, status, in_hand, has_folded, street_bet, has_acted, is_all_in, player_id, profile:profiles(username, avatar_seed)";

export default function GameRoom() {
  const { code } = useParams();
  const upperCode = (code ?? "").toUpperCase();
  const navigate = useNavigate();
  const { user, refreshProfile } = useAuth();

  const [game, setGame] = useState(null);
  const [players, setPlayers] = useState([]);
  const [myHole, setMyHole] = useState(null);
  const [showdowns, setShowdowns] = useState([]);
  const [phase, setPhase] = useState("loading"); // loading | ready | notfound | error
  const [error, setError] = useState("");
  const [dealing, setDealing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copiedCode, setCopiedCode] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [recent, setRecent] = useState([]);
  const [invited, setInvited] = useState({});
  const [pendingInvites, setPendingInvites] = useState([]);

  const gameIdRef = useRef(null);
  const refreshProfileRef = useRef(refreshProfile);
  refreshProfileRef.current = refreshProfile;

  const reload = useCallback(async (gameId) => {
    const [{ data: g }, { data: ps }] = await Promise.all([
      supabase.from("games").select("*").eq("id", gameId).single(),
      supabase.from("game_players").select(PLAYER_SELECT).eq("game_id", gameId).order("seat"),
    ]);
    if (g) {
      setGame(g);
      // My private hole cards for the current hand (RLS: only my own row).
      if (g.hand_no > 0) {
        const [{ data: hc }, { data: sd }] = await Promise.all([
          supabase.from("hole_cards").select("cards")
            .eq("game_id", gameId).eq("player_id", user.id).eq("hand_no", g.hand_no).maybeSingle(),
          supabase.from("showdowns").select("player_id, cards, hand_rank, won")
            .eq("game_id", gameId).eq("hand_no", g.hand_no),
        ]);
        setMyHole(hc?.cards ?? null);
        setShowdowns(sd ?? []);
      } else {
        setMyHole(null);
        setShowdowns([]);
      }
    }
    if (ps) setPlayers(ps);
  }, [user.id]);

  const loadInvites = useCallback(async (gid) => {
    const { data } = await supabase
      .from("invites")
      .select("invitee:profiles!invites_invitee_fkey(username)")
      .eq("game_id", gid)
      .eq("status", "pending");
    setPendingInvites((data ?? []).map((r) => r.invitee?.username).filter(Boolean));
  }, []);

  useEffect(() => {
    let channel;
    let active = true;

    (async () => {
      const { data: g } = await supabase
        .from("games").select("*").eq("invite_code", upperCode).maybeSingle();
      if (!active) return;
      if (!g) return setPhase("notfound");

      if (g.status === "lobby") {
        try {
          await joinGame(upperCode);
          await refreshProfileRef.current();
        } catch (err) {
          if (!active) return;
          setError(err.message);
          return setPhase("error");
        }
      }
      if (!active) return;
      gameIdRef.current = g.id;

      await reload(g.id);
      loadInvites(g.id);
      if (!active) return;
      setPhase("ready");

      channel = supabase
        .channel(`game:${g.id}`)
        .on("postgres_changes", { event: "*", schema: "public", table: "game_players", filter: `game_id=eq.${g.id}` }, () => reload(g.id))
        .on("postgres_changes", { event: "*", schema: "public", table: "games", filter: `id=eq.${g.id}` }, () => reload(g.id))
        .on("postgres_changes", { event: "INSERT", schema: "public", table: "actions", filter: `game_id=eq.${g.id}` }, () => reload(g.id))
        .on("postgres_changes", { event: "*", schema: "public", table: "hole_cards", filter: `game_id=eq.${g.id}` }, () => reload(g.id))
        .on("postgres_changes", { event: "*", schema: "public", table: "invites", filter: `game_id=eq.${g.id}` }, () => loadInvites(g.id))
        .subscribe();
    })();

    return () => {
      active = false;
      if (channel) supabase.removeChannel(channel);
    };
  }, [upperCode, reload, loadInvites]);

  // Recent co-players for one-tap invites.
  useEffect(() => {
    let active = true;
    (async () => {
      const { data: mine } = await supabase.from("game_players").select("game_id").eq("player_id", user.id);
      const ids = (mine ?? []).map((r) => r.game_id);
      if (!ids.length || !active) return;
      const { data: co } = await supabase
        .from("game_players").select("player_id, profile:profiles(username)")
        .in("game_id", ids).neq("player_id", user.id);
      if (!active) return;
      const seen = new Set();
      const list = [];
      for (const r of co ?? []) {
        if (r.profile?.username && !seen.has(r.player_id)) { seen.add(r.player_id); list.push(r.profile.username); }
      }
      setRecent(list.slice(0, 12));
    })();
    return () => { active = false; };
  }, [user.id]);

  // Safety-net poll + resync on foreground while a table is live.
  useEffect(() => {
    const s = game?.status;
    if (!s || s === "finished" || s === "abandoned") return;
    const id = setInterval(() => { if (gameIdRef.current) reload(gameIdRef.current); }, 3000);
    const onWake = () => document.visibilityState === "visible" && gameIdRef.current && reload(gameIdRef.current);
    document.addEventListener("visibilitychange", onWake);
    window.addEventListener("focus", onWake);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onWake);
      window.removeEventListener("focus", onWake);
    };
  }, [game?.status, reload]);

  async function invite(username) {
    const name = username.trim();
    if (!name) return;
    try {
      const res = await invitePlayer(gameIdRef.current, name);
      setInvited((m) => ({ ...m, [res.invited ?? name]: "sent" }));
      loadInvites(gameIdRef.current);
    } catch (err) {
      setInvited((m) => ({ ...m, [name]: err.message }));
    }
  }

  const shareUrl = `${window.location.origin}/g/${upperCode}`;
  const copy = async (text, setFlag) => {
    try { await navigator.clipboard.writeText(text); setFlag(true); setTimeout(() => setFlag(false), 1500); } catch { /* on screen */ }
  };

  async function deal() {
    setError(""); setDealing(true);
    try {
      await startHand(gameIdRef.current);
      await reload(gameIdRef.current);
    } catch (err) {
      setError(err.message);
    } finally {
      setDealing(false);
    }
  }

  async function doAct(action, amount) {
    setError(""); setBusy(true);
    try {
      await act(gameIdRef.current, action, amount);
      await reload(gameIdRef.current);
    } catch (err) {
      setError(err.message);
      await reload(gameIdRef.current);
    } finally {
      setBusy(false);
    }
  }

  async function doRebuy() {
    setError(""); setBusy(true);
    try {
      await rebuy(gameIdRef.current);
      await refreshProfile();
      await reload(gameIdRef.current);
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }

  async function doEndTable() {
    if (!window.confirm("End the table and settle up? Everyone's chips are cashed out.")) return;
    setError(""); setBusy(true);
    try {
      await endTable(gameIdRef.current);
      await refreshProfile();
      await reload(gameIdRef.current);
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }

  // Start a fresh table with the same settings and re-invite the same group.
  async function playAgain() {
    setError(""); setBusy(true);
    try {
      const res = await createGame({
        mode: game.mode, stake_type: game.stake_type,
        big_blind: game.big_blind, buy_in: game.buy_in,
      });
      const others = players.filter((p) => p.player_id !== user.id && p.profile?.username);
      for (const p of others) {
        try { await invitePlayer(res.game_id, p.profile.username); } catch { /* skip */ }
      }
      await refreshProfile();
      navigate(`/g/${res.invite_code}`);
    } catch (err) { setError(err.message); setBusy(false); }
  }

  async function cancel() {
    if (!window.confirm("Cancel this table for everyone? Chip buy-ins are refunded.")) return;
    setError(""); setBusy(true);
    try {
      await cancelGame(gameIdRef.current);
      await refreshProfile();
      navigate("/");
    } catch (err) { setError(err.message); setBusy(false); }
  }

  async function doLeave() {
    setConfirmLeave(false); setError(""); setBusy(true);
    try {
      await leaveTable(gameIdRef.current);
      await refreshProfile();
      navigate("/");
    } catch (err) { setError(err.message); setBusy(false); }
  }

  /* ---------- render ---------- */
  if (phase === "loading" || phase === "notfound" || phase === "error") {
    const title = phase === "notfound" ? "NO SUCH TABLE" : phase === "error" ? "COULDN'T SIT DOWN" : "TAKING YOUR SEAT…";
    return (
      <Felt>
        <Marquee bottom={title} />
        <Panel title={`Table ${upperCode}`}>
          {phase === "loading" && <p className="hint">Joining table {upperCode}…</p>}
          {phase === "notfound" && <p className="hint">That invite code doesn't match any table.</p>}
          {phase === "error" && <p className="errText">{error}</p>}
          {phase !== "loading" && <button className="ghost" onClick={() => navigate("/")}>BACK TO HOME</button>}
        </Panel>
      </Felt>
    );
  }

  const me = players.find((p) => p.player_id === user.id);
  const isHost = game.created_by === user.id;

  return (
    <Felt>
      <Marquee bottom={`TABLE ${upperCode}`} winner={game.status === "finished" || (game.status === "active" && game.street === "idle")} />

      {game.status === "lobby" && (
        <LobbyView
          code={upperCode} game={game} players={players} meId={user.id}
          shareUrl={shareUrl} copied={copied} onCopy={() => copy(shareUrl, setCopied)}
          copiedCode={copiedCode} onCopyCode={() => copy(upperCode, setCopiedCode)}
          onDeal={deal} dealing={dealing} error={error}
          onCancel={cancel} busy={busy} onHome={() => navigate("/")} onLeave={() => setConfirmLeave(true)}
          recent={recent} invited={invited} onInvite={invite} pendingInvites={pendingInvites}
        />
      )}

      {game.status === "active" && (
        <PlayView
          game={game} players={players} me={me} myHole={myHole} showdowns={showdowns}
          onAct={doAct} onNextHand={deal} onRebuy={doRebuy} onEndTable={doEndTable}
          busy={busy || dealing} isHost={isHost} error={error}
          onHome={() => navigate("/")} onLeave={() => setConfirmLeave(true)}
        />
      )}

      {game.status === "finished" && (
        <FinishedView game={game} players={players} me={me} onHome={() => navigate("/")} busy={busy}
          onPlayAgain={playAgain} isHost={isHost} />
      )}

      {game.status === "abandoned" && (
        <Panel title="Table cancelled">
          <p className="hint">The host cancelled this table.{game.stake_type === "chips" ? " Any chips you bought in are refunded." : ""}</p>
          <button className="ghost" onClick={() => navigate("/")}>← BACK TO HOME</button>
        </Panel>
      )}

      {me && game.status !== "abandoned" && (
        <Chat gameId={game.id} players={players} meId={user.id} meName={me.profile?.username} />
      )}

      {confirmLeave && (
        <div className="overlay" onClick={() => setConfirmLeave(false)}>
          <div className="panel" style={{ maxWidth: 380, width: "100%" }} onClick={(e) => e.stopPropagation()}>
            <div className="panelTitle">Leave table?</div>
            <p className="hint" style={{ marginTop: 0 }}>
              {game.status === "lobby"
                ? "The hand hasn't started, so your buy-in is returned."
                : game.street === "idle"
                  ? "Your chips are cashed out and you leave the table."
                  : "Leaving now folds your hand — your remaining chips are cashed out."}
            </p>
            <button className="bigBtn hot" disabled={busy} onClick={doLeave} style={{ marginTop: 8 }}>YES, LEAVE</button>
            <button className="ghost" onClick={() => setConfirmLeave(false)}>NO, STAY</button>
          </div>
        </div>
      )}
    </Felt>
  );
}
