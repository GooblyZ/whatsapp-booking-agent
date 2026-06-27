import { sendWhatsAppTextMessage, sendWhatsAppInteractiveMessage, type WhatsAppInteractive } from "@/lib/whatsapp";
import { enforceAssistantGender, enforceNeutralVoice } from "@/lib/ai/gender";
import { enforceEmojiCap, enforceLength } from "@/lib/ai/style-fences";
import { buildPromptProfile, type PromptProfile } from "@/lib/ai/prompt-profile";
import { recordWhatsAppSendResult } from "@/lib/integration-health";
import { type DB, saveOutboundMessage } from "./helpers";
import type { AISettings } from "@/types/database";

// ── OUTBOUND TRACEABILITY (observability only — never changes routing/behavior) ──────────────────────
// EVERY customer-visible WhatsApp send goes through this chokepoint, so labeling it HERE guarantees no
// send is untraceable. `source` answers "WHO/WHY did this fire" at a glance in the logs; `reason` adds
// the specific trigger. `unknown` is logged LOUDLY (⚠) so an unlabeled send can never hide.
export type OutboundSource =
  | "ai_turn"          // chat reply produced by Gemini (a customer message triggered it)
  | "deterministic"    // chat reply from a deterministic / continuity / menu path
  | "booking_platform" // booking / cancel / reschedule confirmation (a WEB-PAGE action triggered it)
  | "job_reminder"     // scheduled jobs runner — appointment reminder
  | "job_waitlist"     // scheduled jobs runner — waitlist opportunity
  | "recovery"         // provider-recovery / degraded acknowledgement
  | "dashboard"        // owner/manual send from the dashboard
  | "unknown";         // UNLABELED — should never appear in a normal flow
export interface OutboundTrace { source: OutboundSource; reason?: string; triggerRef?: string }
/** Compact `src=… reason=…` tag for the `[outbound]` line; flags an unlabeled send loudly. Pure. */
export function formatOutboundTrace(t: OutboundTrace): string {
  return `${t.source === "unknown" ? "⚠ " : ""}src=${t.source}${t.reason ? ` reason=${t.reason}` : ""}`;
}

// The owner-settings columns the chokepoint needs to build the PromptProfile. One read, fail-open.
const PROFILE_COLUMNS =
  "assistant_name, assistant_gender, response_length, emoji_usage, custom_instructions, things_to_avoid, language, updated_at";

/** Reads ai_settings and builds the normalized owner PromptProfile (a missing row → safe defaults). */
async function loadProfile(db: DB, businessId: string): Promise<PromptProfile> {
  const { data } = await db.from("ai_settings").select(PROFILE_COLUMNS).eq("business_id", businessId).maybeSingle();
  return buildPromptProfile(data as Partial<AISettings> | null, businessId);
}

/** Assistant SELF-gender enforcement: male/female rewrite, or neutral-voice avoidance. */
function enforceVoice(text: string, profile: PromptProfile): string {
  if (profile.assistantGender === "male" || profile.assistantGender === "female") {
    return enforceAssistantGender(text, profile.assistantGender);
  }
  return enforceNeutralVoice(text); // neutral
}

/** Presentation fences for free PROSE (gender/neutral voice → length → emoji cap). Link-bearing text is
 *  preserved by the length fence (it no-ops when a URL is present).
 *  NOTE (AI Settings Phase 2A): things_to_avoid is owner STYLE guidance, applied via the PERSONA prompt
 *  only — it is intentionally NOT enforced as a hard deterministic filter here. Treating instruction-
 *  phrased guidance ("אל תשתמש במילה מבצע") as literal removal silently no-ops, and a bare common word
 *  ("תור") would get stripped from real replies. A future hard `forbidden_terms` field would re-use
 *  enforceForbiddenPhrases at this point; it stays exported for that. */
function applyTextFences(text: string, profile: PromptProfile): string {
  let out = enforceVoice(text, profile);
  out = enforceLength(out, profile.responseLength);
  out = enforceEmojiCap(out, profile.emojiCap);
  return out;
}

/** Safe profile observability — enums + hash + version ONLY. No text, no phone, no secrets. */
function logProfile(businessId: string, profile: PromptProfile, where: string): void {
  console.log(
    `[outbound] ${where} business=${businessId} profileHash=${profile.promptProfileHash}` +
    ` settingsVersion=${profile.settingsVersion ?? "-"} gender=${profile.assistantGender}` +
    ` emoji=${profile.emojiUsage}(cap${profile.emojiCap}) length=${profile.responseLength}`
  );
}

/**
 * THE single outbound chokepoint, shared by the chat router (flow.ts) and the booking platform.
 * Owner AI PRESENTATION settings apply to EVERY customer-facing message — model-written, guard,
 * deterministic strings, and platform notifications alike (the report's Model-D enforcement layer):
 *   - assistant_gender → male/female rewrite, or NEUTRAL-voice avoidance (FINAL authority over the
 *     assistant's own Hebrew forms; never touches references to the customer).
 *   - emoji_usage → capped to 0 / 1 / 2 (none / low / medium).
 *   - response_length → conservative length cap (URL-safe; never breaks a link/CTA).
 *   - things_to_avoid → owner STYLE guidance, applied via the persona prompt ONLY — not a hard fence here.
 * These are PRESENTATION fences only — they never change routing, booking/manage, grounding,
 * reliability, or deterministic-mode behavior. Fail-open: if settings can't be read, text is sent
 * unmodified.
 */
