// lib/ai/availability-facts.ts
// Server-side only.
//
// AVAILABILITY ≠ BUSINESS HOURS. Business hours say when the business is open;
// availability says which slots are actually free. Gemini must NEVER infer one
// from the other — so the SYSTEM computes real availability here, from the
// ACCUMULATED booking context (session + current message), and evaluates a
// requested time into one of four distinct categories:
//
//   closed_day     — the business is closed that day
//   outside_hours  — inside an open day but outside opening hours
//   taken          — inside hours but the slot is not free
//   available      — the slot is free
//
// These are handed to Gemini as facts BEFORE it writes the reply, so the reply
// is grounded up-front instead of being blocked after the fact.
//
// Read-only and fail-safe — never creates or modifies anything.

import type { DB } from "@/lib/booking/helpers";
import type { BusinessAIContext } from "@/types/database";
import { getAvailableSlots, isIntervalFree, todayInTZ } from "@/lib/booking/availability";
import { dayNameHe, missingFields, type BookingSession } from "./booking-session";

const MAX_SLOTS_IN_FACTS = 12;

export type RequestCategory = "closed_day" | "outside_hours" | "taken" | "available";

export interface AvailabilityInfo {
  dateISO: string;
  dayName: string;                  // Hebrew day name
  /** Today in the business timezone — lets guards resolve "היום"/"מחר" references. */
  todayISO?: string;
  durationUsedMin: number;
  slots: string[];                  // open slots (capped)
  truncated: boolean;
  hours: { closed: boolean; opens: string | null; closes: string | null };
  requested: {                      // present when a concrete time was requested
    time: string;
    category: RequestCategory;
    nearest: string[];              // closest open alternatives (for "taken")
  } | null;
}

/**
 * Computes real availability for a concrete date from the accumulated context.
 * `requestedTime` ("HH:MM") additionally classifies the customer's asked-for time.
 */
export async function buildAvailabilityInfo(
  db: DB,
  businessId: string,
  ctx: BusinessAIContext,
  dateISO: string,
  requestedTime: string | null,
  durationMin: number | null
): Promise<AvailabilityInfo | null> {
  try {
    const timezone = ctx.business.timezone || "Asia/Jerusalem";

    // Hours for that weekday — from the already-loaded context (no extra query).
    // Defaults mirror getAvailableSlots' 09:00-18:00 fallback.
    const dow = new Date(dateISO + "T12:00:00Z").getDay();
    const row = ctx.businessHours.find((h) => h.day_of_week === dow);
    const hours = row
      ? { closed: row.is_closed || !row.opens_at, opens: row.is_closed ? null : row.opens_at, closes: row.is_closed ? null : row.closes_at }
      : { closed: false, opens: "09:00", closes: "18:00" };

    const durations = ctx.services.filter((s) => s.active).map((s) => s.duration_minutes).filter(Boolean);
    const duration = durationMin ?? (durations.length > 0 ? Math.min(...durations) : 30);

    const allSlots = hours.closed ? [] : await getAvailableSlots(db, businessId, dateISO, duration, timezone);

    let requested: AvailabilityInfo["requested"] = null;
    if (requestedTime) {
      requested = { time: requestedTime, category: classify(requestedTime, hours, allSlots), nearest: [] };
      if (requested.category === "taken" && !allSlots.includes(requestedTime)) {
        // OFF-GRID time: not being a grid slot doesn't mean it's occupied — a
        // human receptionist books 15:30 on an empty day even on a 45-min grid.
        // Verify the actual interval against real appointments.
        const free = await isIntervalFree(db, businessId, dateISO, requestedTime, duration, timezone);
        if (free) requested.category = "available";
      }
      if (requested.category === "taken") {
        requested.nearest = nearestSlots(requestedTime, allSlots, 3);
      }
    }

    return {
      dateISO,
      dayName: dayNameHe(dateISO),
      todayISO: todayInTZ(timezone),
      durationUsedMin: duration,
      slots: allSlots.slice(0, MAX_SLOTS_IN_FACTS),
      truncated: allSlots.length > MAX_SLOTS_IN_FACTS,
      hours,
      requested,
    };
  } catch (err) {
    console.error("[ai-availability] failed:", err instanceof Error ? err.message : String(err));
    return null;
  }
}

