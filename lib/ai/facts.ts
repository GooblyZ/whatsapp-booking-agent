// lib/ai/facts.ts
// Server-side only.
//
// The SYSTEM is the source of truth. This module turns a BusinessAIContext into:
//   1. BusinessFacts        — a compact, structured snapshot for the prompt
//   2. formatFacts()        — the human-readable FACTS block Gemini sees
//   3. FactIndex            — the set of machine-verifiable atoms (prices, times,
//                             phone) used by grounding verification
//   4. auditBusinessContext — a report-only presence check (used by the debug page)
//
// Nothing here calls Gemini or writes to the DB.

import type { BusinessAIContext } from "@/types/database";
import { DAY_NAMES } from "@/lib/services/business-hours";

const MAX_KB_ITEM_CHARS = 400;
const MAX_KB_ITEMS = 25;
const MAX_FACTS_CHARS = 6000;

export interface BusinessFacts {
  businessName: string;
  phone: string | null;
  location: { address: string | null; city: string | null };
  timezone: string;
  bookingEnabled: boolean;
  hours: { day: string; closed: boolean; opens: string | null; closes: string | null }[];
  services: { name: string; durationMin: number; price: number | null; description: string | null }[];
  knowledge: { category: string; title: string; content: string }[];
}

export interface Capabilities {
  canAnswer: boolean;       // answer informational questions (faq_enabled)
  canStartBooking: boolean; // hand off to the booking flow (intent_detection_enabled && bookingEnabled)
  canCancel: boolean;       // Phase 1: always false
  canReschedule: boolean;   // Phase 1: always false
}

/** Builds the structured facts snapshot from the business context. */
export function buildFacts(ctx: BusinessAIContext): BusinessFacts {
  const b = ctx.business;
  const settings = ctx.businessSettings;

  const hours = [...ctx.businessHours]
    .sort((a, z) => a.day_of_week - z.day_of_week)
    .map((h) => ({
      day: DAY_NAMES[h.day_of_week] ?? `day ${h.day_of_week}`,
      closed: h.is_closed || !h.opens_at,
      opens: h.is_closed ? null : h.opens_at,
      closes: h.is_closed ? null : h.closes_at,
    }));

  const services = ctx.services
    .filter((s) => s.active)
    .map((s) => ({
      name: s.name,
      durationMin: s.duration_minutes,
      price: s.price != null ? Math.round(Number(s.price)) : null,
      description: s.description?.trim() || null,
    }));

  const knowledge = ctx.knowledgeBaseItems
    .filter((k) => k.active)
    .sort((a, z) => (a.category === "about" ? -1 : 0) - (z.category === "about" ? -1 : 0))
    .slice(0, MAX_KB_ITEMS)
    .map((k) => ({
      category: k.category,
      title: k.title.trim(),
      content: k.content.trim().slice(0, MAX_KB_ITEM_CHARS),
    }));

  return {
    businessName: b.name,
    phone: b.phone?.trim() || null,
    location: { address: settings?.address?.trim() || null, city: settings?.city?.trim() || null },
    timezone: b.timezone,
    bookingEnabled: settings?.booking_enabled !== false,
    hours,
    services,
    knowledge,
  };
}

/** Renders the FACTS block placed inside the Gemini system instruction. */
export function formatFacts(facts: BusinessFacts): string {
  const lines: string[] = [];
  lines.push(`Business name: ${facts.businessName}`);
  lines.push(`Phone: ${facts.phone ?? "not provided"}`);
  const loc = [facts.location.address, facts.location.city].filter(Boolean).join(", ");
  lines.push(`Location: ${loc || "not provided"}`);
  lines.push(`Timezone: ${facts.timezone}`);
  lines.push(`Booking enabled: ${facts.bookingEnabled ? "yes" : "no"}`);

  lines.push("", "Services:");
  if (facts.services.length > 0) {
    for (const s of facts.services) {
      const price = s.price != null ? `₪${s.price}` : "price not listed";
      const desc = s.description ? ` — ${s.description}` : "";
      lines.push(`- ${s.name} (${s.durationMin} min, ${price})${desc}`);
    }
  } else {
    lines.push("- none listed");
  }

  lines.push("", "Business hours:");
  if (facts.hours.length > 0) {
    for (const h of facts.hours) {
      lines.push(`- ${h.day}: ${h.closed ? "closed" : `${h.opens}-${h.closes}`}`);
    }
  } else {
    lines.push("- not configured");
  }

  if (facts.knowledge.length > 0) {
    lines.push("", "Knowledge base:");
    for (const k of facts.knowledge) lines.push(`[${k.category}] ${k.title}: ${k.content}`);
  }

  let block = lines.join("\n");
  if (block.length > MAX_FACTS_CHARS) block = block.slice(0, MAX_FACTS_CHARS) + "\n…(truncated)";
  return block;
}

// ── Grounding index (verifiable atoms) ─────────────────────────────────────────

export interface FactIndex {
  prices: Set<number>;      // allowed currency amounts
  times: Set<string>;       // allowed exact "HH:MM" (hours bounds + provided slots)
  /** Open-hours ranges in minutes — any time INSIDE an open range is quotable. */
  timeRanges: { start: number; end: number }[];
  phoneDigits: string | null;
}

/** Builds the set of values Gemini is allowed to quote (used by grounding). */
export function buildFactIndex(facts: BusinessFacts): FactIndex {
  const prices = new Set<number>();
  for (const s of facts.services) if (s.price != null) prices.add(s.price);

  const times = new Set<string>();
  const timeRanges: { start: number; end: number }[] = [];
  for (const h of facts.hours) {
    if (!h.closed && h.opens && h.closes) {
      times.add(normalizeTime(h.opens));
      times.add(normalizeTime(h.closes));
      const [oh, om] = h.opens.split(":").map(Number);
      const [ch, cm] = h.closes.split(":").map(Number);
      timeRanges.push({ start: oh * 60 + om, end: ch * 60 + cm });
    }
  }

  const phoneDigits = facts.phone ? facts.phone.replace(/\D/g, "") : null;
  return { prices, times, timeRanges, phoneDigits };
}

function normalizeTime(t: string): string {
  const m = t.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return t;
  return `${String(parseInt(m[1], 10)).padStart(2, "0")}:${m[2]}`;
}

// ── Context audit (report-only, for the debug page) ────────────────────────────

export interface ContextAudit {
  aboutIncluded: boolean;
  faqIncluded: boolean;
  pricingIncluded: boolean;
  parkingIncluded: boolean;
  policyIncluded: boolean;
  contactIncluded: boolean;
  servicesIncluded: boolean;
  hoursIncluded: boolean;
  activeKbCount: number;
  activeServiceCount: number;
}

export function auditBusinessContext(ctx: BusinessAIContext): ContextAudit {
  const kb = ctx.knowledgeBaseItems.filter((k) => k.active);
  const services = ctx.services.filter((s) => s.active);
  const hasCategory = (cat: string) => kb.some((k) => k.category === cat);
  return {
    aboutIncluded: hasCategory("about"),
    faqIncluded: hasCategory("faq"),
    pricingIncluded: hasCategory("pricing"),
    parkingIncluded: hasCategory("parking"),
    policyIncluded: hasCategory("policy"),
    contactIncluded: hasCategory("contact"),
    servicesIncluded: services.length > 0,
    hoursIncluded: ctx.businessHours.length > 0,
    activeKbCount: kb.length,
    activeServiceCount: services.length,
  };
}
