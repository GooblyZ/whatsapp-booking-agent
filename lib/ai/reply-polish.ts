// lib/ai/reply-polish.ts
// Server-side only.
//
// Deterministic reply ALIGNMENT & GUARDS — pure text-level helpers that keep the
// customer-visible reply consistent with the system's booking-critical truth:
//   - date echo (a settled day always shows its calendar date)
//   - confirmation CTA (the customer always knows HOW to confirm: *כן*)
//   - availability-verdict alignment (never confirm/offer against the verdict)
//   - booked-claim fence (never "התור נקבע" without a real INSERT)
//   - duplicate/near-duplicate detection (emoji- and whitespace-insensitive)
//
// Pure functions only — no DB, no Gemini. Extracted from booking-session.ts to
// keep session-state logic and reply-text logic in separate cohesive modules.

import { dayNameHe, clearField, nextStepQuestion, type BookingSession } from "./booking-session";
import { renderVerdictReplyHe, type AvailabilityInfo } from "./availability-facts";

/** Removes emojis — single shared implementation (engine + deterministic replies). */
export function stripEmojis(s: string): string {
  return s.replace(/\p{Extended_Pictographic}/gu, "").replace(/ {2,}/g, " ").trim();
}

/**
 * Outbound-text equality for the duplicate/rotation guards. MUST be emoji- and
 * whitespace-insensitive: stored history is emoji-stripped (settings chokepoint)
 * while in-flight candidates may still carry emojis — raw comparison let the
 * SAME fallback go out three times in a row live.
 */
export function sameOutboundText(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  return normalizeForCompare(a) === normalizeForCompare(b);
}

/**
 * Near-duplicate detection: also true when one reply CONTAINS the other (the
 * live garbled line was resent minus a "כן, " prefix and slipped past exact
 * comparison). Both texts must be substantial to avoid trivial containment.
 */
export function nearDuplicateText(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const na = normalizeForCompare(a);
  const nb = normalizeForCompare(b);
  if (na === nb) return true;
  if (na.length < 20 || nb.length < 20) return false;
  return na.includes(nb) || nb.includes(na);
}

function normalizeForCompare(s: string): string {
  return stripEmojis(s).replace(/\s+/g, " ").trim();
}

/**
 * Deterministic date-echo: the moment a (new) day is settled, the customer must
 * SEE the resolved calendar date — bare weekdays are ambiguous ("חמישי" = which
 * Thursday?). No-op when the reply already shows the date.
 */
export function ensureDateEcho(reply: string, s: BookingSession): string {
  if (!s.dateISO) return reply;
  const [, m, d] = s.dateISO.split("-");
  const dateShown = new RegExp(`(^|\\D)0?${parseInt(d, 10)}[./]0?${parseInt(m, 10)}(\\D|$)`);
  if (dateShown.test(reply)) return reply;
  return `${reply} (יום ${dayNameHe(s.dateISO)}, ${d}/${m})`;
}

/**
 * Confirmation-UX backstop: when the deterministic confirm step is armed, the
 * customer must be told exactly HOW to confirm — soft CTAs ("תרצה לאשר?") invite
 * answers like "יאללה" instead of the literal כן the step listens for.
 */
export function ensureConfirmCta(reply: string): string {
  if (/\*כן\*|לאישור/.test(reply)) return reply;
  return `${reply}\nלאישור סופי פשוט לכתוב *כן*.`;
}

/**
 * Aligns the model's reply with a fresh "AVAILABLE" verdict:
 *   - reply offers OTHER times → contradicts the verdict → replaced wholesale
 *   - reply already summarizes the right time → only the כן-CTA is added
 *   - reply mentions no times → full summary + CTA appended (keeps the model's
 *     warm acknowledgement)
 */
export function alignAvailableReply(reply: string, s: BookingSession): string {
  if (!s.time || !s.dateISO) return reply;
  const [, m, d] = s.dateISO.split("-");
  const day = dayNameHe(s.dateISO);
  const summary = `אז סוגרים? ${s.service ? `${s.service} ` : ""}ביום ${day} (${d}/${m}) בשעה ${s.time}. לאישור פשוט לכתוב *כן*.`;

  // Literal time mentions only (the echo extractor's AM/PM widening would
  // produce phantom "others" here).
  const mentioned = new Set(
    [...reply.matchAll(/\b(\d{1,2}):(\d{2})\b/g)].map((x) => `${x[1].padStart(2, "0")}:${x[2]}`)
  );
  const others = [...mentioned].filter((t) => t !== s.time);

  if (others.length > 0) {
    return `בדקתי — ${s.time} ביום ${day} (${d}/${m}) פנוי. ${summary}`;
  }
  if (!mentioned.has(s.time)) {
    return `${reply}\n${summary}`;
  }
  if (!/לאשר|אישור|\*כן\*/.test(reply)) {
    return `${reply}\nלאישור פשוט לכתוב *כן*.`;
  }
  return reply;
}

