// supabase/functions/send-message/index.ts
// Inserts a chat message and pushes it to the other players at the table.
import { getCtx, json, corsHeaders } from "../_shared/poker-logic.ts";
import { sendPushToUser } from "../_shared/push.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const ctx = await getCtx(req);
  if (ctx instanceof Response) return ctx;
  const { admin, userId } = ctx;

  const { game_id, body } = await req.json().catch(() => ({}));
  const text = typeof body === "string" ? body.trim() : "";
  if (!game_id || !text || text.length > 500) {
    return json({ error: "game_id and a 1–500 char body required" }, 400);
  }

  const { data: seat } = await admin
    .from("game_players").select("player_id")
    .eq("game_id", game_id).eq("player_id", userId).maybeSingle();
  if (!seat) return json({ error: "You're not at this table" }, 403);

  const { data: msg, error } = await admin
    .from("messages").insert({ game_id, sender: userId, body: text })
    .select("id, sender, body, created_at").single();
  if (error || !msg) return json({ error: "Could not send" }, 500);

  // Push to everyone else at the table (fire-and-forget).
  const [{ data: others }, { data: game }, { data: sender }] = await Promise.all([
    admin.from("game_players").select("player_id").eq("game_id", game_id).neq("player_id", userId),
    admin.from("games").select("invite_code").eq("id", game_id).single(),
    admin.from("profiles").select("username").eq("id", userId).single(),
  ]);
  const payload = {
    title: `${sender?.username ?? "Someone"} — Texas Hold'em 💬`,
    body: text.slice(0, 140),
    url: `/g/${game?.invite_code ?? ""}`,
    tag: `chat-${game_id}`,
  };
  for (const p of others ?? []) {
    // @ts-ignore EdgeRuntime is provided by the Supabase runtime
    EdgeRuntime.waitUntil(sendPushToUser(admin, p.player_id, payload));
  }

  return json(msg);
});
