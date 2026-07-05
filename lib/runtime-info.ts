// lib/runtime-info.ts
// Server-side only. Runtime FINGERPRINT — proves which build/mode/model is actually answering.
//
// Why this exists: live QA is served by the local dev server (ngrok), whose commit and BOOKING_MODE
// were unverifiable — a stale dev server has repeatedly run old code during live tests, making every
// conversation fix unfalsifiable. This module surfaces the truth in two places: the /api/health
// endpoint (readable) and one `[runtime]` log line per process (so it appears in dev.log too).
//
// Pure reads of env / git HEAD. No secrets, no network, never throws.

import { execSync } from "node:child_process";
import { getBookingMode } from "@/lib/config";
import { getGeminiModel } from "@/lib/ai/gemini";

export interface RuntimeInfo {
  /** Short git SHA of the running build, or "unknown" if it can't be determined. */
  commit: string;
  /** Which conversation runtime is live: "platform" (canonical) or "conversational" (legacy). */
  bookingMode: string;
  /** The Gemini model id in effect. */
  model: string;
}

// Resolved once per process: on Vercel the SHA is injected as an env var; on the local dev server
// (no such env) we read git HEAD directly. The git read only ever happens locally (env sha wins on
// Vercel) and is wrapped so a missing/again unavailable git never breaks a health check or a reply.
let cachedCommit: string | null = null;
function commitSha(): string {
  if (cachedCommit !== null) return cachedCommit;
  const envSha = process.env.VERCEL_GIT_COMMIT_SHA || process.env.GIT_COMMIT_SHA;
  if (envSha && envSha.trim()) {
    cachedCommit = envSha.trim().slice(0, 7);
    return cachedCommit;
  }
  try {
    // Local-dev fallback only (this branch never runs on Vercel — env sha wins there).
    cachedCommit =
      execSync("git rev-parse --short HEAD", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() ||
      "unknown";
  } catch {
    cachedCommit = "unknown";
  }
  return cachedCommit;
}

export function getRuntimeInfo(): RuntimeInfo {
  return { commit: commitSha(), bookingMode: getBookingMode(), model: getGeminiModel() };
}

// One structured line per process (grep-friendly, mirrors the other [prefix] lines). Fires on the
// first inbound turn and on the first /api/health hit — whichever comes first.
let logged = false;
export function logRuntimeOnce(): void {
  if (logged) return;
  logged = true;
  const r = getRuntimeInfo();
  console.log(`[runtime] commit=${r.commit} mode=${r.bookingMode} model=${r.model}`);
}
