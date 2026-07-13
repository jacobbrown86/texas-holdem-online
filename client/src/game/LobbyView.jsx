import { useState } from "react";
import { Panel } from "../components/Marquee";

// The lobby phase: invite link, seats filling live, host START HAND button.
export default function LobbyView({
  code, game, players, meId, shareUrl, copied, onCopy, copiedCode, onCopyCode,
  onDeal, dealing, error, onCancel, busy, onHome, onLeave,
  recent = [], invited = {}, onInvite, pendingInvites = [],
}) {
  const [nameInput, setNameInput] = useState("");
  const isHost = game?.created_by === meId;
  // Invited but not yet seated.
  const waiting = pendingInvites.filter(
    (u) => !players.some((p) => p.profile?.username?.toLowerCase() === u.toLowerCase()),
  );
  const canDeal = isHost && players.length >= 2;
  const seatCount = Math.max(players.length + 1, 2);
  const stakes =
    game?.stake_type === "none"
      ? "for fun"
      : `${game?.small_blind}/${game?.big_blind} · ${game?.stake_type}`;

  return (
    <>
      <div className="rail">
        <div className="potBox">
          <span className="potLbl">BLINDS</span>
          <span className="potAmt">
            {game?.small_blind}/{game?.big_blind}
          </span>
        </div>
        <div className="leaders">
          <div className="leader">
            <span className="ldName">
              {game?.mode} · {stakes}
            </span>
          </div>
          <div className="leader">
            <span className="ldName">
              buy-in ${game?.buy_in} · {players.length}/10 seated
            </span>
          </div>
        </div>
      </div>

      <Panel title="Invite">
        <div className="shareRow">
          <input readOnly value={shareUrl} onFocus={(e) => e.target.select()} />
          <button className="mini gold" onClick={onCopy} style={{ width: "auto", padding: "0 12px" }}>
            {copied ? "✓" : "LINK"}
          </button>
          <button className="mini gold" onClick={onCopyCode} style={{ width: "auto", padding: "0 12px" }}>
            {copiedCode ? "✓" : "CODE"}
          </button>
        </div>
        <p className="hint">
          Code <b>{code}</b> — copy the link or just the code. Seats fill in live as friends join.
        </p>
      </Panel>

      {isHost && (
        <Panel title="Invite players">
          <form
            className="shareRow"
            onSubmit={(e) => {
              e.preventDefault();
              onInvite(nameInput);
              setNameInput("");
            }}
          >
            <input
              value={nameInput}
              onChange={(e) => setNameInput(e.target.value)}
              placeholder="Invite by username"
              autoCapitalize="none"
            />
            <button className="mini gold" style={{ width: "auto", padding: "0 14px" }} disabled={busy || !nameInput.trim()}>
              INVITE
            </button>
          </form>
          {waiting.length > 0 && (
            <>
              <div className="panelSub">Invited — waiting to join</div>
              <div className="savedNames">
                {waiting.map((u) => (
                  <span key={u} className="invitePill" style={{ cursor: "default", opacity: 0.85 }}>
                    @{u} ⏳
                  </span>
                ))}
              </div>
            </>
          )}
          {recent.length > 0 && (
            <>
              <div className="panelSub">Recent players — tap to invite</div>
              <div className="savedNames">
                {recent.map((u) => (
                  <button
                    key={u}
                    type="button"
                    className="invitePill"
                    onClick={() => onInvite(u)}
                    disabled={invited[u] === "sent"}
                  >
                    {invited[u] === "sent" ? `✓ ${u}` : `+ ${u}`}
                  </button>
                ))}
              </div>
            </>
          )}
          {Object.entries(invited)
            .filter(([, s]) => s !== "sent")
            .map(([u, s]) => (
              <p key={u} className="errText">
                {u}: {s}
              </p>
            ))}
          <p className="hint">Invited players see it on their home screen. Sharing the link works too.</p>
        </Panel>
      )}

      <Panel title="Seats">
        {Array.from({ length: 10 }, (_, i) => {
          const p = players.find((x) => x.seat === i);
          if (p) {
            return (
              <div className="nameRow" key={i}>
                <span className="seat">{i}</span>
                <span className="playerName">
                  {p.profile?.username ?? "player"}
                  {p.player_id === meId && " (you)"}
                  {game?.created_by === p.player_id && " · host"}
                </span>
                <span className="ldPts">${p.stack}</span>
              </div>
            );
          }
          return i < seatCount ? (
            <div className="nameRow emptySeat" key={i}>
              <span className="seat dim">{i}</span>
              <span className="playerName dim">empty seat…</span>
            </div>
          ) : null;
        })}
      </Panel>

      {error && <p className="errText">{error}</p>}

      {isHost ? (
        <>
          <button
            className={"bigBtn " + (canDeal ? "green" : "slate")}
            disabled={!canDeal || dealing}
            onClick={onDeal}
          >
            {dealing ? "DEALING…" : players.length < 2 ? "WAITING FOR PLAYERS…" : "START HAND"}
          </button>
          <p className="hint">
            You're the host. Start the hand once at least 2 are seated (up to 10).
          </p>
          <button className="ghost" onClick={onCancel} disabled={busy}>CANCEL TABLE</button>
        </>
      ) : (
        <>
          <p className="finalBanner">WAITING FOR HOST TO DEAL</p>
          <button className="ghost" onClick={onLeave} disabled={busy}>
            LEAVE TABLE
          </button>
        </>
      )}

      <button className="ghost" onClick={onHome}>← BACK TO HOME</button>
    </>
  );
}
