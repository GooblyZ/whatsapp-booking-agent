// lib/booking/notifications.ts
// Server-side only. PURE deterministic templates — NO Gemini, NO DB, NO network.
//
// Customer-facing WhatsApp summaries sent AFTER a successful website/manage action
// (cancel / reschedule), mirroring the post-booking confirmation in platform.ts. They
// are sent through the existing outbound chokepoint (sendOutbound), so owner emoji/gender
// settings still apply. Business-agnostic and calm: they NEVER claim the chatbot performed
// the action (the website/system did) and NEVER invent details — every value is passed in
// by the deterministic action layer.

import { capInteractiveBody, type WhatsAppInteractive } from "@/lib/whatsapp";

/** Turns a confirmation message (body + a trailing "label:\n<url>") into a cta_url interactive (the URL
 *  lives in the BUTTON, never the visible body) PLUS the original text as the fallback — so post-action
 *  confirmations get the same clean CTA look as AI/deterministic links. The body is length-capped so
 *  WhatsApp never rejects it. PURE: the url is system-built; nothing here writes to the DB or network. */
export function confirmationCta(fallbackText: string, url: string): { interactive: WhatsAppInteractive; fallbackText: string } {
  const body = capInteractiveBody(fallbackText.replace(url, "").replace(/\s+$/, "")); // strip the URL line; keep the label
  return { interactive: { kind: "cta_url", body, buttonText: "לחץ כאן", url }, fallbackText };
}

/** "YYYY-MM-DD" (business-local) → "DD/MM/YYYY". Returns the input unchanged if malformed. */
export function formatApptDate(dateISO: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec((dateISO ?? "").trim());
  if (!m) return dateISO ?? "";
  return `${m[3]}/${m[2]}/${m[1]}`;
}

export interface CancellationMessageInput {
  serviceName: string | null;
  dateISO: string;    // business-local YYYY-MM-DD of the cancelled appointment
  time: string;       // business-local HH:MM
  bookingLink: string;
}
/** Confirms a cancellation and offers a link to book again. */
export function buildCancellationMessage(i: CancellationMessageInput): string {
  const lines = ["התור שלך בוטל בהצלחה.", ""];
  if (i.serviceName?.trim()) lines.push(`שירות: ${i.serviceName.trim()}`);
  lines.push(`תאריך: ${formatApptDate(i.dateISO)}`, `שעה: ${i.time}`, "");
  lines.push("לקביעת תור חדש:", i.bookingLink);
  return lines.join("\n");
}

export interface RescheduleMessageInput {
  serviceName: string | null;
  fromDateISO: string; // OLD slot (captured BEFORE the update)
  fromTime: string;
  toDateISO: string;   // NEW slot
  toTime: string;
  manageLink: string;
}
/** Confirms a reschedule, summarizing old → new and linking to the manage page. */
export function buildRescheduleMessage(i: RescheduleMessageInput): string {
  const lines = ["התור שלך עודכן בהצלחה.", ""];
  if (i.serviceName?.trim()) lines.push(`שירות: ${i.serviceName.trim()}`);
  lines.push(
    `מ: ${formatApptDate(i.fromDateISO)} בשעה ${i.fromTime}`,
    `ל: ${formatApptDate(i.toDateISO)} בשעה ${i.toTime}`,
    "",
    "לצפייה או שינוי נוסף:",
    i.manageLink,
  );
  return lines.join("\n");
}

/** True when a reschedule actually moved the appointment (dedupe: skip a no-op/same-slot resubmit). */
export function rescheduleChanged(fromDateISO: string, fromTime: string, toDateISO: string, toTime: string): boolean {
  return fromDateISO !== toDateISO || fromTime !== toTime;
}
