// lib/jobs/auth.ts
// Server-side only. PURE — no env reads, no I/O, no logging (so it never leaks a secret).
//
// Shared authorization for the jobs runner (POST /api/jobs/process manual trigger, and the Vercel
// Cron GET invocation). The handler passes in the request's Authorization header and the list of
// secrets that are ACCEPTED for that method; this decides the outcome deterministically.

/** "disabled" = NO accepted secret is configured (fail-closed: runner is off, 503).
 *  "unauthorized" = a secret IS configured but the Bearer token doesn't match (401).
 *  "ok" = the token matches one configured secret. */
export type JobAuth = "ok" | "unauthorized" | "disabled";

/**
 * Authorizes a jobs-runner request. `accepted` is the list of secrets valid for this method (e.g.
 * [JOBS_SECRET] for the manual POST; [CRON_SECRET, JOBS_SECRET] for the cron GET) — undefined/empty
 * entries (unset env vars) are ignored. FAIL-CLOSED: if none of the accepted secrets is configured,
 * the runner is "disabled" rather than open. Constant-form Bearer match; never logs the token.
 */
export function authorizeJobRequest(authHeader: string | null, accepted: Array<string | undefined>): JobAuth {
  const secrets = accepted.filter((s): s is string => typeof s === "string" && s.length > 0);
  if (secrets.length === 0) return "disabled";
  return secrets.some((s) => authHeader === `Bearer ${s}`) ? "ok" : "unauthorized";
}