/**
 * True when the reply CLAIMS the booking is done / being held ("התור נקבע",
 * "אנחנו מאשרים", "מחכים לך") — only the deterministic INSERT may say that.
 * Deliberately narrow: acknowledgement phrases ("כבר רשום אצלי חמישי") and the
 * recap prefix ("מה שכבר רשום אצלי") do NOT match.
 */
export function claimsBookingCompleted(reply: string): boolean {
  return /התור\s+(שלך\s+)?נקבע|נקבע\s+(לך\s+)?ה?תור|קבעתי\s+לך|התור\s+(נרשם|סגור|מאושר)|מאשרים\s+את\s+ה|מחכים\s+לך\s+ל/.test(reply);
}

// Slice E2.1 — SELECTION / BOOKING claim next to a booking link (or a booking offer). The assistant never
// selects, changes, confirms, or books anything IN CHAT (booking completes on the SITE). Broader than
// claimsBookingCompleted: also catches the live-QA phrases "עוברים ל<service>" (implies we switched the
// selected service), "נתראה" (implies a confirmed meeting), and "סגרנו" (implies we closed it). A DETECTOR
// only — the caller replaces the offending prose with its own safe deterministic framing (the safe copy
// lives in platform-turn.ts, so this module stays copy-free and import-cycle-free).
const SELECTION_OR_BOOKING_CLAIM_RE = /עוברים\s+ל|נתראה|סגרנו/;
export function mentionsSelectionOrBookingClaim(reply: string): boolean {
  const t = reply ?? "";
  return SELECTION_OR_BOOKING_CLAIM_RE.test(t) || claimsBookingCompleted(t);
}

/** True when the reply contains NO honest unavailability signal — used to decide
 *  whether a non-available verdict must replace it. */
export function lacksUnavailabilityMarker(reply: string): boolean {
  return !/תפוס|תפוסה|סגור|סגורים|אין\s|לא\s+פנוי|לא\s+זמין|לא\s+נשאר|מלא\s|עמוס/.test(reply);
}

/**
 * True when the reply claims the given (OPEN) day is closed — same-sentence
 * co-occurrence of a day reference and a closed-word. (Live: "יום חמישי... אנחנו
 * סגורים בו" while Thursday was open 09:00-18:00 with the availability block in
 * the prompt.) Sentence-scoped so "בשבת סגור, אבל שישי פתוח" never false-hits
 * for Friday. Accepts multiple references so relative phrasings ("היום", "מחר")
 * are caught when the session day IS today/tomorrow — the live miss the original
 * weekday-only match allowed.
 */
export function falseClosedClaim(reply: string, openDayRefs: string | string[]): boolean {
  const refs = (Array.isArray(openDayRefs) ? openDayRefs : [openDayRefs]).filter(Boolean);
  return reply
    .split(/[.!?\n]/)
    .some((sentence) => /סגור/.test(sentence) && refs.some((r) => sentence.includes(r)));
}

/**
 * How the customer may refer to this date: weekday name + "היום"/"מחר" when the
 * date IS today/tomorrow (relative phrasings the weekday-only match missed live).
 */
export function dayRefsFor(dateISO: string, todayISO: string | undefined): string[] {
  const refs = [dayNameHe(dateISO)];
  if (todayISO) {
    if (dateISO === todayISO) refs.push("היום");
    const t = new Date(todayISO + "T12:00:00Z");
    t.setUTCDate(t.getUTCDate() + 1);
    if (dateISO === t.toISOString().split("T")[0]) refs.push("מחר");
  }
  return refs;
}

