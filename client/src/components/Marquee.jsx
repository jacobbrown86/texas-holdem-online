// The casino marquee header, ported from Snake Eyes. Wraps every screen so the
// green-felt table framing stays consistent across the app.
export function Felt({ children }) {
  return (
    <div className="app">
      <div className="felt">{children}</div>
    </div>
  );
}

export function Marquee({ top = "SOUTHERN CROSS", bottom = "NO-LIMIT HOLD'EM", winner = false }) {
  return (
    <div className={"marquee" + (winner ? " winner" : "")}>
      <span className="marqTop">{top}</span>
      <h1>TEXAS HOLD'EM</h1>
      <span className="marqBot">{bottom}</span>
    </div>
  );
}

export function Panel({ title, sub, children }) {
  return (
    <div className="panel">
      {title && (
        <div className="panelTitle">
          {title}
          {sub && <span className="potInline"> {sub}</span>}
        </div>
      )}
      {children}
    </div>
  );
}
