// Web Push sender shared by the game functions. Uses the npm web-push library
// (VAPID JWT + payload encryption). Configured from function secrets:
//   VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT (mailto:you@...)
import webpush from "npm:web-push@3.6.7";
import { SupabaseClient } from "npm:@supabase/supabase-js@2";

let ready = false;
function ensureVapid(): boolean {
  if (ready) return true;
  const pub = Deno.env.get("VAPID_PUBLIC_KEY");
  const priv = Deno.env.get("VAPID_PRIVATE_KEY");
  const subject = Deno.env.get("VAPID_SUBJECT") || "mailto:admin@holdem.app";
  if (!pub || !priv) return false;
  webpush.setVapidDetails(subject, pub, priv);
  ready = true;
  return true;
}

export async function sendPushToUser(admin: SupabaseClient, userId: string, payload: unknown) {
  if (!ensureVapid()) {
    console.warn("push: VAPID keys not configured (set VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY)");
    return;
  }
  const { data: subs, error } = await admin
    .from("push_subscriptions").select("*").eq("user_id", userId);
  if (error) {
    console.error("push: could not read subscriptions:", error.message);
    return;
  }
  console.log(`push: ${subs?.length ?? 0} subscription(s) for user ${userId}`);
  for (const s of subs ?? []) {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        JSON.stringify(payload),
      );
      console.log("push: sent ok");
    } catch (e) {
      const err = e as { statusCode?: number; body?: string; message?: string };
      if (err.statusCode === 404 || err.statusCode === 410) {
        await admin.from("push_subscriptions").delete().eq("endpoint", s.endpoint);
        console.log("push: pruned expired subscription");
      } else {
        console.error("push: send failed", err.statusCode, err.body || err.message || String(e));
      }
    }
  }
}

interface TurnGame { id: string; invite_code: string }
interface TurnPlayer { seat: number; player_id: string }

// Notify the player whose turn it now is to act. Safe to fire-and-forget.
export async function notifyTurn(
  admin: SupabaseClient,
  game: TurnGame,
  players: TurnPlayer[],
  seat: number | null,
) {
  if (seat == null) return;
  const p = players.find((x) => x.seat === seat);
  if (!p) return;
  await sendPushToUser(admin, p.player_id, {
    title: "Your turn — Texas Hold'em 🃏",
    body: "It's on you. Tap to act.",
    url: `/g/${game.invite_code}`,
    tag: `turn-${game.id}`,
  });
}