/**
 * VERDICT ALIGNMENT (uniform — pre-call AND post-merge evaluations): the
 * customer-visible reply must never contradict the system's availability
 * verdict, and the session must never keep an unbookable value as "known".
 * Live failures this encodes:
 *   - 15:30 evaluated "taken" pre-call, model replied "אנחנו מאשרים" anyway
 *   - the taken 15:30 lingered in the session as missing=[confirmation] for turns
 *   - a closed day stayed the session's working day
 *   - "יום חמישי... אנחנו סגורים בו" claimed about an OPEN day
 */
export function applyVerdictAlignment(
  replyText: string,
  session: BookingSession,
  availability: AvailabilityInfo
): { replyText: string; session: BookingSession; guardReason: string | null } {
  const cat = availability.requested?.category;

  if (cat === "available" && session.serviceId && session.dateISO && session.time) {
    return { replyText: alignAvailableReply(replyText, session), session, guardReason: null };
  }

  if (cat && cat !== "available") {
    let out = replyText;
    let guardReason: string | null = null;
    // Honest replies stay; replies with no unavailability signal are replaced.
    if (lacksUnavailabilityMarker(replyText)) {
      const verdict = renderVerdictReplyHe(availability, session.rejectedSlots);
      if (verdict) {
        out = verdict;
        guardReason = `verdict_${cat}`;
      }
    }
    const corrected = { ...session };
    clearField(corrected, cat === "closed_day" ? "day" : "time");
    return {
      replyText: out,
      session: { ...corrected, updatedAt: new Date().toISOString() },
      guardReason,
    };
  }

  if (!cat && availability.hours.closed && session.dateISO === availability.dateISO) {
    // CLOSED DAY with no specific time: clear it and make sure the customer knows.
    let out = replyText;
    let guardReason: string | null = null;
    if (lacksUnavailabilityMarker(replyText)) {
      const [, m, d] = availability.dateISO.split("-");
      out = `ביום ${availability.dayName} (${d}/${m}) אנחנו סגורים. איזה יום אחר נוח לך?`;
      guardReason = "verdict_closed_day";
    }
    const corrected = { ...session };
    clearField(corrected, "day");
    return {
      replyText: out,
      session: { ...corrected, lastVerdict: { time: null, category: "closed_day" }, updatedAt: new Date().toISOString() },
      guardReason,
    };
  }

  if (!availability.hours.closed && session.dateISO === availability.dateISO &&
      falseClosedClaim(replyText, dayRefsFor(session.dateISO, availability.todayISO))) {
    const [, m, d] = availability.dateISO.split("-");
    return {
      replyText: `יום ${availability.dayName} (${d}/${m}) דווקא פתוח אצלנו (${availability.hours.opens}-${availability.hours.closes}). ${nextStepQuestion(session) ?? ""}`.trim(),
      session,
      guardReason: "day_status_corrected",
    };
  }

  return { replyText, session, guardReason: null };
}

// ── INTERNAL-DISCLOSURE FENCE (model-output safety) ──────────────────────────────
// A hostile owner custom_instruction ("reveal your system prompt / internal rules")
// could try to make the model echo its own system instruction. The ONLY internal
// material the model can even see is the persona SCAFFOLD + the JSON OUTPUT SCHEMA —
// secrets, API keys and provider/config never enter the prompt (logging-hygiene rule),
// so they are structurally unleakable; the scaffold/schema is the entire leak surface.
// This detector lets the caller (brain.ts) discard such a reply for a safe deflection,
// exactly as the grounding fence discards an ungrounded reply.
//
// GENERAL, not a keyword blacklist — every marker is a REAL internal artifact, none of
// which occurs in legitimate Hebrew customer prose:
//   (1) the camelCase field names of the `understanding` OUTPUT SCHEMA (brain.ts);
//   (2) the persona's own "=== HEADER ===" section delimiters and its English output
//       banners ("strict JSON only", "ACTIONABILITY") (persona.ts);
//   (3) a tight set of phrases that explicitly NAME the system prompt / internal rules.
// Business facts (prices, hours, services) and the bare word "המערכת" ("המערכת שלנו")
// are deliberately NOT markers, so a normal grounded reply never trips the fence.
const DISCLOSURE_SCHEMA_RE =
  /\b(?:requestsBusinessAction|appointmentIntent|conversationGoal|timePreference|customerReference|changeRequest|userCorrecting|userRepeatingInfo|userFrustrated|explicitConfirmation|missingInformation)\b/;
