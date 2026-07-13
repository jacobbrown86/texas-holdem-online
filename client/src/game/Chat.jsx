import { useEffect, useRef, useState, useCallback } from "react";
import { supabase } from "../lib/supabase";
import { sendMessage } from "../lib/api";

// Floating table chat for a game: a 💬 button (with unread badge) that opens a
// pop-up panel. Messages are realtime; typing "@" tags a player by username.
export default function Chat({ gameId, players, meId, meName }) {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState([]);
  const [text, setText] = useState("");
  const [unread, setUnread] = useState(0);
  const listRef = useRef(null);
  const openRef = useRef(open);
  openRef.current = open;

  const nameOf = useCallback(
    (id) => players.find((p) => p.player_id === id)?.profile?.username ?? "player",
    [players],
  );

  useEffect(() => {
    let active = true;
    (async () => {
      const { data } = await supabase
        .from("messages")
        .select("id, sender, body, created_at")
        .eq("game_id", gameId)
        .order("id")
        .limit(100);
      if (active && data) setMessages(data);
    })();

    const ch = supabase
      .channel(`chat:${gameId}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "messages", filter: `game_id=eq.${gameId}` },
        (payload) => {
          setMessages((m) => (m.some((x) => x.id === payload.new.id) ? m : [...m, payload.new]));
          if (!openRef.current && payload.new.sender !== meId) setUnread((u) => u + 1);
        },
      )
      .subscribe();

    return () => {
      active = false;
      supabase.removeChannel(ch);
    };
  }, [gameId, meId]);

  // Poll for new messages as a safety net (mirrors the game sync) so chat and the
  // unread badge work even when the realtime socket isn't delivering.
  const maxIdRef = useRef(0);
  useEffect(() => {
    maxIdRef.current = messages.reduce((mx, m) => Math.max(mx, m.id), 0);
  }, [messages]);
  useEffect(() => {
    const iv = setInterval(async () => {
      const { data } = await supabase
        .from("messages")
        .select("id, sender, body, created_at")
        .eq("game_id", gameId)
        .gt("id", maxIdRef.current)
        .order("id");
      if (!data || !data.length) return;
      setMessages((m) => {
        const have = new Set(m.map((x) => x.id));
        const add = data.filter((d) => !have.has(d.id));
        if (!add.length) return m;
        if (!openRef.current) {
          const fromOthers = add.filter((d) => d.sender !== meId).length;
          if (fromOthers) setUnread((u) => u + fromOthers);
        }
        return [...m, ...add];
      });
    }, 4000);
    return () => clearInterval(iv);
  }, [gameId, meId]);

  useEffect(() => {
    if (!open) return;
    setUnread(0);
    requestAnimationFrame(() => {
      if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
    });
  }, [open, messages]);

  async function send(e) {
    e.preventDefault();
    const body = text.trim();
    if (!body) return;
    setText("");
    // Goes through the send-message function so it can also push-notify the
    // other players. Show my own message immediately from the response; the
    // realtime/poll echo is deduped by id below.
    try {
      const data = await sendMessage(gameId, body);
      if (data) setMessages((m) => (m.some((x) => x.id === data.id) ? m : [...m, data]));
    } catch {
      setText(body); // restore so they can retry
    }
  }

  // @mention autocomplete on the trailing "@partial".
  const match = /@(\w*)$/.exec(text);
  const suggestions = match
    ? players
        .map((p) => p.profile?.username)
        .filter((u) => u && u.toLowerCase().startsWith(match[1].toLowerCase()) && u !== meName)
        .slice(0, 5)
    : [];
  const pick = (u) => setText((t) => t.replace(/@(\w*)$/, `@${u} `));

  const renderBody = (body) =>
    body.split(/(@\w+)/g).map((part, i) =>
      /^@\w+$/.test(part) ? (
        <b
          key={i}
          className={"mention" + (part.slice(1).toLowerCase() === (meName || "").toLowerCase() ? " me" : "")}
        >
          {part}
        </b>
      ) : (
        <span key={i}>{part}</span>
      ),
    );

  return (
    <>
      <button className="chatFab" onClick={() => setOpen(true)} aria-label="Open chat">
        💬{unread > 0 && <span className="chatBadge">{unread}</span>}
      </button>
      {open && (
        <div className="chatOverlay" onClick={() => setOpen(false)}>
          <div className="chatPanel" onClick={(e) => e.stopPropagation()}>
            <div className="chatHead">
              <span>TABLE CHAT</span>
              <button className="chatX" onClick={() => setOpen(false)} aria-label="Close chat">
                ✕
              </button>
            </div>
            <div className="chatList" ref={listRef}>
              {messages.length === 0 && <p className="hint">No messages yet. Say hi 👋</p>}
              {messages.map((m) => (
                <div key={m.id} className={"chatMsg" + (m.sender === meId ? " mine" : "")}>
                  <span className="chatFrom">{nameOf(m.sender)}</span>
                  <span className="chatBody">{renderBody(m.body)}</span>
                </div>
              ))}
            </div>
            {suggestions.length > 0 && (
              <div className="chatSug">
                {suggestions.map((u) => (
                  <button key={u} type="button" onClick={() => pick(u)}>
                    @{u}
                  </button>
                ))}
              </div>
            )}
            <form className="chatInput" onSubmit={send}>
              <input
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder="Message… type @ to tag"
                maxLength={500}
                autoComplete="off"
              />
              <button className="mini gold" style={{ width: "auto", padding: "0 14px" }} disabled={!text.trim()}>
                SEND
              </button>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
