import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { createGame } from "../lib/api";
import { useAuth } from "../auth/AuthProvider";
import { Felt, Marquee, Panel } from "../components/Marquee";

// The "stake" is the big blind. The small blind is derived server-side (half,
// rounded down, min 1). Buy-in is a multiple of the big blind (the starting stack).
const BLIND_OPTIONS = [2, 5, 10, 20, 50, 100];
const BUYIN_MULTIPLES = [50, 100, 200];

function Segment({ options, value, onChange }) {
  return (
    <div className="toggleRow">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          className={"toggle" + (value === o.value ? " on" : "")}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export default function NewGame() {
  const navigate = useNavigate();
  const { profile, refreshProfile } = useAuth();
  const [mode, setMode] = useState("async");
  const [stakeType, setStakeType] = useState("chips");
  const [bigBlind, setBigBlind] = useState(10);
  const [buyInMult, setBuyInMult] = useState(100);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const smallBlind = Math.max(1, Math.floor(bigBlind / 2));
  const buyIn = bigBlind * buyInMult;
  const notEnough = stakeType === "chips" && profile && profile.chips < buyIn;

  async function deal() {
    setError("");
    setBusy(true);
    try {
      const res = await createGame({
        mode,
        stake_type: stakeType,
        big_blind: bigBlind,
        buy_in: buyIn,
      });
      await refreshProfile();
      navigate(`/g/${res.invite_code}`);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <Felt>
      <Marquee bottom="NEW TABLE" />

      <Panel title="Speed">
        <Segment
          value={mode}
          onChange={setMode}
          options={[
            { value: "live", label: "Live" },
            { value: "async", label: "Async" },
          ]}
        />
        <p className="hint">
          {mode === "live"
            ? "Everyone at the table at once, 60-second turns."
            : "Take your turn whenever — like Words with Friends."}
        </p>
      </Panel>

      <Panel title="Stakes">
        <Segment
          value={stakeType}
          onChange={setStakeType}
          options={[
            { value: "chips", label: "Chips" },
            { value: "ledger", label: "Ledger" },
            { value: "none", label: "For fun" },
          ]}
        />
        <p className="hint">
          {stakeType === "chips" && "Virtual chips only. No real money, ever."}
          {stakeType === "ledger" && "Track who's up or down; settle privately off-app."}
          {stakeType === "none" && "Pure bragging rights — no balances tracked."}
        </p>
      </Panel>

      <Panel title="Blinds" sub={`· small blind $${smallBlind}`}>
        <div className="chips">
          {BLIND_OPTIONS.map((v) => (
            <button
              key={v}
              type="button"
              className={"chip" + (bigBlind === v ? " sel" : "")}
              onClick={() => setBigBlind(v)}
            >
              ${v}
            </button>
          ))}
        </div>
        <p className="hint">Big blind is the table stake. Small blind is half.</p>
      </Panel>

      <Panel title="Buy-in" sub={`· starting stack $${buyIn}`}>
        <Segment
          value={buyInMult}
          onChange={setBuyInMult}
          options={BUYIN_MULTIPLES.map((m) => ({ value: m, label: `${m}×BB` }))}
        />
        {stakeType === "chips" && (
          <p className="potPreview">
            Your balance: <b>{profile?.chips ?? "—"}</b> chips
            {notEnough && <span className="errText"> — not enough for this buy-in</span>}
          </p>
        )}
      </Panel>

      {error && <p className="errText">{error}</p>}

      <button className="bigBtn green" disabled={busy || notEnough} onClick={deal}>
        {busy ? "DEALING…" : "CREATE TABLE"}
      </button>
      <button className="ghost" onClick={() => navigate("/")}>
        CANCEL
      </button>
    </Felt>
  );
}
