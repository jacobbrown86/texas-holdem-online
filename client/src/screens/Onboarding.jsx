import { useState } from "react";
import { useAuth } from "../auth/AuthProvider";
import { Felt, Marquee, Panel } from "../components/Marquee";

export default function Onboarding() {
  const { setUsername, signOut } = useAuth();
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const clean = name.trim();
  const valid = clean.length >= 2 && clean.length <= 16;

  async function save(e) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      await setUsername(clean);
    } catch (err) {
      // The username column is unique — surface a friendly "taken" message.
      setError(
        /duplicate|unique/i.test(err.message)
          ? "That name's taken — try another."
          : err.message,
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Felt>
      <Marquee bottom="PICK YOUR NAME" />
      <Panel title="Choose a username">
        <form onSubmit={save}>
          <p className="hint" style={{ marginTop: 0 }}>
            This is how you'll show up at the table. 2–16 characters.
          </p>
          <div className="nameRow">
            <span className="seat">@</span>
            <input
              autoFocus
              maxLength={16}
              placeholder="e.g. RiverRat"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          {error && <p className="errText">{error}</p>}
          <button className="bigBtn gold" disabled={busy || !valid}>
            {busy ? "SAVING…" : "TAKE MY SEAT"}
          </button>
        </form>
        <button className="ghost" style={{ marginTop: 12 }} onClick={signOut}>
          SIGN OUT
        </button>
      </Panel>
    </Felt>
  );
}
