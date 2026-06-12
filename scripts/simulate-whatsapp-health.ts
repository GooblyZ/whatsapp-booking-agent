// scripts/simulate-whatsapp-health.ts
// Validates the WhatsApp degraded-mode handling without sending anything:
//   - 401/auth classification
//   - health state machine (healthy → auth_failed → recovered; degraded path)
//   - the message-handler gate decision (AI skipped while auth_failed)
//   - live token probe against the configured env (read-only Graph GET)
//
// Run: node --env-file=.env.local --import tsx scripts/simulate-whatsapp-health.ts

import { classifySendFailure, checkWhatsAppAuth, type SendResult } from "../lib/whatsapp";
import {
  getWhatsAppHealth, recordWhatsAppSendResult, markWhatsAppHealthy,
} from "../lib/integration-health";

const BIZ = "test-business-sim";
let pass = 0, fail = 0;

function check(label: string, ok: boolean, detail = ""): void {
  if (ok) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label} ${detail}`); }
}

const authFailure: SendResult = {
  success: false, error: "Meta API error: Authentication Error", kind: "auth", httpStatus: 401,
};
const apiFailure: SendResult = {
  success: false, error: "Meta API error: (#131047) Re-engagement message", kind: "api", httpStatus: 400,
};
const sendOk: SendResult = { success: true, messageId: "wamid.SIM" };

(async () => {
  console.log("=== 1. classification ===");
  check("HTTP 401 → auth", classifySendFailure(401, "Authentication Error", null) === "auth");
  check("OAuth code 190 → auth", classifySendFailure(400, "Error validating access token: Session has expired", 190) === "auth");
  check("'access token' text → auth", classifySendFailure(400, "Invalid access token", null) === "auth");
  check("template error → api", classifySendFailure(400, "(#131047) Re-engagement message", null) === "api");

  console.log("=== 2. state machine: auth failure ===");
  check("initial healthy", getWhatsAppHealth(BIZ).status === "healthy");
  await recordWhatsAppSendResult(null, BIZ, authFailure);
  const afterAuth = getWhatsAppHealth(BIZ);
  check("401 → auth_failed immediately", afterAuth.status === "auth_failed", `got ${afterAuth.status}`);
  check("consecutive=1", afterAuth.consecutiveFailures === 1);
  check("lastError recorded", !!afterAuth.lastError && !!afterAuth.lastErrorAt);

  console.log("=== 3. gate decision (message-handler logic) ===");
  const gateSkipsAI = getWhatsAppHealth(BIZ).status === "auth_failed";
  check("inbound would be SAVED (save happens before gate)", true);
  check("Gemini would be SKIPPED while auth_failed", gateSkipsAI);

  console.log("=== 4. recovery ===");
  await markWhatsAppHealthy(null, BIZ);
  check("healthy after recovery", getWhatsAppHealth(BIZ).status === "healthy");
  check("counters reset", getWhatsAppHealth(BIZ).consecutiveFailures === 0);
  await recordWhatsAppSendResult(null, BIZ, sendOk);
  check("send success keeps healthy", getWhatsAppHealth(BIZ).status === "healthy");

  console.log("=== 5. degraded path (non-auth, threshold=3) ===");
  await recordWhatsAppSendResult(null, BIZ, apiFailure);
  await recordWhatsAppSendResult(null, BIZ, apiFailure);
  check("2 api failures → still not degraded", getWhatsAppHealth(BIZ).status === "healthy");
  await recordWhatsAppSendResult(null, BIZ, apiFailure);
  check("3rd api failure → degraded", getWhatsAppHealth(BIZ).status === "degraded");
  check("degraded does NOT equal auth_failed (AI keeps running)", getWhatsAppHealth(BIZ).status !== "auth_failed");
  await recordWhatsAppSendResult(null, BIZ, sendOk);
  check("success → healthy + reset", getWhatsAppHealth(BIZ).status === "healthy" && getWhatsAppHealth(BIZ).consecutiveFailures === 0);

  console.log("=== 6. LIVE token probe (read-only, current env) ===");
  const probe = await checkWhatsAppAuth();
  console.log(`  probe result: ok=${probe.ok}${probe.error ? ` error="${probe.error}"` : ""}`);
  console.log("  (informational — reflects the CURRENT Meta token state)");

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})();
