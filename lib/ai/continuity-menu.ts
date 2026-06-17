// lib/ai/continuity-menu.ts
// Server-side only. NO Gemini, NO DB writes — pure functions over BusinessFacts.
//
// THE DETERMINISTIC WHATSAPP MENU / FAQ CORE (no-AI states).
// When the AI is unavailable (owner-disabled, sustained provider outage, or an internal
// AI/parse error) the receptionist must still be USEFUL — a navigable menu plus real
// business-info answers drawn from the business's OWN data — instead of one repeated
// canned line or, worse, silence. This module is the reusable core; platform-turn.ts
// calls planContinuityMenu() from the shared runContinuity() path.
//
// BUSINESS-AGNOSTIC by construction (CLAUDE.md "Product principle"): it classifies
// business OPERATIONS / info CATEGORIES, never industry types. Menu options and answers
// come entirely from the business's facts/KB (services, hours, location, knowledge_base_
// items) — a Pilates studio, a clinic and a hair salon all flow through the same words.
// No hardcoded per-question answers and no salon vocabulary live here.
//
// SAFETY: answers are rendered straight from structured facts (the same source the
// grounding fence validates) — never invented. A recognized question we cannot answer
// returns the info submenu (never a guess, never silence). Booking/manage links are
// NOT attached here — only an EXPLICIT booking/manage operation (handled upstream in
// classifyDegradedIntent) attaches a link.

import type { BusinessFacts } from "./facts";
import type { DegradedReason } from "./platform-turn"; // type-only (erased) — no runtime cycle
import type { WhatsAppInteractive } from "@/lib/whatsapp"; // type-only — interactive (clickable) shape

// ── Reason-specific notice prefixes (mirror continuityText's wording policy) ──────
// ai_disabled is the owner's deliberate choice → NEUTRAL (never "overload"/"limited").
// provider_outage explains a momentary system load; ai_error is a soft "limited mode".
const OUTAGE_NOTICE = "יש לי רגע עומס קטן במערכת 🙏";
const AI_ERROR_NOTICE = "אני במצב מצומצם כרגע 🙏";
function reasonNotice(reason: DegradedReason): string | null {
  if (reason === "provider_outage") return OUTAGE_NOTICE;
  if (reason === "ai_error") return AI_ERROR_NOTICE;
  return null; // ai_disabled (and provider_transient never reaches here) → neutral
}
function withNotice(reason: DegradedReason, body: string): string {
  const n = reasonNotice(reason);
  return n ? `${n}\n${body}` : body;
}

// ── Business-info TOPICS — generic categories, not industry verbs ─────────────────
// Each maps onto structured facts and/or a knowledge_base category. Detection uses
// generic question shapes ("מה השעות", "יש חניה", "איפה אתם") that hold across verticals.
export type InfoTopic = "hours" | "prices" | "location" | "parking" | "policy" | "contact" | "about";

// Order matters: more specific topics first (parking before the broader location).
const TOPIC_PATTERNS: { topic: InfoTopic; re: RegExp }[] = [
  { topic: "parking", re: /חני+ה|חניון|לחנות|איפה\s+חונים|חונים|parking/ },
  { topic: "hours", re: /שעות|מתי\s+(אתם\s+)?(פתוח|פתוחים|סגור|סגורים|עובדים|עובד)|פתוחים|פתוח\b|סגורים|עד\s+מתי|ממתי|שעות\s+פתיחה|opening\s+hours|hours/ },
  { topic: "prices", re: /מחיר|מחירון|מחירים|כמה\s+(זה\s+)?(עולה|עולים|יעלה|עולות|עלה)|עלות|תעריף|כמה\s+אני\s+משלם|price|cost/ },
  { topic: "location", re: /איפה\s+(אתם|זה|נמצא|המקום)|כתובת|מיקום|איך\s+(מגיעים|להגיע|אני\s+מגיע|מגיע)|נמצאים|הכתובת|where\s+are|address|location/ },
  { topic: "policy", re: /מדיניות|דמי\s+ביטול|תנאי\s+ביטול|מה\s+קורה\s+אם\s+אני\s+מבטל|policy|cancellation\s+policy/ },
  { topic: "contact", re: /טלפו[נן]|מספר\s+(טלפון|שלכם)|ליצור\s+קשר|איך\s+(ליצור|מתקשרים|להתקשר)|phone\s+number|contact/ },
  { topic: "about", re: /מי\s+אתם|על\s+העסק|ספרו\s+לי\s+על|קצת\s+על|מה\s+זה\s+ה?עסק|about\s+(you|the)/ },
];

