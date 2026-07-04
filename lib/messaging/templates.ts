// lib/messaging/templates.ts
// THE central module for customer-facing SYSTEM (non-AI) WhatsApp message text — PURE
// deterministic renderers: NO Gemini, NO DB, NO network, no imports. Every value is passed
// in by the deterministic action layer; nothing here may invent a detail.
//
// One consistent structure across all system messages (booking confirmed / cancelled /
// rescheduled / reminder / waitlist):
//   *bold headline*  →  blank line  →  plain "label: value" fields  →  blank line  →
//   CTA label line  →  the URL as the LAST line.
// The URL-last shape is load-bearing: confirmationCta (lib/booking/notifications.ts) strips
// exactly that trailing URL to build a clean cta_url button body, while the full text (WITH
// the URL) remains the guaranteed fallback — deliverability first.
//
// Hebrew style rules (product-wide): gender-neutral phrasing only — NEVER slash-gender
// forms ("תרצה/י", "כתוב/כתבי"); business-agnostic wording only — no industry vocabulary
// (a Pilates studio and a clinic get the same templates). Owner emoji/length/gender fences
// still apply downstream at the outbound chokepoint; templates ship emoji-free.

/** "YYYY-MM-DD" (business-local) → "DD/MM/YYYY". Returns the input unchanged if malformed. */
export function formatApptDate(dateISO: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec((dateISO ?? "").trim());
  if (!m) return dateISO ?? "";
  return `${m[3]}/${m[2]}/${m[1]}`;
}

/** Shared card body: optional service line + date/time lines (the uniform middle section). */
function apptFields(serviceName: string | null, dateISO: string, time: string): string[] {
  const lines: string[] = [];
  if (serviceName?.trim()) lines.push(`שירות: ${serviceName.trim()}`);
  lines.push(`תאריך: ${formatApptDate(dateISO)}`, `שעה: ${time}`);
  return lines;
}

export interface BookingConfirmedInput {
  serviceName: string | null;
  dateISO: string;   // business-local YYYY-MM-DD
  time: string;      // business-local HH:MM
  manageLink: string;
}
/** Post-booking confirmation (sent by the PLATFORM after its deterministic INSERT). */
export function buildBookingConfirmedMessage(i: BookingConfirmedInput): string {
  return [
    "*התור נקבע בהצלחה!*", "",
    ...apptFields(i.serviceName, i.dateISO, i.time), "",
    "לצפייה, שינוי או ביטול:", i.manageLink,
  ].join("\n");
}

export interface CancellationMessageInput {
  serviceName: string | null;
  dateISO: string;    // business-local YYYY-MM-DD of the cancelled appointment
  time: string;       // business-local HH:MM
  bookingLink: string;
}
/** Confirms a cancellation and offers a link to book again. */
export function buildCancellationMessage(i: CancellationMessageInput): string {
  return [
    "*התור שלך בוטל בהצלחה.*", "",
    ...apptFields(i.serviceName, i.dateISO, i.time), "",
    "לקביעת תור חדש:", i.bookingLink,
  ].join("\n");
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
  const lines = ["*התור שלך עודכן בהצלחה.*", ""];
  if (i.serviceName?.trim()) lines.push(`שירות: ${i.serviceName.trim()}`);
  lines.push(
    `מ: ${formatApptDate(i.fromDateISO)} בשעה ${i.fromTime}`,
    `ל: ${formatApptDate(i.toDateISO)} בשעה ${i.toTime}`,
    "",
    "לצפייה או שינוי נוסף:", i.manageLink,
  );
  return lines.join("\n");
}

export interface ReminderMessageInput {
  serviceName: string | null;
  dateISO: string;   // business-local YYYY-MM-DD
  time: string;      // business-local HH:MM
  manageLink: string;
}
/** Upcoming-appointment reminder (job-driven; quiet-hours gated by the caller). */
export function buildReminderMessage(i: ReminderMessageInput): string {
  return [
    "*תזכורת לתור הקרוב שלך*", "",
    ...apptFields(i.serviceName, i.dateISO, i.time), "",
    "לצפייה, שינוי או ביטול:", i.manageLink,
  ].join("\n");
}

export interface WaitlistFreedSlotInput {
  dateISO: string;   // business-local YYYY-MM-DD of the freed slot
  time: string;      // business-local HH:MM
  bookingLink: string;
}
/** A slot just freed for a matching waitlist entry. Honest race semantics: first to book wins. */
export function buildWaitlistFreedSlotMessage(i: WaitlistFreedSlotInput): string {
  return [
    "*התפנה תור!*", "",
    `תאריך: ${formatApptDate(i.dateISO)}`, `שעה: ${i.time}`, "",
    "ביקשת עדכון מרשימת ההמתנה — התור פתוח לכל מי שיקבע ראשון.", "",
    "לקביעת התור:", i.bookingLink,
  ].join("\n");
}

export interface WaitlistOpportunityInput {
  dateISO: string | null; // optional — an opportunity may be emitted without a concrete slot
  time: string | null;
  bookingLink: string;
}
/** A pre-emitted, already-targeted waitlist opportunity (date/time optional). */
export function buildWaitlistOpportunityMessage(i: WaitlistOpportunityInput): string {
  const lines = ["*התפנה תור!*", ""];
  if (i.dateISO?.trim()) lines.push(`תאריך: ${formatApptDate(i.dateISO)}`);
  if (i.time?.trim()) lines.push(`שעה: ${i.time}`);
  if (i.dateISO?.trim() || i.time?.trim()) lines.push("");
  lines.push("ביקשת שנעדכן אותך כשמתפנה תור.", "", "לקביעת התור:", i.bookingLink);
  return lines.join("\n");
}
