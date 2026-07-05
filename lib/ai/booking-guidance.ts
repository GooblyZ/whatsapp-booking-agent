// lib/ai/booking-guidance.ts
// Server-side only. PURE — no DB, no Gemini, no I/O.
//
// Slice E1 — ONE typed decision for the booking-GUIDANCE sub-domain, mirroring routing.ts's
// "single source of truth" doctrine (one canonical verdict; downstream link + copy both derive
// from it, so the reply can never contradict the link it's attached to). Given the customer's
// literal words + the route decision + the (Slice B) pending-offer / last-contract state, it names
// what the deterministic layer must do so a customer who clearly wants to book, asks HOW to book,
// wants the site, reports link trouble, or asks whether a booking already happened never dead-ends
// and never gets copy that contradicts the link.
//
// Business-agnostic (CLAUDE.md product principle): no service words, no industry assumptions — only
// operation / site / trouble / status SHAPES. Every false positive fails SAFE (a booking link + a
// truthful "you book on the site" line — never anything harmful). Pure + truth-table-testable:
// every business/turn-state input is passed in explicitly by the caller (the Slice-B discipline),
// so this module imports no runtime state and closes over nothing.

import type { Route, RouteReason } from "./routing";

// Hebrew word boundary via explicit codepoints (JS \b doesn't work on Hebrew), allowing the
// standard one-letter prefixes ב/ה/ל/ו/ש/מ/כ but never mid-word. Self-contained (same pattern as
// routing.ts) so this module stays pure and free of any import cycle with platform-turn.ts.
const HEB = `${String.fromCharCode(0x0590)}-${String.fromCharCode(0x05ff)}`;
const tok = (term: string): string => `(?<![${HEB}])[בהלושמכ]?${term}`;
const reFrom = (terms: string[]): RegExp => new RegExp(terms.map(tok).join("|"));

// A QUESTION (has "?" or opens with a question word). Local mini-copy of the platform-turn predicate
// to avoid an import cycle — deliberately small; drift is harmless (a miss falls through to today's
// behavior). Used to keep a STATEMENT ("קבעתי") out of the status-QUESTION class.
const Q_MARK_RE = /[?？]/;
const Q_WORD_RE = /^(?:אז\s+)?(?:כן\s+)?(?:מה|האם|נו|קבעת|נקבע)\b/;
function looksLikeQuestion(t: string): boolean {
  return Q_MARK_RE.test(t) || Q_WORD_RE.test(t);
}

// ── PREDICATES (pure; each recognizes a SHAPE, never an industry) ─────────────────────────────────

// "how does one BOOK?" — a HOW question about CREATING an appointment. CREATE stems ONLY, so
// "איך מבטלים"/"איך משנים" (cancel/reschedule) stay manage-help, never booking guidance.
const HOWTO_Q_RE = /איך|כיצד|אפשר\s+להסביר|תסביר/;
const CREATE_STEM_RE = reFrom(["קובע", "קובעים", "לקבוע", "לקבע", "קביעת", "מזמינ", "להזמין", "הזמנ", "מתאמ", "לתאם", "תיאום"]);
const CLOSE_APPT_RE = /(?:סוגר|לסגור|סוגרים)\s+ה?תור/; // "סוגרים תור" (close an appointment) — require תור so hours-questions ("מתי סוגרים?") never trip
export function isBookingHowTo(message: string): boolean {
  const t = (message ?? "").trim();
  if (!HOWTO_Q_RE.test(t)) return false;
  return CREATE_STEM_RE.test(t) || CLOSE_APPT_RE.test(t);
}

// "I need / send me / how do I reach the SITE" — website access. Deliberately SITE nouns only
// (אתר / עמוד הזמנות). Link nouns (קישור/לינק) stay owned by Slice B's explicit-link-request /
// continuation resolver, so the two decision layers never fight over the same message.
const ACCESS_SHAPE_RE = /אפשר|צריך|צריכה|רוצה|תשלח|תשלחי|שלח|שלחי|לשלוח|יכול|יכולה|תן\s+לי|תני\s+לי|מגיע|להגיע|גישה|איפה|יש\s+לכם|יש\s+לך/;
// אתר with an optional ב/ה/ל prefix (האתר/באתר/לאתר/אתר), bounded so "מאתר"(locates)/"אתרוג" don't match.
// The rare "לאתר"(to locate) false-friend is accepted: it only fires WITH an access shape and fails safe.
const SITE_NOUN_RE = new RegExp(`(?<![${HEB}])[בהל]?אתר(?![${HEB}])|עמוד\\s+ה?הזמנ|דף\\s+ה?הזמנ`);
export function isSiteRequest(message: string): boolean {
  const t = (message ?? "").trim();
  return SITE_NOUN_RE.test(t) && ACCESS_SHAPE_RE.test(t);
}

// A LINK/BUTTON TROUBLE report — a trouble shape co-located with a button/link noun. The customer
// is on WhatsApp; the CTA button may not render on every device. Distinct from a link REQUEST.
const TROUBLE_SHAPE_RE = /אין|לא\s+רוא|לא\s+עוב|לא\s+נפת|לא\s+מופ|נעל(?:ם|מ)|לא\s+נכנס|נשבר|תקוע|לא\s+לוח|לא\s+מצליח/;
const LINK_BUTTON_NOUN_RE = /כפתור|קישור|לינק/;
export function isLinkTrouble(message: string): boolean {
  const t = (message ?? "").trim();
  return TROUBLE_SHAPE_RE.test(t) && LINK_BUTTON_NOUN_RE.test(t);
}

