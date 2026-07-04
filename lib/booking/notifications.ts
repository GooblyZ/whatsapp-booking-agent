// lib/booking/notifications.ts
// Server-side only. The TEXT of every post-action confirmation now lives in the central
// template module (lib/messaging/templates.ts) — one consistent structure for ALL system
// messages. This file keeps the pieces that are about DELIVERY rather than wording:
//   - confirmationCta(): text-with-URL → clean cta_url interactive + text fallback.
//   - rescheduleChanged(): the dedupe predicate for no-op resubmits.
// The template builders are re-exported for back-compat (platform.ts, evals and sims
// import them from here). Everything sends through the outbound chokepoint, so owner
// emoji/gender/length settings still apply.

import { capInteractiveBody, type WhatsAppInteractive } from "@/lib/whatsapp";

export {
  formatApptDate,
  buildCancellationMessage,
  buildRescheduleMessage,
  type CancellationMessageInput,
  type RescheduleMessageInput,
} from "@/lib/messaging/templates";

/** Turns a confirmation message (body + a trailing "label:\n<url>") into a cta_url interactive (the URL
 *  lives in the BUTTON, never the visible body) PLUS the original text as the fallback — so post-action
 *  confirmations get the same clean CTA look as AI/deterministic links. The body is length-capped so
 *  WhatsApp never rejects it. PURE: the url is system-built; nothing here writes to the DB or network. */
export function confirmationCta(fallbackText: string, url: string): { interactive: WhatsAppInteractive; fallbackText: string } {
  const body = capInteractiveBody(fallbackText.replace(url, "").replace(/\s+$/, "")); // strip the URL line; keep the label
  return { interactive: { kind: "cta_url", body, buttonText: "לחץ כאן", url }, fallbackText };
}

/** True when a reschedule actually moved the appointment (dedupe: skip a no-op/same-slot resubmit). */
export function rescheduleChanged(fromDateISO: string, fromTime: string, toDateISO: string, toTime: string): boolean {
  return fromDateISO !== toDateISO || fromTime !== toTime;
}
