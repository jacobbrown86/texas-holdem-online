// supabase/functions/invite-player/index.ts
// Host invites a known player (by username) to their lobby table. The invitee
// sees it on their Home screen and can join.
import { getCtx, json, corsHeaders, loadGame } from "../_shared/poker-logic.ts";
import { sendPushToUser } from "../_shared/push.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const ctx = await getCtx(req);
  if (ctx instanceof Response) return ctx;
  const { admin, userId } = ctx;

  const { game_id, username } = await req.json().catch(() => ({}));
  if (!game_id || !username) return json({ error: "game_id and username required" }, 400);

  const { game, players } = await loadGame(admin, game_id);
  if (!game) return json({ error: "Table not found" }, 404);
  if (game.created_by !== userId) return json({ error: "Only the host can invite" }, 403);
  if (game.status !== "lobby") return json({ error: "Table already started" }, 409);
  if (players.length >= 10) return json({ error: "Table is full" }, 409);

  const { data: prof } = await admin
    .from("profiles").select("id, username")
    .ilike("username", String(username).trim())
    .maybeSingle();
  if (!prof) return json({ error: "No player with that username" }, 404);
  if (prof.id === userId) return json({ error: "That's you" }, 409);
  if (players.some((p) => p.player_id === prof.id)) return json({ error: "Already seated" }, 409);

  const { error } = await admin.from("invites").upsert(
    { game_id, inviter: userId, invitee: prof.id, status: "pending" },
    { onConflict: "game_id,invitee" },
  );
  if (error) return json({ error: "Could not send invite" }, 500);

  // Notify the invitee (if they have notifications on).
  const { data: inviter } = await admin.from("profiles").select("username").eq("id", userId).single();
  // @ts-ignore EdgeRuntime provided by the Supabase runtime
  EdgeRuntime.waitUntil(sendPushToUser(admin, prof.id, {
    title: "You're invited — Texas Hold'em 🃏",
    body: `${inviter?.username ?? "Someone"} invited you to a table.`,
    url: `/g/${game.invite_code}`,
    tag: `invite-${game.id}`,
  }));

  return json({ invited: prof.username });
});
