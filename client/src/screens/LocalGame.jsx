import { useNavigate, useSearchParams } from "react-router-dom";
import { Felt, Marquee, Panel } from "../components/Marquee";

// Placeholder for the client-only modes (Phase 6): in-person one-phone pass-and-
// hide, and vs-computer AI. Both run entirely on the device with the same
// poker-logic engine as the server, persisted to localStorage.
export default function LocalGame() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const mode = params.get("mode");
  const label =
    mode === "cpu" ? "Vs the computer" : mode === "inperson" ? "In person" : "Local play";

  return (
    <Felt>
      <Marquee bottom={label.toUpperCase()} />
      <Panel title={label}>
        <p className="hint" style={{ marginTop: 0 }}>
          {mode === "cpu"
            ? "Practice hands against AI opponents on this device."
            : "One phone passed around the table — cards stay private behind a tap."}
        </p>
        <p className="hint">
          This mode arrives in a later session (Phase 6). For now, start an{" "}
          <b>Online</b> table and invite friends by link, code, or username.
        </p>
        <button className="bigBtn green" onClick={() => navigate("/new")}>
          START AN ONLINE TABLE
        </button>
        <button className="ghost" onClick={() => navigate("/")}>← BACK TO HOME</button>
      </Panel>
    </Felt>
  );
}
