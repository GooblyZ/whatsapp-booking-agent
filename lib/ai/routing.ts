// lib/ai/routing.ts
// Server-side only. PURE — no DB, no Gemini, no I/O.
//
// SINGLE SOURCE OF TRUTH for appointment routing. Once resolveRoute() returns a Route,
// EVERY downstream behavior (which link to attach, the wording/fence, the follow-up reply)
// MUST derive from it — no component may re-interpret intent later. This removes the class
// of bugs where the coarse `intent` field, the fine `appointmentIntent` field, and the
// user's own words disagreed and different layers silently picked different answers
// (e.g. model intent="booking" + appointmentIntent="LIST" → a booking link on a LIST ask).
//
// Precedence (most reliable signal first):
//   1. Not actionable — the model judged this is NOT a request to DO something (an FAQ,
//      small talk, or a QUESTION about an operation like "how much to cancel?") → NONE.
//   2. The user's OWN WORDS — an explicit operation verb (book / view / cancel / change)
//      is authoritative for WHICH operation. This overrides a model mislabel, which is
//      common when an appointment already exists (the model flips BOOK↔LIST).
//   3. Otherwise the model's understanding, with appointmentIntent (fine) taking
//      precedence over intent (coarse) so the two model fields can never disagree silently.

import type { ReceptionistTurn } from "./brain";

type Understanding = ReceptionistTurn["understanding"];

export type Route = "BOOK" | "LIST" | "RESCHEDULE" | "CANCEL" | "NONE";
export type RouteReason = "not_actionable" | "message_verb" | "model_intent";
export interface RouteDecision {
  route: Route;
  reason: RouteReason;
  /** What the MODEL alone implied — lets callers detect an override (route !== modelRoute). */
  modelRoute: Route;
}

// Hebrew word boundary via explicit codepoints (JS \b doesn't work on Hebrew). Allows the
// standard one-letter prefixes ב/ה/ל/ו/ש/מ/כ (so "לקבוע"/"ולבטל" match) but never mid-word.
// Self-contained (no coupling to platform-turn) to keep this module pure and importable.
const HEB = `${String.fromCharCode(0x0590)}-${String.fromCharCode(0x05ff)}`;
const tok = (term: string): string => `(?<![${HEB}])[בהלושמכ]?${term}`;
const reFrom = (terms: string[]): RegExp => new RegExp(terms.map(tok).join("|"));

// Operation VERBS — business-agnostic (every appointment business has book/view/cancel/
// change). These are OPERATION words, never service words: the service is irrelevant to
// WHICH operation the customer is requesting (CLAUDE.md product principle).
const CREATE_VERBS = ["לקבוע", "לקבע", "קביעת", "לתאם", "תיאום", "להזמין", "הזמנה"];
const LIST_VERBS = ["לראות", "להציג", "להראות", "תראה", "תראי", "רשימת"];
const CANCEL_VERBS = ["לבטל", "ביטול"];
const RESCHEDULE_VERBS = ["לשנות", "להזיז", "לדחות", "להקדים", "לעדכן"];

const CREATE_RE = reFrom(CREATE_VERBS);
const LIST_RE = reFrom(LIST_VERBS);
const CANCEL_RE = reFrom(CANCEL_VERBS);
const RESCHEDULE_RE = reFrom(RESCHEDULE_VERBS);
// Multi-word phrases the single-token matcher can't express.
const LIST_PHRASE_RE = /כל\s+ה?תורים|ה?תורים\s+שלי|מה\s+ה?תורים|אילו\s+ה?תורים|איזה\s+ה?תורים|ה?תורים\s+הקיימים/;
const RESCHEDULE_PHRASE_RE = /מחדש|מחודש/;
// An appointment REFERENCE — required to read a GENERIC view-verb ("תראה"/"לראות") as a LIST
// request. Without it, bare "תראה"/"הנה תראה" is discourse ("look here"), not "show my
// appointments" (the live false-route). The explicit LIST_PHRASE_RE stands on its own.
const APPT_REF_RE = /תור|פגיש|הזמנ|מועד/;

/**
 * Classifies the OPERATION from the user's own words, or null if no operation verb is
 * present. Precedence among multiple signals: RESCHEDULE > CANCEL > LIST > BOOK — so
 * "לבטל ולקבוע מחדש" (cancel & re-book) resolves to RESCHEDULE, not a fresh BOOK. Pure.
 */
// ── E3 (behavior class B — action negation / reversal): a negation/mistake cue in the SAME clause as an
//    operation verb ("לא רציתי לבטל", "בטעות ביטלתי") means that operation is being RETRACTED — it must
//    not route to a manage/cancel link. Partial negation is respected by PRECEDENCE: "לא לבטל, רק לשנות"
//    negates CANCEL but leaves RESCHEDULE affirmed → RESCHEDULE (checked first). Shape-based, not phrases.
const NEG_CUE = `(?<![${HEB}])(?:לא|אל|בטעות|בעצם\\s+לא|לא\\s+רצית(?:י|ה)?|לא\\s+צרי[כך]|לא\\s+רוצ(?:ה|ים)?)`;
/** True when a negation cue precedes the verb within the SAME clause (≤2 words). Clause-scoped so an
 *  affirmed op in a later clause ("…רק לשנות") is never counted as negated by an earlier "לא". */
