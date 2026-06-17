import { sendWhatsAppTextMessage, sendWhatsAppInteractiveMessage, type WhatsAppInteractive } from "@/lib/whatsapp";
import { stripEmojis } from "@/lib/ai/reply-polish";
import { enforceAssistantGender } from "@/lib/ai/gender";
import { recordWhatsAppSendResult } from "@/lib/integration-health";
import { type DB, saveOutboundMessage } from "./helpers";

/**
 * THE single outbound chokepoint, shared by the chat router (flow.ts) and the
 * booking platform. Owner AI settings apply to EVERY customer-facing message —
 * model-written, guard, deterministic strings, and platform notifications alike:
 *   - assistant_gender → the assistant's own Hebrew forms are forced to the
 *     configured gender (the FINAL authority — beats persona text, name, history,
 *     and model drift; never touches references to the customer).
 *   - emoji_usage=none → all emojis stripped.
 * Fail-open: if settings can't be read, the text is sent unmodified.
 */
export async function applyOutboundSettings(db: DB, businessId: string, text: string): Promise<string> {
  try {
    const { data } = await db
      .from("ai_settings")
      .select("emoji_usage, assistant_gender")
      .eq("business_id", businessId)
      .maybeSingle();
    let out = enforceAssistantGender(text, data?.assistant_gender as ("neutral" | "female" | "male") | undefined);
    if (data?.emoji_usage === "none") out = stripEmojis(out);
    return out;
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

/** Applies emoji enforcement to an interactive message's body + visible labels. Gender is
 *  enforced on the BODY (the prose); button/row titles are short generic nouns (no gendered
 *  self-reference), so only emoji-stripping is applied to them. */
function applyInteractiveSettings(
  i: WhatsAppInteractive, gender: "neutral" | "female" | "male" | undefined, emojiNone: boolean
): WhatsAppInteractive {
  const body = emojiNone ? stripEmojis(enforceAssistantGender(i.body, gender)) : enforceAssistantGender(i.body, gender);
  const label = (s: string): string => (emojiNone ? stripEmojis(s) : s);
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
  let gender: "neutral" | "female" | "male" | undefined;
  let emojiNone = false;
  try {
    const { data } = await db.from("ai_settings").select("emoji_usage, assistant_gender").eq("business_id", businessId).maybeSingle();
    gender = data?.assistant_gender as ("neutral" | "female" | "male") | undefined;
    emojiNone = data?.emoji_usage === "none";
  } catch { /* settings unavailable → send as-is */ }

  const enforced = applyInteractiveSettings(interactive, gender, emojiNone);
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