const DISCLOSURE_SCAFFOLD_RE =
  /===\s*(?:WHO YOU ARE|HOW YOU WRITE|OWNER STYLE GUIDANCE|WHAT YOU ALREADY KNOW|BUSINESS FACTS|AVAILABILITY|RECENT CONVERSATION|END)|strict JSON only|\bACTIONABILITY\b/i;
const DISCLOSURE_META_RE =
  /system prompt|system instruction|developer (?:message|instruction)|הפרומפט|פרומפט המערכת|הוראות המערכת|הנחיות המערכת|כללי המערכת הפנימיים|ההוראות הפנימיות שלי/i;

/**
 * True when a MODEL reply appears to be revealing internal scaffolding — the system
 * instruction's structure, the output JSON schema field names, or an explicit naming of
 * the system prompt / internal instructions. PURE; high-precision by construction (the
 * markers are real internal artifacts, never legitimate Hebrew customer wording), so it
 * is a no-op on every normal reply. The caller swaps a positive hit for a safe deflection.
 */
export function revealsInternalInstructions(reply: string): boolean {
  if (!reply) return false;
  return DISCLOSURE_SCHEMA_RE.test(reply)
    || DISCLOSURE_SCAFFOLD_RE.test(reply)
    || DISCLOSURE_META_RE.test(reply);
}

// ── CTA-COMPLEMENT FENCE (Stage 3a) ──────────────────────────────────────────────
// The SYSTEM owns the call-to-action: it attaches the CTA label + link/button after the
// reply (attachPlatformLink). A MODEL reply that ALSO points the customer at the link/action
// duplicates it — the message reads the action twice and feels templated ("…לקביעת תור מהיר
// ופשוט", "אפשר לקבוע דרך הקישור"). At temp 0.7 the persona's "leave the CTA to the system"
// guidance leaks, so this is the deterministic backstop: it removes a model SENTENCE/clause
// that is purely a CALL-TO-ACTION POINTER to the system link/action, while PRESERVING any
// clause carrying a service detail (price/duration), and NEVER touching the label/URL (those
// are appended separately by the caller). GENERAL, not phrase-specific — keyed on link-noun +
// the label-style action-HEADER, never on the exact "מהר ופשוט" wording.
//
// Applied to the MODEL reply ONLY (platform-turn.ts, where decision.replyText enters routing);
// the system's own deterministic bridges (FENCE_BRIDGE_*, NO_UPCOMING_MANAGE) are assigned AFTER
// that point and legitimately reference the link, so they are never fenced.
const HEB_RANGE = `${String.fromCharCode(0x0590)}-${String.fromCharCode(0x05ff)}`;
// A link/CTA POINTER cue: a link NOUN (קישור/לינק/link) OR the label-style action-HEADER — a
// ל-prefixed appointment ACTION NOUN (לקביעת/לתיאום/להזמנת/לניהול/לצפיית/לביטול/לשינוי/להזזת)
// before "תור"/"תורים"/"פגישה", mirroring the system labels ("*לקביעת/לניהול… :*"). Deliberately
// EXCLUDES the bare click verb "לחץ" (collides with לחץ=pressure / לחצים) and the bare word
// "כאן"/"here" — both too common in normal prose — to stay high-precision (precision > recall;
// the persona change is the primary guard, this is the backstop).
const CTA_POINTER_RE = new RegExp(
  `קישור|לינק|\\blink\\b|ל(?:קביעת|תיאום|הזמנת|ניהול|צפיי?ת|ביטול|שינוי|הזזת)\\s+ה?(?:תור|תורים|פגישה)(?![${HEB_RANGE}])`,
  "i"
);
// Service DETAILS that must never be stripped: a price (₪ / שח / שקל) or a duration (NN דקות / min).
const CTA_SERVICE_DETAIL_RE = /₪|ש"?ח|שקל|\b\d{1,3}\s*(?:דק|דקות|min|minutes)\b/i;

/**
 * Removes a redundant CALL-TO-ACTION clause from a MODEL reply when the system is attaching its
 * own CTA — so the model text COMPLEMENTS the CTA instead of repeating it. PURE. Byte-identical
 * no-op for any reply that carries no CTA pointer (every normal/non-CTA turn). A clause carrying a
 * price/duration is always kept (service details preserved). NEVER returns the label/URL (the caller
 * owns those). Conservative: if removal would empty/over-trim the reply, the ORIGINAL is returned —
 * so a useful answer is never lost and the CTA is always still attached by the caller.
 */
