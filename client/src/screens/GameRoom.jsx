import { useEffect, useState, useCallback, useRef } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { supabase } from "../lib/supabase";
import {
  createGame, joinGame, startHand, cancelGame, leaveTable, invitePlayer,
} from "../lib/api";
import { useAuth } from "../auth/AuthProvider";
import { Felt, Marquee, Panel } from "../components/Marquee";
import LobbyView from "../game/LobbyView";
import Chat from "../game/Chat";

const PLAYER_SELECT =
  "seat, stack, status, player_id, profile:profiles(username, avatar_seed)";

export default function GameRoom() {
  const { code } = useParams();
  const upperCode = (code ?? "").toUpperCase();
  const navigate = useNavigate();
  const { user, refreshProfile } = useAuth();

  const [game, setGame] = useState(null);
  const [players, setPlayers] = useState([]);
  const [phase, setPhase] = useState("loading"); // loading | ready | notfound | error
  const [error, setError] = useState("");
  const [dealing, setDealing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copiedCode, setCopiedCode] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [recent, setRecent] = useState([]); // usernames I've played with before
  const [invited, setInvited] = useState({}); // username -> "sent" | error message
  const [pendingInvites, setPendingInvites] = useState([]); // usernames invited to this game

  const gameIdRef = useRef(null);
  const refreshProfileRef = useRef(refreshProfile);
  refreshProfileRef.current = refreshProfile;

  const reload = useCallback(async (gameId) => {
    const [{ data: g }, { data: ps }] = await Promise.all([
      supabase.from("games").select("*").eq("id", gameId).single(),
      supabase.from("game_players").select(PLAYER_SELECT).eq("game_id", gameId).order("seat"),
    ]);
    if (g) setGame(g);
    if (ps) setPlayers(ps);
  }, []);

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
        .on("postgres_changes",
          { event: "*", schema: "public", table: "game_players", filter: `game_id=eq.${g.id}` },
          () => reload(g.id))
        .on("postgres_changes",
          { event: "*", schema: "public", table: "games", filter: `id=eq.${g.id}` },
          () => reload(g.id))
        .on("postgres_changes",
          { event: "*", schema: "public", table: "invites", filter: `game_id=eq.${g.id}` },
          () => loadInvites(g.id))
        .subscribe();
    })();

    return () => {
      active = false;
      if (channel) supabase.removeChannel(channel);
    };
  }, [upperCode, reload, loadInvites]);

  // People I've played with before, for one-tap invites in the lobby.
  useEffect(() => {
    let active = true;
    (async () => {
      const { data: mine } = await supabase
        .from("game_players").select("game_id").eq("player_id", user.id);
      const ids = (mine ?? []).map((r) => r.game_id);
      if (!ids.length || !active) return;
      const { data: co } = await supabase
        .from("game_players")
        .select("player_id, profile:profiles(username)")
        .in("game_id", ids)
        .neq("player_id", user.id);
      if (!active) return;
      const seen = new Set();
      const list = [];
      for (const r of co ?? []) {
        if (r.profile?.username && !seen.has(r.player_id)) {
          seen.add(r.player_id);
          list.push(r.profile.username);
        }
      }
      setRecent(list.slice(0, 12));
    })();
    return () => {
      active = false;
    };
  }, [user.id]);

  // Safety-net sync while the table is live (phones drop the realtime socket).
  useEffect(() => {
    const s = game?.status;
    if (!s || s === "finished" || s === "abandoned") return;
    const id = setInterval(() => {
      if (gameIdRef.current) reload(gameIdRef.current);
    }, 3000);
    return () => clearInterval(id);
  }, [game?.status, reload]);

  // Resync when the app returns to the foreground.
  useEffect(() => {
    const onWake = () => {
      if (document.visibilityState === "visible" && gameIdRef.current) reload(gameIdRef.current);
    };
    document.addEventListener("visibilitychange", onWake);
    window.addEventListener("focus", onWake);
    window.addEventListener("pageshow", onWake);
    return () => {
      document.removeEventListener("visibilitychange", onWake);
      window.removeEventListener("focus", onWake);
      window.removeEventListener("pageshow", onWake);
    };
  }, [reload]);

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

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked — link is on screen */
    }
  }

  async function copyCode() {
    try {
      await navigator.clipboard.writeText(upperCode);
      setCopiedCode(true);
      setTimeout(() => setCopiedCode(false), 1500);
    } catch {
      /* clipboard blocked — code is on screen */
    }
  }

  async function deal() {
    setError(""); setDealing(true);
    try {
      await startHand(gameIdRef.current);
      await reload(gameIdRef.current);
    } catch (err) {
      // start-hand is built next session (Phase 3). Until then, surface a clear note.
      setError(
        /not found|Failed to send|non-2xx/i.test(err.message)
          ? "Dealing is built next session (Phase 3). The lobby is fully working — seats and buy-ins are live."
          : err.message,
      );
    } finally {
      setDealing(false);
    }
  }

  async function cancel() {
    if (!window.confirm("Cancel this table for everyone? Chip buy-ins are refunded.")) return;
    setError(""); setBusy(true);
    try {
      await cancelGame(gameIdRef.current);
      await refreshProfile();
      navigate("/");
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  async function doLeave() {
    setConfirmLeave(false);
    setError(""); setBusy(true);
    try {
      await leaveTable(gameIdRef.current);
      await refreshProfile();
      navigate("/");
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
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
          {phase !== "loading" && (
            <button className="ghost" onClick={() => navigate("/")}>BACK TO HOME</button>
          )}
        </Panel>
      </Felt>
    );
  }

  const me = players.find((p) => p.player_id === user.id);
  const inPlay = game.status === "active";

  return (
    <Felt>
      <Marquee bottom={`TABLE ${upperCode}`} winner={game.status === "finished"} />

      {game.status === "lobby" && (
        <LobbyView
          code={upperCode} game={game} players={players} meId={user.id}
          shareUrl={shareUrl} copied={copied} onCopy={copyLink}
          copiedCode={copiedCode} onCopyCode={copyCode}
          onDeal={deal} dealing={dealing} error={error}
          onCancel={cancel} busy={busy} onHome={() => navigate("/")} onLeave={() => setConfirmLeave(true)}
          recent={recent} invited={invited} onInvite={invite} pendingInvites={pendingInvites}
        />
      )}

      {inPlay && (
        <Panel title="Hand in progress">
          <p className="hint">
            The dealing and betting engine arrives next session (Phase 3). This lobby
            is the milestone for today — seats fill live and buy-ins are deducted.
          </p>
          <button className="ghost" onClick={() => navigate("/")}>← BACK TO HOME</button>
        </Panel>
      )}

      {game.status === "abandoned" && (
        <Panel title="Table cancelled">
          <p className="hint">
            The host cancelled this table.
            {game.stake_type === "chips" ? " Any chips you bought in are refunded." : ""}
          </p>
          <button className="ghost" onClick={() => navigate("/")}>← BACK TO HOME</button>
        </Panel>
      )}

      {game.status === "finished" && (
        <Panel title="Table finished">
          <p className="hint">This table has wrapped up.</p>
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
              The hand hasn't started, so your buy-in is returned.
            </p>
            <button className="bigBtn hot" disabled={busy} onClick={doLeave} style={{ marginTop: 8 }}>
              YES, LEAVE
            </button>
            <button className="ghost" onClick={() => setConfirmLeave(false)}>
              NO, STAY
            </button>
          </div>
        </div>
      )}
    </Felt>
  );
}
