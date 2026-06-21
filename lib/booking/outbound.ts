import { sendWhatsAppTextMessage, sendWhatsAppInteractiveMessage, type WhatsAppInteractive } from "@/lib/whatsapp";
import { enforceAssistantGender, enforceNeutralVoice } from "@/lib/ai/gender";
import { enforceEmojiCap, enforceLength, enforceForbiddenPhrases } from "@/lib/ai/style-fences";
import { buildPromptProfile, type PromptProfile } from "@/lib/ai/prompt-profile";
import { recordWhatsAppSendResult } from "@/lib/integration-health";
import { type DB, saveOutboundMessage } from "./helpers";
import type { AISettings } from "@/types/database";

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

/** FULL presentation fences for free PROSE (gender → forbidden → length → emoji cap). Link-bearing
 *  text is preserved by the length/forbidden fences themselves (they no-op when a URL is present). */
function applyTextFences(text: string, profile: PromptProfile): string {
  let out = enforceVoice(text, profile);
  out = enforceForbiddenPhrases(out, profile.thingsToAvoid);
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
 *   - things_to_avoid → owner forbidden phrases removed (never strips links/required platform text).
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
  db: DB, businessId: string, customerId: string, toPhone: string, rawText: string
): Promise<void> {
  const text = await applyOutboundSettings(db, businessId, rawText);
  let sendStatus: "sent" | "failed" = "sent";
  console.log(`[outbound] reply → "${text.slice(0, 80)}${text.length > 80 ? "…" : ""}"`);

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

  // Always save the outbound message regardless of send outcome so no reply is lost.
  try {
    await saveOutboundMessage(db, businessId, customerId, toPhone, text, sendStatus);
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
  interactive: WhatsAppInteractive, fallbackText: string
): Promise<void> {
  let profile: PromptProfile | null = null;
  try { profile = await loadProfile(db, businessId); }
  catch { /* settings unavailable → send as-is */ }

  const enforced = profile ? applyInteractiveSettings(interactive, profile) : interactive;
  if (profile) logProfile(businessId, profile, `interactive(${enforced.kind})`);
  console.log(`[outbound] interactive(${enforced.kind}) → "${enforced.body.slice(0, 60)}${enforced.body.length > 60 ? "…" : ""}"`);
  const result = await sendWhatsAppInteractiveMessage(toPhone, enforced);

  // Health + persistence use the BODY as the saved message text (the durable record).
  try { await recordWhatsAppSendResult(db, businessId, result); }
  catch (err) { console.error("[outbound] failed to record send health:", err instanceof Error ? err.message : String(err)); }

  if (!result.success) {
    // Interactive delivery failed → guarantee a reply via the plain-text fallback (settings enforced inside).
    console.warn(`[outbound] interactive send failed (${result.error}) — falling back to text`);
    await sendOutbound(db, businessId, customerId, toPhone, fallbackText);
    return;
  }
  try { await saveOutboundMessage(db, businessId, customerId, toPhone, enforced.body, "sent"); }
  catch (err) { console.error("[outbound] failed to save outbound message:", err instanceof Error ? err.message : String(err)); }
}