/** The business-info topic a message asks about, or null. Generic shapes only. */
export function detectInfoTopic(message: string): InfoTopic | null {
  const t = (message ?? "").trim();
  if (!t) return null;
  for (const { topic, re } of TOPIC_PATTERNS) if (re.test(t)) return topic;
  return null;
}

// Explicit "show me the menu / options" request — an intentional navigation choice,
// NEVER spam (so it's exempt from the menu rate-limit).
const MENU_REQUEST_RE =
  /^\s*(תפריט|תפריט\s+ראשי|חזרה\s+לתפריט|תחזור\s+לתפריט|אפשרויות|מה\s+אפשר|מה\s+אפשר\s+לעשות|מה\s+אתם\s+מציעים|menu|main\s+menu)\s*[?!.…]*\s*$/;
export function isMenuRequest(message: string): boolean {
  return MENU_REQUEST_RE.test((message ?? "").trim());
}

// ── "Is this a real business question?" (distinct from a vague/greeting repeat) ───
// Self-contained (no import from platform-turn → no cycle). A multi-word message that
// is question-shaped (has '?' / a question word / a FAQ opener) and isn't an obvious
// greeting or keyboard-smash. Used to decide answer-or-submenu vs the rate-limited menu.
const QUESTION_WORD_RE = /^(כמה|מה|האם|למה|מדוע|איך|כיצד|איפה|היכן|מתי|אילו|איז[הו])(\s|$|[?？])/;
const FAQ_OPENER_RE = /^(אפשר|מקבלים|מקבל|אתם|פתוחים|פתוח|האם|יש)(\s|$|[?？])/;
const GREETING_RE = /^(היי+|הי|שלום|הלו+|אהלן|בוקר טוב|ערב טוב|מה קורה|מה נשמע|מה המצב|מה שלומך)(?=\s|$)/;
export function isBusinessQuestion(message: string): boolean {
  const t = (message ?? "").trim();
  if (t.length < 4 || !/\s/.test(t)) return false;             // multi-word only
  if (GREETING_RE.test(t)) return false;                       // a greeting is not a business Q
  const questionShaped = /[?？]/.test(t) || QUESTION_WORD_RE.test(t) || FAQ_OPENER_RE.test(t);
  return questionShaped;
}

// ── Deterministic ANSWER resolvers (straight from facts — grounded, never invented) ─
function renderHours(facts: BusinessFacts): string | null {
  if (!facts.hours.length) return null;
  const lines = facts.hours.map((h) =>
    `- ${h.day}: ${h.closed || !h.opens || !h.closes ? "סגור" : `${h.opens}-${h.closes}`}`
  );
  return `שעות הפתיחה שלנו:\n${lines.join("\n")}`;
}
function renderPrices(facts: BusinessFacts): string | null {
  if (!facts.services.length) return null;
  const lines = facts.services.map((s) => {
    const price = s.price != null ? ` — ₪${s.price}` : "";
    const dur = s.durationMin ? ` (${s.durationMin} דק׳)` : "";
    return `- ${s.name}${price}${dur}`;
  });
  return `המחירים והשירותים שלנו:\n${lines.join("\n")}`;
}
function kbContent(facts: BusinessFacts, category: string): string | null {
  const item = facts.knowledge.find((k) => k.category === category && k.content.trim());
  return item ? item.content.trim() : null;
}
function renderLocation(facts: BusinessFacts): string | null {
  const where = [facts.location.address, facts.location.city].filter(Boolean).join(", ");
  if (!where) return kbContent(facts, "contact"); // some businesses keep the address in a KB item
  const parking = kbContent(facts, "parking");
  return parking ? `הכתובת שלנו: ${where}\n${parking}` : `הכתובת שלנו: ${where}`;
}
function renderContact(facts: BusinessFacts): string | null {
  const kb = kbContent(facts, "contact");
  if (facts.phone) return kb ? `אפשר ליצור קשר בטלפון: ${facts.phone}\n${kb}` : `אפשר ליצור קשר בטלפון: ${facts.phone}`;
  return kb;
}