export async function applyOutboundSettings(db: DB, businessId: string, text: string): Promise<string> {
  try {
    const profile = await loadProfile(db, businessId);
    logProfile(businessId, profile, "text");
    return applyTextFences(text, profile);
  } catch {
    // settings unavailable → send as-is
    return text;
  }
}

/**
 * Sends a WhatsApp message with settings enforcement, health recording, and
 * message persistence. Never throws — messaging-path errors are logged and
 * swallowed (telemetry and notifications must never fail the calling action).
 */
export async function sendOutbound(
  db: DB, businessId: string, customerId: string, toPhone: string, rawText: string,
  trace: OutboundTrace = { source: "unknown" }
): Promise<void> {
  const text = await applyOutboundSettings(db, businessId, rawText);
  let sendStatus: "sent" | "failed" = "sent";
  console.log(`[outbound] ${formatOutboundTrace(trace)} reply → "${text.slice(0, 80)}${text.length > 80 ? "…" : ""}"`);

  const result = await sendWhatsAppTextMessage(toPhone, text);
  if (!result.success) {
    sendStatus = "failed";
    console.error(`[outbound] WhatsApp send failed: ${result.error}`);
  }

  // Integration health: auth failures suspend AI for this business (nothing can
  // be delivered); successes reset the state. Never blocks the message save.
  try {
    await recordWhatsAppSendResult(db, businessId, result);
  } catch (err) {
    console.error("[outbound] failed to record send health:", err instanceof Error ? err.message : String(err));
  }

  // Always save the outbound message regardless of send outcome so no reply is lost. Trace metadata
  // (source/reason + the returned wamid) is persisted durably; saveOutboundMessage falls back to the
  // legacy row if migration 012 isn't applied yet (no message ever dropped).
  try {
    await saveOutboundMessage(db, businessId, customerId, toPhone, text, sendStatus, {
      source: trace.source, reason: trace.reason,
      wamid: result.success ? result.messageId ?? null : null,
      triggerRef: trace.triggerRef ?? null,
    });
  } catch (err) {
    console.error("[outbound] failed to save outbound message:", err instanceof Error ? err.message : String(err));
  }
}

/** Applies PRESENTATION fences to an interactive message. Body gets gender (incl. neutral) + emoji
 *  cap; short button/row titles are platform menu/CTA copy → emoji cap only (no gender drift there,
 *  and the length/forbidden fences are deliberately NOT applied so required menu labels stay intact). */
function applyInteractiveSettings(i: WhatsAppInteractive, profile: PromptProfile): WhatsAppInteractive {
  const body = enforceEmojiCap(enforceVoice(i.body, profile), profile.emojiCap);
  const label = (s: string): string => enforceEmojiCap(s, profile.emojiCap);
  if (i.kind === "buttons") return { kind: "buttons", body, buttons: i.buttons.map((b) => ({ ...b, title: label(b.title) })) };
  if (i.kind === "list") return { kind: "list", body, button: label(i.button), rows: i.rows.map((r) => ({ ...r, title: label(r.title), ...(r.description ? { description: label(r.description) } : {}) })) };
  return { kind: "cta_url", body, buttonText: label(i.buttonText), url: i.url };
}

/**
 * Sends an INTERACTIVE (clickable) WhatsApp message through the same chokepoint — settings
 * enforcement, health recording, persistence — with a guaranteed TEXT FALLBACK: if the
 * interactive send fails (older client, unsupported type, transient error) the customer still
 * gets `fallbackText`, so a menu turn is never silently dropped. Never throws.
 */
export async function sendOutboundInteractive(
  db: DB, businessId: string, customerId: string, toPhone: string,
  interactive: WhatsAppInteractive, fallbackText: string,
  trace: OutboundTrace = { source: "unknown" }
): Promise<void> {
  let profile: PromptProfile | null = null;
  try { profile = await loadProfile(db, businessId); }
  catch { /* settings unavailable → send as-is */ }

  const enforced = profile ? applyInteractiveSettings(interactive, profile) : interactive;
  if (profile) logProfile(businessId, profile, `interactive(${enforced.kind})`);
  console.log(`[outbound] ${formatOutboundTrace(trace)} interactive(${enforced.kind}) → "${enforced.body.slice(0, 60)}${enforced.body.length > 60 ? "…" : ""}"`);
  const result = await sendWhatsAppInteractiveMessage(toPhone, enforced);

  // Health + persistence use the BODY as the saved message text (the durable record).
  try { await recordWhatsAppSendResult(db, businessId, result); }
  catch (err) { console.error("[outbound] failed to record send health:", err instanceof Error ? err.message : String(err)); }

  if (!result.success) {
    // Interactive delivery failed → guarantee a reply via the plain-text fallback (settings enforced inside,
    // and the SAME source is carried so the fallback is traceable too).
    console.warn(`[outbound] interactive send failed (${result.error}) — falling back to text`);
    await sendOutbound(db, businessId, customerId, toPhone, fallbackText, trace);
    return;
  }
  try { await saveOutboundMessage(db, businessId, customerId, toPhone, enforced.body, "sent", {
    source: trace.source, reason: trace.reason,
    wamid: result.messageId ?? null,
    triggerRef: trace.triggerRef ?? null,
  }); }
  catch (err) { console.error("[outbound] failed to save outbound message:", err instanceof Error ? err.message : String(err)); }
}