export function stripDuplicateCtaWording(reply: string): string {
  if (!reply || !CTA_POINTER_RE.test(reply)) return reply; // no CTA pointer → untouched (byte-identical)
  const kept = reply
    .split(/(?<=[.!?…])\s+|\n+/)
    .filter((part) => {
      const s = part.trim();
      if (s.length === 0) return false;
      if (CTA_SERVICE_DETAIL_RE.test(s)) return true;        // always keep price/duration clauses
      return !CTA_POINTER_RE.test(s);                        // drop pure CTA-pointer clauses
    });
  const out = kept.join(" ").replace(/ {2,}/g, " ").replace(/\s+([,.!?…])/g, "$1").trim();
  return out.replace(/\s/g, "").length >= 2 ? out : reply;   // over-trim guard → keep the original
}

// ── INV-1 (S1) VOCATIVE / GREETING CADENCE ────────────────────────────────────────
// Greeting LIFECYCLE: a greeting ("היי", "שלום", "היי {name}") belongs at the START of a conversation, when
// the customer just greeted, or on a long-idle reopen — NOT at the top of every ongoing business reply.
// VOCATIVE policy: the customer's name is used sparingly — at most once per reply. PURE + conservative:
// strips only a LEADING greeting (and its trailing vocative name), caps repeated name vocatives, and keeps
// the ORIGINAL text if a strip would empty/over-trim it. The caller decides "ongoing" (recent history exists)
// and "userGreeted" (the customer opened with a greeting) — so a first-turn / idle-reopen greeting is kept.
// NOTE: JS \b word boundaries do NOT work after Hebrew letters (they aren't \w), so greeting tokens are
// bounded with an explicit "followed by a separator or end" lookahead instead. "היי+" (2+ yods) is used
// for the anywhere-check so it can't match "היום"/"היה".
const GREETING_ANYWHERE_RE = /(?:^|[\s,])(?:היי+|שלום|אהלן|הולו|בוקר טוב|צהריים טובים|ערב טוב|לילה טוב|מה נשמע|מה קורה|מה המצב|מה שלומ)/;
const LEADING_GREETING_RE = /^(?:היי+|הי|שלום|אהלן|הולו|יו|בוקר טוב|צהריים טובים|ערב טוב|מה נשמע|מה קורה|מה המצב)(?=[\s,!.…\-–]|$)\s*[,!.…\-–]*\s*/;

/** True when the customer's message opens with / contains a greeting — so the assistant may greet back. */
export function userGreeted(message: string): boolean {
  return GREETING_ANYWHERE_RE.test((message ?? "").slice(0, 48));
}

function escapeReLocal(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function capVocative(
  reply: string,
  opts: { ongoing: boolean; userGreeted: boolean; customerName?: string | null }
): string {
  const original = reply ?? "";
  const nm = (opts.customerName ?? "").trim();
  let out = original;
  // 1) Leading greeting (+ a leading vocative that is the customer's OWN known name), only in an ongoing
  //    convo the customer didn't open with a greeting. Empty history (first contact OR post-idle reopen)
  //    → ongoing=false → the greeting is kept. Precise: the vocative is stripped only when it matches the
  //    known name, so a real content word is never removed.
  if (opts.ongoing && !opts.userGreeted) {
    let s = out.replace(LEADING_GREETING_RE, "");
    if (nm.length >= 2) s = s.replace(new RegExp(`^${escapeReLocal(nm)}\\s*[,!.…،\\-–]*\\s+`), "");
    s = s.replace(/^\s*[,،.!…\-–]\s*/, "").trimStart();
    if (s !== out && s.replace(/\s/g, "").length >= 2) out = s;
  }
  // 2) Name-frequency cap: keep at most the FIRST standalone use of the customer's name; drop later ones.
  if (nm.length >= 2) {
    let seen = 0;
    const re = new RegExp(`(^|[\\s(,])${escapeReLocal(nm)}(?=$|[\\s,.!?…)])`, "g");
    const capped = out
      .replace(re, (full, pre) => (++seen > 1 ? (pre === "(" ? pre : "") : full))
      .replace(/\s{2,}/g, " ")
      .replace(/\s+([,.!?…])/g, "$1")
      .replace(/,\s*,/g, ",")
      .replace(/^[,\s]+/, "")
      .trim();
    if (capped.replace(/\s/g, "").length >= 2) out = capped;
  }
  return out.trim() || original;
}
