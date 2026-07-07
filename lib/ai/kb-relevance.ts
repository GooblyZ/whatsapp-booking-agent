// lib/ai/kb-relevance.ts
// PURE — zero imports. Decides HOW MUCH knowledge-base to inject for a Gemini-bound turn (Gate A).
//
// Today buildFacts sends the FULL KB on nearly every turn (scopeKnowledge only trims for a single
// parking/policy/contact/about topic on a large KB). That over-sends KB on greetings, acks, pure
// booking/link turns, guard turns, etc. — hurting persona strength, latency, cost and 503 exposure.
//
// This classifier replaces that with a CONSERVATIVE 3-tier policy (owner-approved boundary):
//   • "none"   — send NO KB items (structured facts only). ONLY for HIGH-CONFIDENCE non-informational
//                turns: a pure link/ack/closure/greeting, OR a booking imperative WITH an already-known
//                service AND no informational question.
//   • "scoped" — a recognized specific info TOPIC (parking/policy/contact/about) → about/faq + that
//                category (via scopeKnowledge).
//   • "broad"  — any info-question shape without a single scopable topic, OR anything ambiguous / any
//                doubt → the (capped) full KB.
//
// SAFETY: the target is relevant-KB-by-default, NOT maximum removal. Any uncertainty biases toward
// keeping KB (scoped/broad) so a real FAQ is never starved into a false "I don't know". Over-matching
// an info cue is harmless (it just keeps KB); the grounding fence remains the backstop. Deterministic
// guard/greeting/injection turns never reach a prompt build, so they never reach this function.
//
// Owner examples that MUST stay out of "none":
//   "רוצה תספורת, כמה עולה?" · "כמה עולה החלקה?" · "מה השירותים שלכם?" · "כמה זמן זה לוקח?"
//   "זה מתאים למתחילים?" · any price / duration / policy / details / suitability / prep / staff /
//   hours-location-nuance / open FAQ question.
// Owner examples that MAY be "none": pure link request ("שלח קישור"), booking with a KNOWN service and
//   no question ("אני רוצה לקבוע תור לתספורת"), short ack/closure ("אש"/"סבבה"/"תודה"), greeting.

export type KbTier = "none" | "scoped" | "broad";

export interface KbNeedSignals {
  /** The current customer message (raw). */
  message: string;
  /** A service is already known for this turn — named in this message (or carried in — caller's call). */
  serviceKnown: boolean;
  /** The message is a clear booking imperative ("רוצה לקבוע", "לקבוע תור", "תקבע לי"). */
  bookingImperative: boolean;
  /** The message is a bare non-informational action: link (re)send request, short ack/closure, greeting. */
  nonInfoAck: boolean;
  /** detectInfoTopic(message) matched a SCOPABLE KB topic (parking/policy/contact/about). Passed in (not
   *  imported) so this module stays pure and unit-testable. */
  infoTopicRecognized: boolean;
}

const INFO_QUESTION_MARK = /[?？]/;

// A BOUNDED, industry-neutral set of "informational intent" cues. NOT a per-phrase branch list: it exists
// only to KEEP KB when a message asks something informational (price, duration, policy, requirements,
// suitability, logistics, staff). Over-inclusion is safe (keeps KB); under-inclusion is caught by the
// "broad" default for non-action turns + the KB-starvation eval. Vertical-neutral — no service names.
const INFO_CUE_RE = new RegExp(
  [
    "כמה",                                   // how much / how many (price, duration, count)
    "מחיר|עולה|עלות|תעריף|מחירון|יקר|זול",     // price
    "משך|לוקח|אורך|נמשך",                      // duration
    "מדיניות|ביטול|לבטל|החזר|דמי|קנס",          // policy / cancellation
    "מתאים|למתחילים|מתחיל|מומלץ|כדאי|עדיף|הבדל|ההבדל|שווה", // suitability / recommendation
    "כולל|מקבל|מה\\s*יש|מה\\s*כולל",            // what's included / what's there
    "להביא|הכנה|דרוש|דורש|תנאי|צריך\\s*ל|לפני\\s*ה", // requirements / prep
    "חניה|כתובת|איפה|היכן|שעות|פתוח|פתוחים|סגור|מיקום|להגיע|הגעה|נגיש|נגישות", // logistics
    "מטפל|ספר(?:ית)?|מדריכ|רופא|קוסמטיק|נותן\\s*השירות|איש\\s*מקצוע|אצל\\s*מי|מי\\s", // staff / provider
    "האם|אפשר\\s*לדעת|רציתי\\s*לשאול|שאלה|יש\\s*לכם|יש\\s*לך", // explicit question framing
    "שירותים|טיפולים|מה\\s*אתם\\s*מציעים|ספר\\s*לי\\s*על|על\\s*העסק", // open FAQ / services overview
  ].join("|")
);

