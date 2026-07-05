export function getDefaultBusinessId(): string {
  const id = process.env.DEFAULT_BUSINESS_ID;
  if (!id) throw new Error("DEFAULT_BUSINESS_ID env var is not set");
  return id;
}

export type BookingMode = "conversational" | "platform";

/**
 * Transition flag (see TRANSITION_PLAN.md). "platform" routes booking intent to the web booking
 * platform and runs the full trust/safety layer (routing SSOT, link fences, behavior classes);
 * "conversational" is the LEGACY pre-pivot path and runs WITHOUT those guards.
 *
 * Default is now "platform" (owner decision 2026-07-06): platform is the canonical runtime, and a
 * silent env-default to the legacy path was making the trust/safety work dark. Legacy is now
 * OPT-IN via BOOKING_MODE=conversational. Keep BOOKING_MODE=platform set explicitly in every env
 * (Vercel + .env.local) so parity never depends on this default.
 */
export function getBookingMode(): BookingMode {
  return process.env.BOOKING_MODE === "conversational" ? "conversational" : "platform";
}

/**
 * Burst-aggregation debounce (ms). After an inbound is saved, the handler waits this
 * long before processing, then skips the turn if a newer inbound already arrived — so
 * normal WhatsApp-style split messages ("אני רוצה" + "להבין איפה אתם") coalesce into ONE
 * turn instead of producing a reply per fragment. Adds at most this much latency per reply.
 * Default 2000ms (live testing showed 1000ms too short for human typing pauses). Set
 * AGGREGATION_DEBOUNCE_MS=0 to disable entirely (pre-debounce behavior). Capped at 10s
 * to prevent an accidental long webhook stall.
 */
export function getAggregationDebounceMs(): number {
  const raw = process.env.AGGREGATION_DEBOUNCE_MS;
  if (raw === undefined || raw.trim() === "") return 2000;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return 2000;
  return Math.min(n, 10_000);
}

let warnedNoBaseUrl = false;

/**
 * Public origin used to build customer-facing links (booking page, appointment
 * self-service). Must be the ngrok / deployed URL in production — localhost
 * links only work on the dev machine.
 */
export function getPublicBaseUrl(): string {
  const url = process.env.PUBLIC_BASE_URL?.trim().replace(/\/+$/, "");
  if (url) return url;
  if (!warnedNoBaseUrl) {
    console.warn("[config] PUBLIC_BASE_URL not set — customer links fall back to http://localhost:3000");
    warnedNoBaseUrl = true;
  }
  return "http://localhost:3000";
}

export function buildBookingLink(slug: string, phone?: string | null): string {
  const base = `${getPublicBaseUrl()}/book/${encodeURIComponent(slug)}`;
  return phone ? `${base}?p=${encodeURIComponent(phone)}` : base;
}

export function buildAppointmentLink(appointmentId: string): string {
  return `${getPublicBaseUrl()}/appointment/${encodeURIComponent(appointmentId)}`;
}