function negatedNear(clause: string, term: string): boolean {
  return new RegExp(`${NEG_CUE}(?:\\s+\\S+){0,2}\\s+[בהלושמכ]?${term}`).test(clause);
}
/** True when EVERY clause that contains one of the op's verbs negates it (the op is being retracted).
 *  Clauses split on punctuation + affirmation cues (רק/אבל/אלא), so "לא לבטל, רק לשנות" negates only
 *  CANCEL and leaves RESCHEDULE affirmed. */
function opNegated(text: string, terms: string[]): boolean {
  const clauses = text.split(/[,.;!?]|\s+רק\s+|\s+אבל\s+|\s+אלא\s+/);
  let anyPresent = false;
  let allNegated = true;
  for (const clause of clauses) {
    for (const term of terms) {
      if (new RegExp(tok(term)).test(clause)) {
        anyPresent = true;
        if (!negatedNear(clause, term)) allNegated = false;
      }
    }
  }
  return anyPresent && allNegated;
}
function anyOpVerbPresent(text: string): boolean {
  return RESCHEDULE_RE.test(text) || RESCHEDULE_PHRASE_RE.test(text) || CANCEL_RE.test(text)
    || LIST_RE.test(text) || LIST_PHRASE_RE.test(text) || CREATE_RE.test(text);
}

export function messageOperation(message: string): Route | null {
  const t = (message ?? "").trim();
  if (!t) return null;
  if ((RESCHEDULE_RE.test(t) || RESCHEDULE_PHRASE_RE.test(t)) && !opNegated(t, RESCHEDULE_VERBS)) return "RESCHEDULE";
  if (CANCEL_RE.test(t) && !opNegated(t, CANCEL_VERBS)) return "CANCEL";
  // LIST is the most over-triggered op: a generic view-verb counts only WITH an appointment
  // reference ("תראה לי את התור"); the explicit phrase ("התורים שלי") stands alone. Bare
  // "תראה"/"הנה תראה" (discourse "look here") no longer false-routes to a manage link.
  if ((LIST_PHRASE_RE.test(t) || (LIST_RE.test(t) && APPT_REF_RE.test(t))) && !opNegated(t, LIST_VERBS)) return "LIST";
  if (CREATE_RE.test(t) && !opNegated(t, CREATE_VERBS)) return "BOOK";
  return null;
}

/** E3 (class B): an operation verb is PRESENT but the user retracted it ("לא רציתי לבטל") — so
 *  messageOperation returned null. resolveRoute forces NONE on this so a retraction never falls through
 *  to the model's route; the reversal reply lane owns the wording. Pure. */
export function isNegatedOperation(message: string): boolean {
  const t = (message ?? "").trim();
  return anyOpVerbPresent(t) && messageOperation(t) === null;
}

const APPT_TO_ROUTE: Record<string, Route> = {
  BOOK: "BOOK", LIST: "LIST", CANCEL: "CANCEL", RESCHEDULE: "RESCHEDULE", MODIFY: "RESCHEDULE",
};
const INTENT_TO_ROUTE: Record<string, Route> = {
  booking: "BOOK", cancel_request: "CANCEL", reschedule_request: "RESCHEDULE",
};

/**
 * The route implied by the MODEL alone. appointmentIntent (fine-grained) wins; the coarse
 * `intent` is only a fallback when appointmentIntent is NONE — so the two model fields can
 * never disagree silently (the live bug: intent="booking" + appointmentIntent="LIST").
 */
export function modelOperation(u: Understanding): Route {
  return APPT_TO_ROUTE[u.appointmentIntent] ?? INTENT_TO_ROUTE[u.intent] ?? "NONE";
}

/** THE routing decision. Single source of truth — call once per turn, derive everything. */
export function resolveRoute(u: Understanding, message: string): RouteDecision {
  const modelRoute = modelOperation(u);
  // 1) Not a request to DO something → no operation, no link.
  if (u.requestsBusinessAction !== true) return { route: "NONE", reason: "not_actionable", modelRoute };
  // 2) The user's explicit verb is authoritative for WHICH operation.
  const msgOp = messageOperation(message);
  if (msgOp) return { route: msgOp, reason: "message_verb", modelRoute };
  // 2b) E3 (class B): the user RETRACTED an operation ("לא רציתי לבטל") — never fall through to the
  //     model's route (which may still say CANCEL). Force NONE; the reversal reply lane owns the wording.
  if (isNegatedOperation(message)) return { route: "NONE", reason: "not_actionable", modelRoute };
  // 3) Otherwise trust the (reconciled) model understanding.
  return { route: modelRoute, reason: "model_intent", modelRoute };
}

export type LinkKind = "booking" | "manage" | null;

/** The link family a route maps to. BOOK → booking page; any manage op (LIST/RESCHEDULE/
 *  CANCEL) → the manage page (it lets the customer view AND change/cancel); NONE → none. */
export function linkKindForRoute(route: Route): LinkKind {
  if (route === "BOOK") return "booking";
  if (route === "LIST" || route === "RESCHEDULE" || route === "CANCEL") return "manage";
  return null;
}