// "did you book it?" — a QUESTION about whether an appointment now exists. Question-shaped so the
// imperative "תקבע לי" (book for me) stays BOOK_ACTION, and the statement "קבעתי" isn't caught.
const STATUS_RE = /קבעת|נקבע|סגרת\s+לי\s+תור|יש\s+לי\s+תור\s+עכשיו|התור\s+שלי\s+מסודר|סוכם\s+ה?תור/;
export function isBookingStatusQuestion(message: string): boolean {
  const t = (message ?? "").trim();
  if (!looksLikeQuestion(t)) return false;
  return STATUS_RE.test(t);
}

// ── THE VERDICT ───────────────────────────────────────────────────────────────────────────────────

export type GuidanceIntent =
  | "BOOK_ACTION" | "BOOK_HOWTO" | "SITE_REQUEST" | "LINK_TROUBLE" | "STATUS_QUESTION" | "NONE";
export type GuidanceLink = "booking" | "manage" | "none";
export type GuidanceCopy = "BOOK_GUIDANCE" | "TROUBLE_RECOVERY" | "STATUS_CLARIFY" | "WHICH_LINK" | "KEEP_MODEL";
export interface BookingGuidanceVerdict {
  intent: GuidanceIntent;
  /** Which link the deterministic layer should attach (booking/manage), or none (a clarify / keep-model turn). */
  link: GuidanceLink;
  /** Which deterministic copy to use, or KEEP_MODEL to leave the model's own reply untouched (exploration). */
  copy: GuidanceCopy;
}
export interface BookingGuidanceInput {
  /** The latest customer fragment (same value the routing block sees as `latest`). */
  latest: string;
  /** The canonical route decision (resolveRoute) — an INPUT, never re-derived here. */
  route: Route;
  reason: RouteReason;
  /** Caller-computed: `latest` references a service (hasBookingSignal) but is NOT an operation verb
   *  and NOT a question — the shape of a bare service ANSWER ("צבע"). Drives BOOK_ACTION trigger (b). */
  serviceSignal: boolean;
  /** Caller-computed: an active booking thread exists — a pending BOOK offer, or our last reply
   *  offered / sent a booking link. Gates trigger (b) so a cold service word never forces a link. */
  bookingContextActive: boolean;
  /** Caller-computed: any booking/service signal in `latest` (hasBookingSignal) — a link-trouble
   *  fallback so "אין כפתור לקבוע תור" attaches booking rather than clarifying. */
  messageBookingSignal: boolean;
  /** Caller-computed: the kind of the LAST FULFILLED (actually-sent) link, else "none". Makes a
   *  link-trouble resend kind-exact (booking vs manage) instead of guessing. */
  fulfilledKind: GuidanceLink;
}

/**
 * Precedence (top to bottom; intents can't disagree because exactly one verdict is returned):
 *   LINK_TROUBLE > STATUS_QUESTION > SITE_REQUEST > BOOK_HOWTO > BOOK_ACTION > NONE.
 * A broken-link complaint wins outright (never mis-read as anything else). LINK_TROUBLE is
 * context-aware — resend the exact fulfilled kind, else (booking signal / site words in the message)
 * a booking link, else a short which-link clarification — never a blind booking guess. STATUS is a
 * no-link clarification. SITE / HOW-TO / explicit-BOOK / service-pick-in-context all get booking
 * guidance + a booking link. Everything else keeps the model's own reply (exploration).
 */
export function resolveBookingGuidance(i: BookingGuidanceInput): BookingGuidanceVerdict {
  const t = (i.latest ?? "").trim();

  if (isLinkTrouble(t)) {
    if (i.fulfilledKind !== "none") return { intent: "LINK_TROUBLE", link: i.fulfilledKind, copy: "TROUBLE_RECOVERY" };
    if (i.messageBookingSignal || isSiteRequest(t)) return { intent: "LINK_TROUBLE", link: "booking", copy: "TROUBLE_RECOVERY" };
    return { intent: "LINK_TROUBLE", link: "none", copy: "WHICH_LINK" };
  }
  if (isBookingStatusQuestion(t)) return { intent: "STATUS_QUESTION", link: "none", copy: "STATUS_CLARIFY" };
  if (isSiteRequest(t)) return { intent: "SITE_REQUEST", link: "booking", copy: "BOOK_GUIDANCE" };
  if (isBookingHowTo(t)) return { intent: "BOOK_HOWTO", link: "booking", copy: "BOOK_GUIDANCE" };
  // BOOK_ACTION — (a) the customer's own words named the book operation (high confidence), or
  // (b) a bare service answer WHILE booking context is active (the "assistant asked which service →
  // 'צבע'" continuation). Trigger (b) requires active context, so a plain service FAQ never fires it.
  if (i.reason === "message_verb" && i.route === "BOOK") return { intent: "BOOK_ACTION", link: "booking", copy: "BOOK_GUIDANCE" };
  if (i.serviceSignal && i.bookingContextActive) return { intent: "BOOK_ACTION", link: "booking", copy: "BOOK_GUIDANCE" };
  return { intent: "NONE", link: "none", copy: "KEEP_MODEL" };
}