/** A deterministic answer for a recognized topic, or null when the business has no data
 *  for it (caller then offers the submenu — never a guess). */
export function resolveInfoAnswer(facts: BusinessFacts, topic: InfoTopic): string | null {
  switch (topic) {
    case "hours": return renderHours(facts);
    case "prices": return renderPrices(facts);
    case "location": return renderLocation(facts);
    case "parking": return kbContent(facts, "parking") ?? renderLocation(facts);
    case "policy": return kbContent(facts, "policy");
    case "contact": return renderContact(facts);
    case "about": return kbContent(facts, "about");
  }
}

// ── Conservative KB lookup for a recognized question with NO structured topic ──────
// Deliberately NOT a RAG engine (CLAUDE.md: don't overbuild). High-precision token
// overlap: a KB item matches when the question shares a salient (≥3-char) token with the
// item's TITLE, or contains a ≥4-char token present in the item's CONTENT. Returns the
// item's content, or null (→ submenu). Never returns a low-confidence guess.
const KB_STOPWORDS = new Set([
  "אפשר", "האם", "יש", "לי", "לכם", "שלכם", "שלי", "אתם", "אתה", "את", "מה", "כמה", "איך",
  "כאן", "שם", "זה", "של", "על", "עם", "אבל", "גם", "רק", "כדי", "בבקשה", "תודה",
]);
function tokens(s: string): string[] {
  return (s ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => w.length >= 3 && !KB_STOPWORDS.has(w));
}
export function findKbAnswer(facts: BusinessFacts, message: string): string | null {
  const qTokens = tokens(message);
  if (!qTokens.length) return null;
  for (const k of facts.knowledge) {
    if (!k.content.trim()) continue;
    const titleTokens = new Set(tokens(k.title));
    if (qTokens.some((q) => titleTokens.has(q))) return k.content.trim();
    const contentTokens = new Set(tokens(k.content));
    if (qTokens.some((q) => q.length >= 4 && contentTokens.has(q))) return k.content.trim();
  }
  return null;
}

// ── Menu builders — only show options the business can actually serve ─────────────
// Options are NUMBERED so the customer can reply with a digit (mapped back to the same
// capability-gated ordering next turn) OR the word/alias OR — once the WhatsApp stack
// supports it — a button payload. The numbering/labels are the button-ready contract.
// After an answer we show a short nav footer so the flow feels like a real menu, not a
// disconnected one-off reply.
const ANSWER_FOOTER =
  "\n\nמה הלאה?\n• עוד מידע — כתבו \"שאלות נפוצות\"\n• לתפריט הראשי — כתבו \"תפריט\"\n• לקביעת תור — כתבו \"תור\"";

export type MainAction = "book" | "manage" | "faq";

/** Capability-gated main-menu options, in a STABLE order (so a numeric pick resolves to the
 *  same action the customer saw). book only when booking is enabled; faq only when any info exists. */
