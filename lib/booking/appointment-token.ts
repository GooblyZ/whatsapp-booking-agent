// lib/booking/appointment-token.ts
// Server-side only.
//
// Signed, customer-scoped access token for the "My Appointments" page
// (/appointments/[token]). Unlike /appointment/[id] — where the raw appointment
// UUID is itself the bearer token — listing ALL of a customer's appointments has
// a larger blast radius, so the customer id is wrapped in an HMAC: the token
// CANNOT be forged for another customer and CANNOT be enumerated.
//
// Access-model tradeoff (documented): the token is an unguessable bearer link
// (no OTP), consistent with /appointment/[id]. The customer id inside is a random
// UUID with no standalone power. The HMAC key is the existing server secret
// (SUPABASE_SERVICE_ROLE_KEY), so a token minted by the local webhook verifies on
// Vercel without any new env var. Set APPOINTMENTS_LINK_SECRET to decouple/rotate.
// No expiry in v1 (the page only ever lists CURRENT upcoming appointments).

import { createHmac, timingSafeEqual } from "node:crypto";
import { getPublicBaseUrl } from "@/lib/config";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SIG_LEN = 32;

function secret(): string {
  return (process.env.APPOINTMENTS_LINK_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY || "insecure-dev-fallback").trim();
}

function sign(customerId: string): string {
  return createHmac("sha256", secret()).update(`appts:v1:${customerId}`).digest("base64url").slice(0, SIG_LEN);
}

/** Unforgeable, unguessable customer-scoped token (UUID wrapped in an HMAC). */
export function signCustomerToken(customerId: string): string {
  return `${Buffer.from(customerId).toString("base64url")}.${sign(customerId)}`;
}

/** Verifies a My-Appointments token → customerId, or null if invalid/forged. */
export function verifyCustomerToken(token: string | undefined | null): string | null {
  if (!token || token.length > 256) return null;
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  let customerId: string;
  try {
    customerId = Buffer.from(token.slice(0, dot), "base64url").toString("utf8");
  } catch {
    return null;
  }
  if (!UUID_RE.test(customerId)) return null;
  const sig = token.slice(dot + 1);
  const expected = sign(customerId);
  if (sig.length !== expected.length) return null;
  try {
    if (!timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  } catch {
    return null;
  }
  return customerId;
}

/** Customer-facing link to the My Appointments page. */
export function buildMyAppointmentsLink(customerId: string): string {
  return `${getPublicBaseUrl()}/appointments/${signCustomerToken(customerId)}`;
}
