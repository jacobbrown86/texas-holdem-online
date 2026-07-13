import { supabase } from "./supabase";

// Thin wrappers over the Edge Functions. Every game mutation goes through one of
// these — the client never writes to game tables directly (RLS forbids it).
// supabase.functions.invoke attaches the caller's auth token automatically.
async function callFn(name, body) {
  const { data, error } = await supabase.functions.invoke(name, { body });
  if (error) {
    // functions.invoke wraps non-2xx as FunctionsHttpError; dig out the JSON message.
    let message = error.message;
    try {
      const parsed = await error.context?.json?.();
      if (parsed?.error) message = parsed.error;
    } catch {
      /* keep the generic message */
    }
    throw new Error(message);
  }
  return data;
}

// ---- Lobby / table lifecycle (built) ----
export const createGame = (opts) => callFn("create-game", opts);
export const joinGame = (invite_code) => callFn("join-game", { invite_code });
export const cancelGame = (game_id) => callFn("cancel-game", { game_id });
export const leaveTable = (game_id) => callFn("leave-table", { game_id });
export const invitePlayer = (game_id, username) => callFn("invite-player", { game_id, username });
export const sendMessage = (game_id, body) => callFn("send-message", { game_id, body });

// ---- Hand play (Phase 3+, wired now so the UI is ready) ----
export const startHand = (game_id) => callFn("start-hand", { game_id });
export const act = (game_id, action, amount) => callFn("act", { game_id, action, amount });
export const advanceStreet = (game_id) => callFn("advance-street", { game_id });
export const rebuy = (game_id) => callFn("rebuy", { game_id });