// Hebrew final-form-aware booking-CREATE verbs (KB-tiering only — NOT the routing detector). Bounded and
// business-agnostic. Final letters ך/ן allowed where relevant.
const BOOKING_IMPERATIVE_RE =
  /לקבוע|תקבע|נקבע|לתאם|תתאם|לזמן|להזמין\s*תור|רוצה\s*תור|צריך\s*תור|קביעת\s*תור|לסגור\s*תור/;

// Pure link (re)send request.
const LINK_REQUEST_RE = /(?:שלח|תשלח|לשלוח|תביא|איפה|שוב).{0,12}(?:קישור|לינק)|(?:קישור|לינק).{0,12}(?:שוב|בבקשה)/;

// Bare short ack / closure — the WHOLE message is essentially one closure token (+ light punctuation).
const BARE_ACK_RE =
  /^(?:אש|סבבה(?:\s*גמור)?|תודה(?:\s*רבה)?|יופי|מעולה|מצוין|אחלה|אוקיי?|כן|בסדר|טוב|היידה|וואו|אדיר|מגניב|פצצה|תנקס|קיבלתי|הבנתי|ביי|נתראה)\s*[!.…🙂😊👍]*$/;

// Bare greeting — the WHOLE message is a greeting (a first-turn greeting still needs no KB).
const BARE_GREETING_RE =
  /^(?:היי+|הי|שלום|אהלן|הולו|יו|בוקר\s*טוב|צהריים\s*טובים|ערב\s*טוב|לילה\s*טוב|מה\s*נשמע|מה\s*קורה|מה\s*המצב)\s*[!,.…🙂😊]*$/;

/** True when the message carries an informational question/intent (a "?" or a bounded info cue). */
export function hasInfoQuestionShape(message: string): boolean {
  const m = message ?? "";
  return INFO_QUESTION_MARK.test(m) || INFO_CUE_RE.test(m);
}

/** True when the message contains a clear booking-CREATE imperative (KB-tiering heuristic, not routing). */
export function isBookingImperative(message: string): boolean {
  return BOOKING_IMPERATIVE_RE.test(message ?? "");
}

/** True for a bare non-informational action: a link (re)send request, a short ack/closure, or a greeting. */
export function isNonInfoAck(message: string): boolean {
  const m = (message ?? "").trim();
  return LINK_REQUEST_RE.test(m) || BARE_ACK_RE.test(m) || BARE_GREETING_RE.test(m);
}

/** True when the message names one of the business's configured services (bare inclusion, case-as-is). */
export function messageNamesService(message: string, serviceNames: string[] = []): boolean {
  const m = message ?? "";
  return serviceNames.some((n) => n && n.trim().length >= 2 && m.includes(n.trim()));
}

/**
 * Conservative KB-need classification. Precedence:
 *   1) informational (scopable topic OR info-question shape) → "scoped" if a single scopable topic is
 *      recognized, else "broad". (Info ALWAYS keeps KB — never "none".)
 *   2) a bare non-info action (link/ack/greeting) → "none".
 *   3) a booking imperative WITH a known service (and no info, per #1) → "none".
 *   4) otherwise (ambiguous, booking w/o known service, bare service mention, …) → "broad" (safe default).
 */
export function classifyKbNeed(s: KbNeedSignals): KbTier {
  if (s.infoTopicRecognized || hasInfoQuestionShape(s.message)) {
    return s.infoTopicRecognized ? "scoped" : "broad";
  }
  if (s.nonInfoAck) return "none";
  if (s.bookingImperative && s.serviceKnown) return "none";
  return "broad";
}