export function availableMainOptions(facts: BusinessFacts): { action: MainAction; label: string }[] {
  const out: { action: MainAction; label: string }[] = [];
  if (facts.bookingEnabled) out.push({ action: "book", label: "קביעת תור" });
  out.push({ action: "manage", label: "ניהול / שינוי / ביטול תור" });
  if (hasAnyInfo(facts)) out.push({ action: "faq", label: "שאלות נפוצות ומידע על העסק" });
  return out;
}

/** Which info-submenu topics the business has DATA for (so we never offer a dead option). */
export function availableInfoTopics(facts: BusinessFacts): { topic: InfoTopic; label: string }[] {
  const out: { topic: InfoTopic; label: string }[] = [];
  if (facts.hours.length) out.push({ topic: "hours", label: "שעות פתיחה" });
  if (facts.services.length) out.push({ topic: "prices", label: "מחירים ושירותים" });
  if (facts.location.address || facts.location.city) out.push({ topic: "location", label: "מיקום והגעה" });
  if (kbContent(facts, "parking")) out.push({ topic: "parking", label: "חניה" });
  if (kbContent(facts, "policy")) out.push({ topic: "policy", label: "מדיניות ביטולים" });
  if (facts.phone || kbContent(facts, "contact")) out.push({ topic: "contact", label: "פרטי קשר" });
  if (kbContent(facts, "about")) out.push({ topic: "about", label: "על העסק" });
  return out;
}
function hasAnyInfo(facts: BusinessFacts): boolean {
  return availableInfoTopics(facts).length > 0;
}

// The deterministic menu presents itself as the business's VIRTUAL ASSISTANT — business-aware
// (uses businessName when available) and reason-specific, but never industry-specific. ai_disabled
// is neutral (no mention of a limit); provider/internal-error states softly note the smart assistant
// is temporarily limited while still presenting the menu as useful. Generic across all verticals.
export function mainMenuBody(facts: BusinessFacts, reason?: DegradedReason): string {
  if (reason === "provider_outage")
    return "העוזר החכם מוגבל כרגע 🙏 עדיין אפשר לקבוע תור, לנהל תור או לקבל מידע דרך התפריט.";
  if (reason === "ai_error")
    return "אני במצב מצומצם כרגע 🙏 עדיין אפשר לקבוע תור, לנהל תור או לקבל מידע דרך התפריט.";
  const name = facts.businessName?.trim();
  return name
    ? `היי, אני העוזר הווירטואלי של ${name} 🙂 איך אפשר לעזור?`
    : "היי, אני העוזר הווירטואלי 🙂 איך אפשר לעזור?";
}

// Surfaced inside booking/manage cta_url cards (WhatsApp can't combine a URL button with nav
// buttons in one message) so an action card is NEVER a dead end — the customer always knows how
// to get back to the menu. "תפריט" is recognized by isMenuRequest.
export const MENU_HINT = "אפשר גם לכתוב \"תפריט\" לחזרה לתפריט הראשי 🙂";
export function ctaBody(kind: "book" | "manage"): string {
  return `${kind === "book" ? "לקביעת תור 📅" : "לניהול התור 📅"}\n${MENU_HINT}`;
}

/** The MAIN menu — book (if enabled), manage, and business-info (if any). Generic across verticals. */
export function buildMainMenu(facts: BusinessFacts, reason?: DegradedReason): string {
  const lines = availableMainOptions(facts).map((o, i) => `${i + 1}. ${o.label}`);
  return `${mainMenuBody(facts, reason)}\n${lines.join("\n")}\nאפשר לכתוב מספר, או פשוט לכתוב לי מה צריך.`;
}

/** The business-info SUBMENU — only the topics with data, numbered. */
export function buildInfoSubmenu(facts: BusinessFacts): string {
  const topics = availableInfoTopics(facts);
  if (!topics.length) return buildMainMenu(facts); // nothing to offer → fall back to the main menu
  const lines = topics.map((t, i) => `${i + 1}. ${t.label}`);
  return `על מה תרצו לשמוע?\n${lines.join("\n")}\nאפשר לכתוב מספר, את השם (למשל "שעות"), או "תפריט ראשי".`;
}

