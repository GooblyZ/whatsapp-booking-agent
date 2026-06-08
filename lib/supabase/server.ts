// Server-side Supabase client.
// Uses the service role key — NEVER import this in client components or browser code.
// Safe to use in: API routes, Server Actions, Server Components.
//
// Type note: the generic <Database> is intentionally omitted here until you run:
//   npx supabase gen types typescript --project-id <your-project-id> > lib/supabase/types.ts
// At that point, add `import type { Database } from "./types"` and pass it to createClient<Database>.

import { createClient } from "@supabase/supabase-js";

function createServerClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url) throw new Error("Missing env: NEXT_PUBLIC_SUPABASE_URL");
  if (!serviceRoleKey) throw new Error("Missing env: SUPABASE_SERVICE_ROLE_KEY");

  return createClient(url, serviceRoleKey, {
    auth: {
      // Service role bypasses RLS — no session needed.
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}

// Singleton — avoids creating a new client per request in dev.
let _serverClient: ReturnType<typeof createServerClient> | null = null;

export function supabaseServer() {
  if (!_serverClient) {
    _serverClient = createServerClient();
  }
  return _serverClient;
}
