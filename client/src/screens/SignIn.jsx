import { useState } from "react";
import { supabase } from "../lib/supabase";
import { Felt, Marquee, Panel } from "../components/Marquee";

// Code-based sign-in: we email a 6-digit code the player types into the app.
// No redirect, so it works the same on phone, desktop, and an installed PWA
// (a magic *link* would open a different browser and break the flow on mobile).
export default function SignIn() {
  const [email, setEmail] = useState("");
  const [stage, setStage] = useState("email"); // email | code
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function sendCode(e) {
    e.preventDefault();
    setError("");
    setBusy(true);
    // emailRedirectTo still lets desktop users click the link if they prefer.
    const { error } = await supabase.auth.signInWithOtp({
      email: email.trim(),
      options: { emailRedirectTo: window.location.origin },
    });
    setBusy(false);
    if (error) setError(error.message);
    else setStage("code");
  }

  async function verify(e) {
    e.preventDefault();
    setError("");
    setBusy(true);
    const { error } = await supabase.auth.verifyOtp({
      email: email.trim(),
      token: code.trim(),
      type: "email",
    });
    setBusy(false);
    if (error) setError(error.message);
    // On success AuthProvider's onAuthStateChange takes over.
  }

  return (
    <Felt>
      <Marquee bottom="SIGN IN TO PLAY" />
      <Panel title="Sign in">
        {stage === "email" ? (
          <form onSubmit={sendCode}>
            <div className="panelSub">Email</div>
            <div className="nameRow">
              <input
                type="email"
                required
                autoComplete="email"
                inputMode="email"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
            {error && <p className="errText">{error}</p>}
            <button className="bigBtn gold" disabled={busy || !email.trim()}>
              {busy ? "SENDING…" : "SEND CODE"}
            </button>
            <p className="hint">We'll email you a sign-in code. No password.</p>
          </form>
        ) : (
          <form onSubmit={verify}>
            <p className="hint" style={{ marginTop: 0 }}>
              Enter the code sent to <b>{email}</b>.
            </p>
            <div className="nameRow">
              <input
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={10}
                placeholder="Enter code"
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                style={{ fontSize: 24, letterSpacing: 5, textAlign: "center" }}
                autoFocus
              />
            </div>
            {error && <p className="errText">{error}</p>}
            <button className="bigBtn gold" disabled={busy || code.length < 6}>
              {busy ? "VERIFYING…" : "SIGN IN"}
            </button>
            <button
              type="button"
              className="ghost"
              style={{ marginTop: 10 }}
              onClick={() => {
                setStage("email");
                setCode("");
                setError("");
              }}
            >
              USE A DIFFERENT EMAIL
            </button>
          </form>
        )}
      </Panel>
    </Felt>
  );
}
