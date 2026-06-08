// Browser-side Supabase client.
// Uses the anon key only — safe for client components.
// NEVER use the service role key here.
//
// Type note: add createClient<Database> once you run:
//   npx supabase gen types typescript --project-id <your-project-id> > lib/supabase/types.ts

import { createClient } from "@supabase/supabase-js";

function createPublicClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url) throw new Error("Missing env: NEXT_PUBLIC_SUPABASE_URL");
  if (!anonKey) throw new Error("Missing env: NEXT_PUBLIC_SUPABASE_ANON_KEY");

  return createClient(url, anonKey);
}

let _publicClient: ReturnType<typeof createPublicClient> | null = null;

export function supabaseClient() {
  if (!_publicClient) {
    _publicClient = createPublicClient();
  }
  return _publicClient;
}
