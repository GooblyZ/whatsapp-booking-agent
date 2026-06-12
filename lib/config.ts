export function getDefaultBusinessId(): string {
  const id = process.env.DEFAULT_BUSINESS_ID;
  if (!id) throw new Error("DEFAULT_BUSINESS_ID env var is not set");
  return id;
}

export type BookingMode = "conversational" | "platform";

/**
 * Transition flag (see TRANSITION_PLAN.md). "conversational" preserves the
 * pre-pivot live behavior exactly; "platform" routes booking intent to the
 * web booking platform. Defaults to "conversational" so flipping is an
 * explicit founder action.
 */
export function getBookingMode(): BookingMode {
  return process.env.BOOKING_MODE === "platform" ? "platform" : "conversational";
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