function toMin(t: string): number {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

function classify(
  time: string,
  hours: { closed: boolean; opens: string | null; closes: string | null },
  slots: string[]
): RequestCategory {
  if (hours.closed || !hours.opens || !hours.closes) return "closed_day";
  const t = toMin(time);
  if (t < toMin(hours.opens) || t >= toMin(hours.closes)) return "outside_hours";
  if (slots.includes(time)) return "available";
  return "taken";
}

function nearestSlots(time: string, slots: string[], n: number): string[] {
  const t = toMin(time);
  return [...slots].sort((a, b) => Math.abs(toMin(a) - t) - Math.abs(toMin(b) - t)).slice(0, n);
}

/** Groups slots into Hebrew dayparts with a few examples each (anti-list-dump UX). */
function daypartSummary(slots: string[]): string {
  const parts: { label: string; min: number; max: number; items: string[] }[] = [
    { label: "בוקר", min: 0, max: 12, items: [] },
    { label: "צהריים", min: 12, max: 15, items: [] },
    { label: "אחר הצהריים", min: 15, max: 18, items: [] },
    { label: "ערב", min: 18, max: 24, items: [] },
  ];
  for (const t of slots) {
    const h = parseInt(t.split(":")[0], 10);
    const p = parts.find((x) => h >= x.min && h < x.max);
    if (p) p.items.push(t);
  }
  return parts
    .filter((p) => p.items.length > 0)
    .map((p) => `${p.label}: ${p.items.slice(0, 3).join(", ")}${p.items.length > 3 ? ` (+${p.items.length - 3})` : ""}`)
    .join(" | ");
}

/** Renders the AVAILABILITY block for the persona. `rejectedSlots` = times the
 *  customer already turned down for this day — never re-offered. */
export function renderAvailabilityInfo(
  info: AvailabilityInfo | null,
  pendingTimeNoDate: string | null,
  rejectedSlots: string[] = []
): string {
  if (!info) {
    if (pendingTimeNoDate) {
      return `The customer mentioned the time ${pendingTimeNoDate} but no concrete DAY yet — availability CANNOT be checked without a day. Ask which day, do not guess.`;
    }
    return "";
  }
  const lines: string[] = [];
  const hoursStr = info.hours.closed ? "CLOSED that day" : `open ${info.hours.opens}-${info.hours.closes}`;
  lines.push(`Checked date: ${info.dateISO} (יום ${info.dayName}) — ${hoursStr}.`);

  const offerableSlots = info.slots.filter((s) => !rejectedSlots.includes(s));

  if (info.hours.closed) {
    lines.push(`The business is closed on that day — suggest another day.`);
  } else if (info.slots.length === 0) {
    lines.push(`NO open slots remain on that date (fully booked).`);
  } else if (offerableSlots.length === 0) {
    lines.push(`Open slots exist BUT the customer already rejected all of them for this day — be honest that nothing else is left on this day, and suggest trying another day.`);
  } else {
    lines.push(`Open slots by part of day (${info.durationUsedMin} min grid): ${daypartSummary(offerableSlots)}${info.truncated ? " (+more)" : ""}.`);
    lines.push(`Present availability NATURALLY: say which parts of the day have room and offer at most 2-3 concrete times that fit what the customer asked for. NEVER dump the full list unless the customer explicitly asks for all options.`);
  }

  if (rejectedSlots.length > 0) {
    lines.push(`⚠ The customer ALREADY REJECTED these times for this day: ${rejectedSlots.join(", ")} — do NOT offer them again unless the customer brings them up themselves.`);
  }

  if (info.requested) {
    const r = info.requested;
    const nearestOfferable = r.nearest.filter((t) => !rejectedSlots.includes(t));
    switch (r.category) {
      case "available":
        lines.push(`Requested time ${r.time}: AVAILABLE ✓ — you may confirm it with the customer.`);
        break;
      case "taken":
        lines.push(`Requested time ${r.time}: NOT free (already booked). Nearest open: ${nearestOfferable.join(", ") || "none (besides times already rejected)"}.`);
        break;
      case "outside_hours":
        lines.push(`Requested time ${r.time}: OUTSIDE business hours for that day (${info.hours.opens}-${info.hours.closes}). Say so and offer a time within hours.`);
        break;
      case "closed_day":
        lines.push(`Requested time ${r.time}: the business is CLOSED that day.`);
        break;
    }
  }
  return lines.join("\n");
}

/**
 * System-computed REPLY GUIDANCE (placed at the prompt's end): the single most
 * useful next step for this reply, phrased permissively — the conversation
 * comes first; the form can wait.
 */
export function buildReplyGuidance(preview: BookingSession, availability: AvailabilityInfo | null): string {
  if (!preview.active) return "";
  const lines: string[] = [];

  const known: string[] = [];
  if (preview.serviceId) known.push(`service=${preview.service}`);
  if (preview.dateISO) known.push(`day=${preview.dateISO}`);
  if (preview.time) known.push(`time=${preview.time}`);
  if (known.length > 0) {
    lines.push(`Already settled: ${known.join(", ")} — do NOT ask about these again.`);
  }

  const missing = missingFields(preview)[0];
  if (missing === "confirmation" && availability?.requested?.category === "available") {
    lines.push(`Everything is set and the requested time is AVAILABLE — summarize the booking warmly and ask the customer to reply *כן* to confirm.`);
  } else if (missing === "service" || missing === "day" || missing === "time") {
    const what = missing === "service" ? "which service they want" : missing === "day" ? "which day suits them" : "what time of day suits them";
    lines.push(
      `When it fits naturally — after you've responded to what they actually said — the next helpful step is finding out ${what}. ` +
      `If they asked or raised something else, that comes first; the booking can advance on a later turn.`
    );
  }
  return lines.join("\n");
}

/**
 * Customer-facing Hebrew verdict for a requested time that was evaluated AFTER
 * the model reply was already written (post-merge re-check) and turned out NOT
 * to be bookable. Returns null for "available" / no verdict — the caller keeps
 * (and extends) the model's reply in that case. Gender-neutral, grounded: every
 * time quoted comes from the availability computation itself.
 */
export function renderVerdictReplyHe(info: AvailabilityInfo, rejectedSlots: string[] = []): string | null {
  const r = info.requested;
  if (!r) return null;
  const dd = info.dateISO.split("-").reverse().slice(0, 2).join("/");
  const nearest = r.nearest.filter((t) => !rejectedSlots.includes(t)).slice(0, 3);
  switch (r.category) {
    case "taken":
      return nearest.length > 0
        ? `רגע, בדקתי — ${r.time} ביום ${info.dayName} (${dd}) בדיוק תפוס. פנוי לידו: ${nearest.join(", ")}. מה מתאים לך?`
        : `רגע, בדקתי — ${r.time} ביום ${info.dayName} (${dd}) תפוס, ולא נשארו שעות קרובות פנויות באותו יום. לבדוק יום אחר?`;
    case "outside_hours":
      return `בדקתי — בשעה ${r.time} כבר אין קבלה ביום ${info.dayName} (${dd}); פתוחים ${info.hours.opens}-${info.hours.closes}. איזו שעה בטווח הזה נוחה לך?`;
    case "closed_day":
      return `בדקתי — ביום ${info.dayName} (${dd}) אנחנו סגורים. איזה יום אחר נוח לך?`;
    default:
      return null;
  }
}
