import { createContext, useContext, useEffect, useState, useCallback } from "react";
import { supabase } from "../lib/supabase";

const AuthContext = createContext(null);
export const useAuth = () => useContext(AuthContext);

// A freshly-signed-up user gets an auto-generated username like "player_ab12cd"
// (from the handle_new_user trigger). We treat that as "needs onboarding".
const needsUsername = (profile) =>
  !profile || !profile.username || profile.username.startsWith("player_");

export function AuthProvider({ children }) {
  const [session, setSession] = useState(null);
  const [profile, setProfile] = useState(null);
  const [profileLoaded, setProfileLoaded] = useState(false);
  const [loading, setLoading] = useState(true);

  const loadProfile = useCallback(async (userId) => {
    const { data, error } = await supabase
      .from("profiles")
      .select("id, username, avatar_seed, chips")
      .eq("id", userId)
      .single();
    // Only mark "loaded" on a real answer — a transient network error must NOT
    // flip a returning player into the onboarding screen. (PGRST116 = no row.)
    if (error && error.code !== "PGRST116") return null;
    setProfile(data ?? null);
    setProfileLoaded(true);
    return data;
  }, []);

  useEffect(() => {
    let active = true;

    // getSession() reads the stored session locally (fast). Unblock the UI the
    // moment it resolves and load the profile in the background, so a hung
    // network call can never trap us on the loading screen after resuming.
    supabase.auth.getSession().then(({ data }) => {
      if (!active) return;
      setSession(data.session);
      setLoading(false);
      if (data.session) loadProfile(data.session.user.id);
      else setProfileLoaded(true);
    });

    const { data: sub } = supabase.auth.onAuthStateChange((_event, next) => {
      if (!active) return;
      setSession(next);
      setLoading(false);
      if (next) loadProfile(next.user.id);
      else {
        setProfile(null);
        setProfileLoaded(true);
      }
    });

    // Absolute safety net: never sit on the loading screen.
    const t = setTimeout(() => active && setLoading(false), 5000);

    return () => {
      active = false;
      clearTimeout(t);
      sub.subscription.unsubscribe();
    };
  }, [loadProfile]);

  const setUsername = useCallback(
    async (username) => {
      const { error } = await supabase
        .from("profiles")
        .update({ username })
        .eq("id", session.user.id);
      if (error) throw new Error(error.message);
      await loadProfile(session.user.id);
    },
    [session, loadProfile],
  );

  const signOut = useCallback(() => supabase.auth.signOut(), []);

  // Must be stable: screens depend on it inside effects. An inline arrow here
  // would change identity every render and retrigger those effects in a loop.
  const refreshProfile = useCallback(() => {
    if (session) return loadProfile(session.user.id);
  }, [session, loadProfile]);

  const value = {
    session,
    user: session?.user ?? null,
    profile,
    loading,
    needsOnboarding: Boolean(session) && profileLoaded && needsUsername(profile),
    refreshProfile,
    setUsername,
    signOut,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