/** A category answer with the navigation footer — the unit that makes deterministic mode feel
 *  like a menu flow (answer → "what next" options). */
export function buildCategoryAnswer(answer: string): string {
  return `${answer}${ANSWER_FOOTER}`;
}

// ── The planner — the single entry point used by runContinuity ────────────────────
export type ContinuityMenuKind = "answer" | "submenu" | "main_menu_explicit" | "vague_menu";
export interface ContinuityMenuPlan {
  kind: ContinuityMenuKind;
  text: string;                     // text fallback (full menu/answer with footer)
  topic?: InfoTopic;                // when kind === "answer" (for logs)
  interactive?: WhatsAppInteractive; // clickable version (buttons/list) — settings enforced at the chokepoint
}

/**
 * Plans the deterministic reply for a no-AI "menu" turn (the message was NOT an explicit
 * booking/manage op or a system-frame question — those are handled upstream). Decides:
 *   • answer            — a recognized topic / KB question we CAN answer from facts
 *   • submenu           — a real question we can't answer → the info submenu (never silence)
 *   • main_menu_explicit— the customer asked for the menu/options
 *   • vague_menu        — a vague/greeting/contentless repeat → caller rate-limits this one
 * Only "vague_menu" may be rate-limited/suppressed; the other three ALWAYS reply.
 */
export function planContinuityMenu(reason: DegradedReason, message: string, facts: BusinessFacts): ContinuityMenuPlan {
  const frags = (message ?? "").split("\n").map((s) => s.trim()).filter(Boolean);
  const latest = frags.length ? frags[frags.length - 1] : (message ?? "").trim();
  const either = (fn: (s: string) => boolean): boolean => fn(latest) || fn(message);

  // Explicit menu request → main menu (an intentional nav choice, never spam). The reason wording
  // is baked into the menu BODY (mainMenuBody), so no separate notice prefix is needed.
  if (either(isMenuRequest)) {
    return { kind: "main_menu_explicit", text: buildMainMenu(facts, reason), interactive: buildInteractiveMainMenu(facts, reason) };
  }

  // Recognized business-info topic → answer from facts, else the info submenu.
  const topic = detectInfoTopic(latest) ?? detectInfoTopic(message);
  if (topic) {
    const ans = resolveInfoAnswer(facts, topic);
    if (ans) return { kind: "answer", text: buildCategoryAnswer(ans), topic, interactive: buildInteractiveAnswer(ans, facts) };
    return { kind: "submenu", text: infoUnavailable(reason, facts), interactive: buildInteractiveFaqMenu(facts) };
  }

  // A genuine question with no structured topic → conservative KB lookup, else submenu.
  // Either way it is NEVER suppressed (the live bug: a real FAQ swallowed by the menu rate-limit).
  if (either(isBusinessQuestion)) {
    const kb = findKbAnswer(facts, message);
    if (kb) return { kind: "answer", text: buildCategoryAnswer(kb), interactive: buildInteractiveAnswer(kb, facts) };
    return { kind: "submenu", text: infoUnavailable(reason, facts), interactive: buildInteractiveFaqMenu(facts) };
  }

  // Vague / greeting / contentless repeat → generic main menu (caller applies the rate-limit).
  return { kind: "vague_menu", text: buildMainMenu(facts, reason), interactive: buildInteractiveMainMenu(facts, reason) };
}

/** "I don't have that in the menu right now" + the info submenu — for a recognized question
 *  we can't answer from data. Never silence, never a guess. */
