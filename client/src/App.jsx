import { Routes, Route, Navigate } from "react-router-dom";
import { isConfigured } from "./lib/supabase";
import { AuthProvider, useAuth } from "./auth/AuthProvider";
import { Felt, Marquee } from "./components/Marquee";
import SignIn from "./screens/SignIn";
import Onboarding from "./screens/Onboarding";
import Home from "./screens/Home";
import NewGame from "./screens/NewGame";
import GameRoom from "./screens/GameRoom";
import LocalGame from "./screens/LocalGame";

function SetupNotice() {
  return (
    <Felt>
      <Marquee bottom="SETUP REQUIRED" />
      <div className="panel">
        <div className="panelTitle">Almost there</div>
        <p className="hint">
          The app booted, but it can't reach Supabase yet. Copy{" "}
          <code>.env.local.example</code> to <code>.env.local</code> and fill in your{" "}
          <code>VITE_SUPABASE_URL</code> and <code>VITE_SUPABASE_ANON_KEY</code>, then
          restart the dev server.
        </p>
      </div>
    </Felt>
  );
}

function Gate() {
  const { loading, session, needsOnboarding } = useAuth();

  if (loading) {
    return (
      <Felt>
        <Marquee bottom="SHUFFLING UP…" />
        <div className="panel">
          <p className="hint">Loading…</p>
          <button className="ghost" onClick={() => window.location.reload()}>
            ↻ RELOAD
          </button>
        </div>
      </Felt>
    );
  }

  if (!session) return <SignIn />;
  if (needsOnboarding) return <Onboarding />;

  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/new" element={<NewGame />} />
      <Route path="/local" element={<LocalGame />} />
      <Route path="/g/:code" element={<GameRoom />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export default function App() {
  if (!isConfigured) return <SetupNotice />;
  return (
    <AuthProvider>
      <Gate />
    </AuthProvider>
  );
}
