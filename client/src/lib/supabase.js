import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL;
const anon = import.meta.env.VITE_SUPABASE_ANON_KEY;

// True once .env.local is filled in. Until then the app still boots and shows a
// friendly setup banner instead of crashing — handy while wiring up the project.
export const isConfigured = Boolean(url && anon && !url.includes("YOUR-PROJECT"));

export const supabase = isConfigured
  ? createClient(url, anon, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true, // completes the magic-link redirect
      },
    })
  : null;