function infoUnavailable(reason: DegradedReason, facts: BusinessFacts): string {
  if (!hasAnyInfo(facts)) return withNotice(reason, buildMainMenu(facts));
  return withNotice(reason, `אין לי את הפרט הזה בתפריט כרגע 🙂 אבל הנה מה שאפשר לברר:\n${stripMenuHeader(buildInfoSubmenu(facts))}`);
}
// buildInfoSubmenu opens with its own "על מה תרצו לשמוע?" header; drop it when we precede it
// with the "אין לי את הפרט הזה" line so the two intros don't stack.
function stripMenuHeader(submenu: string): string {
  return submenu.replace(/^על מה תרצו לשמוע\?\n/, "");
}

// ── MENU NAVIGATION STATE MACHINE (real WhatsApp menu flow, text now / buttons later) ──
// A tiny per-conversation menu cursor stored in conversation_states.context, so a later
// numeric ("3"), alias ("שאלות נפוצות"), back ("תפריט ראשי") or topic word resolves against
// the menu the customer is CURRENTLY in. Two nodes only — "main" and "faq" — so the engine
// stays small (CLAUDE.md: don't overbuild). AI-FIRST: the caller fires this ONLY on an explicit
// menu request or when a menu is already active (activeMenu), so a healthy-AI conversation is
// never hijacked into menu mode. TTL-bounded; the saved transcript is the durable record.
export const MENU_STATE_TTL_MS = 30 * 60 * 1000; // 30 min — a menu cursor is short-lived
export type MenuNode = "main" | "faq";
export interface MenuState { node: MenuNode; at: number; }
export function readMenuState(context: Record<string, unknown>, now: number = Date.now()): MenuState | null {
  const m = context?.menu as Partial<MenuState> | undefined;
  if (!m || (m.node !== "main" && m.node !== "faq")) return null;
  if (typeof m.at !== "number" || !Number.isFinite(m.at)) return null;
  if (now - m.at > MENU_STATE_TTL_MS || now - m.at < 0) return null;
  return { node: m.node, at: m.at };
}

// A bare numeric choice ("3", "3.", "3)") — meaningful only inside an active menu node.
function parseChoice(message: string): number | null {
  const m = (message ?? "").trim().match(/^([1-9])\s*[.)]?\s*$/);
  return m ? parseInt(m[1], 10) : null;
}
// Navigation aliases (consulted ONLY for an active menu — never against healthy free text).
const BACK_MAIN_RE = /^(תפריט|תפריט\s+ראשי|חזרה\s+לתפריט(\s+הראשי)?|חזרה\s+ראשי|ראשי|menu|main)\s*[?!.…]*$/;
const FAQ_NAV_RE = /^(שאלות\s+נפוצות|שאלות|מידע(\s+על\s+העסק)?|עוד\s+מידע|עוד\s+שאל\S*)\s*[?!.…]*$/;
const BOOK_NAV_RE = /^(קביעת\s+תור|לקבוע(\s+תור)?|תור(\s+חדש)?|להזמין(\s+תור)?)\s*[?!.…]*$/;
const MANAGE_NAV_RE = /^(ניהול(\s+תור)?|לבטל(\s+תור)?|ביטול(\s+תור)?|לשנות(\s+תור)?|להזיז(\s+תור)?|שינוי(\s+תור)?|התורים\s+שלי)\s*[?!.…]*$/;

export type MenuNav =
  | { kind: "main"; reply: string; node: "main" }
  | { kind: "faq"; reply: string; node: "faq" }
  | { kind: "answer"; reply: string; node: "faq" }
  | { kind: "book"; node: "main" }      // caller attaches the booking link + wording
  | { kind: "manage"; node: "main" };   // caller attaches the manage link + wording

function answerNav(facts: BusinessFacts, topic: InfoTopic): MenuNav {
  const ans = resolveInfoAnswer(facts, topic);
  if (ans) return { kind: "answer", reply: buildCategoryAnswer(ans), node: "faq" };
  // recognized category but no data → the info submenu (never silence, never a guess)
  if (!hasAnyInfo(facts)) return { kind: "main", reply: buildMainMenu(facts), node: "main" };
  return { kind: "faq", reply: `אין לי את הפרט הזה בתפריט כרגע 🙂 אבל הנה מה שאפשר לברר:\n${stripMenuHeader(buildInfoSubmenu(facts))}`, node: "faq" };
}

/**
 * Resolves a menu-navigation message against the current cursor. Returns null when the message
 * is NOT navigation (the caller then falls through to AI / deterministic handling — preserving
 * AI-first). Recognizes: explicit menu request (always), and — ONLY when activeMenu — a numeric
 * choice in the current node, a nav alias (back/faq/book/manage), or a business-info topic word.
 * book/manage are returned WITHOUT text so the caller attaches the real, sized link + wording.
 */
export function resolveMenuNavigation(
  node: MenuNode | null, message: string, facts: BusinessFacts, opts: { activeMenu: boolean }
): MenuNav | null {
  const frags = (message ?? "").split("\n").map((s) => s.trim()).filter(Boolean);
  const latest = frags.length ? frags[frags.length - 1] : (message ?? "").trim();

  // Explicit "menu/options" request → main menu, ALWAYS honored (even with no active cursor).
  if (isMenuRequest(latest) || isMenuRequest(message)) {
    return { kind: "main", reply: buildMainMenu(facts), node: "main" };
  }
  // AI-FIRST GUARD: with no active menu, nothing below intercepts — healthy AI owns the turn.
  if (!opts.activeMenu) return null;

  // Numeric pick resolves against the node the customer is currently looking at.
  const choice = parseChoice(latest);
  if (choice !== null) {
    if (node === "faq") {
      const t = availableInfoTopics(facts)[choice - 1];
      if (t) return answerNav(facts, t.topic);
    } else {
      const o = availableMainOptions(facts)[choice - 1];
      if (o) return o.action === "faq"
        ? { kind: "faq", reply: buildInfoSubmenu(facts), node: "faq" }
        : { kind: o.action, node: "main" };
    }
    // out-of-range number → re-show the current menu rather than going silent.
    return node === "faq"
      ? { kind: "faq", reply: buildInfoSubmenu(facts), node: "faq" }
      : { kind: "main", reply: buildMainMenu(facts), node: "main" };
  }

  // Word/alias navigation.
  if (BACK_MAIN_RE.test(latest)) return { kind: "main", reply: buildMainMenu(facts), node: "main" };
  if (FAQ_NAV_RE.test(latest)) return { kind: "faq", reply: buildInfoSubmenu(facts), node: "faq" };
  if (BOOK_NAV_RE.test(latest)) return { kind: "book", node: "main" };
  if (MANAGE_NAV_RE.test(latest)) return { kind: "manage", node: "main" };

  // A business-info topic word ("שעות", "מחירים", "חניה") → its answer (the customer is in a menu).
  const topic = detectInfoTopic(latest) ?? detectInfoTopic(message);
  if (topic) return answerNav(facts, topic);

  return null; // not navigation → fall through (AI-first / deterministic handling)
}

// ── CLICKABLE INTERACTIVE MENUS (WhatsApp buttons / list) ─────────────────────────
// The same node/option/action model rendered as TAPPABLE WhatsApp messages. Every option
// carries a STABLE payload id (echoed back on tap) so a tap maps to a deterministic action
// regardless of label/UI-language. Labels here are SHORT to satisfy WhatsApp limits (button
// title ≤20, list row title ≤24); the longer text-menu labels stay for the text fallback.
// Business-agnostic: built entirely from availableMainOptions / availableInfoTopics.
export const MENU_PAYLOAD = { book: "m:book", manage: "m:manage", faq: "m:faq", main: "m:main" } as const;
const TOPIC_PAYLOAD = (t: InfoTopic): string => `f:${t}`;
const MAIN_BUTTON_LABEL: Record<MainAction, string> = { book: "קביעת תור", manage: "ניהול תור", faq: "מידע ושאלות" };
const TOPIC_ROW_LABEL: Record<InfoTopic, string> = {
  hours: "שעות פתיחה", prices: "מחירים ושירותים", location: "מיקום והגעה",
  parking: "חניה", policy: "מדיניות וביטולים", contact: "פרטי קשר", about: "על העסק",
};
const FAQ_MENU_BODY = "על מה תרצו לשמוע?";
const FAQ_LIST_BUTTON = "בחירת נושא";

/** Resolves a TAPPED option's stable payload id to a menu action. Returns null for an
 *  unknown id (caller then falls back to treating the visible title as typed text). */
export function resolveMenuPayload(id: string, facts: BusinessFacts): MenuNav | null {
  if (id === MENU_PAYLOAD.book) return { kind: "book", node: "main" };
  if (id === MENU_PAYLOAD.manage) return { kind: "manage", node: "main" };
  if (id === MENU_PAYLOAD.faq) return { kind: "faq", reply: buildInfoSubmenu(facts), node: "faq" };
  if (id === MENU_PAYLOAD.main) return { kind: "main", reply: buildMainMenu(facts), node: "main" };
  if (id.startsWith("f:")) {
    const t = id.slice(2) as InfoTopic;
    if (availableInfoTopics(facts).some((x) => x.topic === t)) return answerNav(facts, t);
  }
  return null;
}

/** The MAIN menu as tappable reply buttons (≤3: book?/manage/faq?). Business- & reason-aware body. */
export function buildInteractiveMainMenu(facts: BusinessFacts, reason?: DegradedReason): WhatsAppInteractive {
  const buttons = availableMainOptions(facts)
    .slice(0, 3)
    .map((o) => ({ id: MENU_PAYLOAD[o.action], title: MAIN_BUTTON_LABEL[o.action] }));
  return { kind: "buttons", body: mainMenuBody(facts, reason), buttons };
}

/** The FAQ submenu as a tappable list (rows = topics with data, + "back to main"). */
export function buildInteractiveFaqMenu(facts: BusinessFacts): WhatsAppInteractive {
  const topics = availableInfoTopics(facts);
  const rows = topics.slice(0, 9).map((t) => ({ id: TOPIC_PAYLOAD(t.topic), title: TOPIC_ROW_LABEL[t.topic] }));
  rows.push({ id: MENU_PAYLOAD.main, title: "תפריט ראשי" });
  return { kind: "list", body: FAQ_MENU_BODY, button: FAQ_LIST_BUTTON, rows };
}

/** A category ANSWER as a message with follow-up buttons (back to FAQ / main / book). */
export function buildInteractiveAnswer(answerText: string, facts: BusinessFacts): WhatsAppInteractive {
  const buttons: { id: string; title: string }[] = [];
  if (hasAnyInfo(facts)) buttons.push({ id: MENU_PAYLOAD.faq, title: "עוד מידע" });
  buttons.push({ id: MENU_PAYLOAD.main, title: "תפריט ראשי" });
  if (facts.bookingEnabled) buttons.push({ id: MENU_PAYLOAD.book, title: "קביעת תור" });
  // body ≤1024; deterministic facts answers fit comfortably.
  return { kind: "buttons", body: answerText.slice(0, 1024), buttons: buttons.slice(0, 3) };
}

/** The interactive (clickable) message for a resolved menu node, or null when the node is a
 *  link action (book/manage — the caller builds the cta_url with the real URL). `answerText`
 *  is the deterministic answer body for an "answer" nav. */
export function buildInteractiveForNav(nav: MenuNav, facts: BusinessFacts): WhatsAppInteractive | null {
  if (nav.kind === "main") return buildInteractiveMainMenu(facts);
  if (nav.kind === "faq") return buildInteractiveFaqMenu(facts);
  if (nav.kind === "answer") return buildInteractiveAnswer(nav.reply, facts);
  return null; // book / manage → cta_url built by the caller (needs the URL)
}
