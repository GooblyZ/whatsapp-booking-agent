// lib/ai/platform-turn.ts
// Server-side only.
//
// PLATFORM-MODE conversation turn (TRANSITION_PLAN.md): the AI converses,
// answers FAQs from facts, and DETECTS appointment intent — it never collects
// scheduling details. The SYSTEM (this module, deterministically) attaches the
// booking / self-service link after the model's reply. One Gemini call per
// turn, same as always; the conversational-scheduling machinery in
// idle-handler.ts is bypassed entirely.

import type { DB } from "@/lib/booking/helpers";
import { upsertConversationState } from "@/lib/booking/helpers";
import { getBusinessAIContext } from "./context";
import {
  getConversationContext, renderUpcomingAppointments, renderCustomerState, didLastReplyFailToSend,
} from "./conversation";
import { isGeminiCoolingDown, geminiCooldownRemainingMs } from "./gemini";
import {
  runReceptionistTurn, FALLBACK, classifyInput, type ReceptionistDecision,
} from "./brain";
import { stripEmojis, sameOutboundText, claimsBookingCompleted } from "./reply-polish";
import { logAIEvent } from "./events";
import { buildBookingLink, buildAppointmentLink } from "@/lib/config";
import { buildMyAppointmentsLink } from "@/lib/booking/appointment-token";
import { listUpcomingByCustomer } from "@/lib/booking/appointments";

export type PlatformLink = "booking" | "manage" | null;

export interface PlatformTurnOutcome {
  replyText: string;
  decision: ReceptionistDecision;
  linkAttached: PlatformLink;
}

// WhatsApp renders *…* as bold and auto-links a bare URL on its own line. A bold
// label + clean URL reads as an intentional, premium CTA (no markdown links in
// WhatsApp). Emojis are intentionally omitted here so the CTA looks the same
// regardless of the owner's emoji setting and never trips the chokepoint.
const BOOK_LINE = "*לקביעת תור — מהיר ופשוט:*";
const MANAGE_LINE = "*לניהול התור (צפייה · שינוי · ביטול):*";
const MY_APPTS_LINE = "*כל התורים שלך — לבחירה וניהול:*";

/**
 * Runs one platform-mode turn. Persists nothing except a state reset for
 * legacy non-idle states; the router sends `replyText`.
 */
export async function runPlatformTurn(
  db: DB,
  businessId: string,
  customerId: string,
  customerPhone: string,
  messageText: string,
  rawState: string
): Promise<PlatformTurnOutcome> {
  // Legacy conversational-booking states cannot continue in platform mode —
  // reset once so the customer starts clean after the flip.
  if (rawState !== "idle") {
    console.log(`[platform-turn] resetting legacy state "${rawState}" → idle`);
    await upsertConversationState(db, businessId, customerId, "idle", {});
  }

  let ctx;
  try {
    ctx = await getBusinessAIContext(businessId);
  } catch (err) {
    console.error("[platform-turn] failed to load business context:", err instanceof Error ? err.message : String(err));
    const decision = errorDecision("context_load_error");
    await safeLog(businessId, customerId, decision);
    return { replyText: FALLBACK.error, decision, linkAttached: null };
  }

  const timezone = ctx.business.timezone || "Asia/Jerusalem";
  const [memory, upcomingBlock, customerBlock, lastSendFailed] = await Promise.all([
    getConversationContext(db, businessId, customerId),
    renderUpcomingAppointments(db, businessId, customerId, timezone, true),
    renderCustomerState(db, businessId, customerId, timezone),
    didLastReplyFailToSend(db, businessId, customerId),
  ]);
  const lastAssistant = lastAssistantLine(memory.transcript);
  const bookingBlock = [customerBlock, upcomingBlock].filter(Boolean).join("\n\n");

  // DEGRADED MODE: during a Gemini overload cooldown the platform story is
  // simple — the booking page IS the deterministic path. Route to it directly.
  if (isGeminiCoolingDown() && classifyInput(messageText) === "ok") {
    console.warn(`[platform-turn] DEGRADED MODE — cooldown ${Math.ceil(geminiCooldownRemainingMs() / 1000)}s left; deterministic link reply`);
    const link = buildBookingLink(ctx.business.slug, customerPhone);
    let replyText = `יש לי רגע עומס קטן במערכת 🙏 אפשר בינתיים לקבוע, לשנות או לבדוק זמינות כאן:\n${link}`;
    if (ctx.aiSettings?.emoji_usage === "none") replyText = stripEmojis(replyText);
    const decision = errorDecision("gemini_cooldown", true);
    await safeLog(businessId, customerId, decision);
    return { replyText, decision, linkAttached: "booking" };
  }

  let replyGuidance: string | undefined;
  if (lastSendFailed) {
    replyGuidance =
      `NOTE: your PREVIOUS reply FAILED to deliver (technical issue on our side — the customer never saw it). Open with a brief, warm acknowledgement of a small hiccup ("הייתה לי תקלה קטנה קודם") before continuing.`;
  }

  const decision = await runReceptionistTurn(ctx, {
    historyTurns: memory.turns,
    conversationContext: memory.transcript,
    message: messageText,
    bookingBlock,
    replyGuidance,
    platformMode: true,
    customerPhone,
  });

  let replyText = decision.replyText;

  // The model must never claim a booking action happened — in platform mode it
  // structurally can't have. Replace the lie with an honest router line.
  if (decision.ok && claimsBookingCompleted(replyText)) {
    replyText = "את התור עצמו קובעים בקישור — שניה ושולח לך אותו 🙂";
  }
  // Never send the exact same reply twice in a row.
  if (decision.ok && sameOutboundText(replyText, lastAssistant)) {
    replyText = "אני כאן 🙂 אפשר לשאול אותי הכל על העסק, או לקבוע תור בקישור למטה.";
  }

  // ── Outbound URL safety: strip any URL the MODEL wrote (echoed from history or
  //    invented) so the final message carries AT MOST the one deterministic link.
  replyText = stripModelUrls(replyText);

  // ── Deterministic link control (OVERRIDES Gemini's intent). Complaints about
  //    links/bugs, bare meta-questions ("מה?"/"למה?"/"לא הבנתי"), corrections and
  //    one-char messages must NEVER get a booking/manage link — Gemini mislabels
  //    them as BOOK, which created the live "complain about links → bot sends
  //    another link" loop. The link attaches only on a genuine action intent.
  const u = decision.turn?.understanding;
  let linkAttached: PlatformLink = null;

  if (decision.ok && suppressLinkFor(messageText)) {
    if (LINK_COMPLAINT_RE.test(messageText) && !isExplicitLinkRequest(messageText)) {
      replyText = COMPLAINT_ACK; // breaks the complaint loop — acknowledge, no link
      console.log("[platform-turn] link suppressed (complaint) — deterministic ack, no link");
    } else if (/קישור|לינק/.test(replyText)) {
      replyText = META_FALLBACK; // model dangled a link promise on a no-link turn
      console.log("[platform-turn] link suppressed (meta/non-action) — cleaned dangling link promise");
    } else {
      console.log("[platform-turn] link suppressed (meta/non-action) — model reply kept, no link");
    }
  } else if (decision.ok && u) {
    const wantsBooking = u.appointmentIntent === "BOOK" || u.intent === "booking";
    const wantsManage =
      u.appointmentIntent === "CANCEL" || u.appointmentIntent === "RESCHEDULE" ||
      u.appointmentIntent === "MODIFY" || u.appointmentIntent === "LIST" ||
      u.intent === "cancel_request" || u.intent === "reschedule_request";

    if (wantsManage) {
      // Deterministic link decision — code decides the fact, the model never
      // guesses how many appointments exist or which one to manage:
      //   0 upcoming → booking link (nothing to manage; offer to book)
      //   1 upcoming → that appointment's manage page (/appointment/[id])
      //   2+ upcoming → My Appointments page (customer picks which one)
      const upcoming = await listUpcomingByCustomer(db, businessId, customerId, 5);
      let url: string;
      let label: string;
      if (upcoming.length === 0) {
        url = buildBookingLink(ctx.business.slug, customerPhone);
        label = BOOK_LINE;
        linkAttached = "booking";
      } else if (upcoming.length === 1) {
        url = buildAppointmentLink(upcoming[0].id);
        label = MANAGE_LINE;
        linkAttached = "manage";
      } else {
        url = buildMyAppointmentsLink(customerId);
        label = MY_APPTS_LINE;
        linkAttached = "manage";
      }
      // Same fence as booking: never ask the customer to identify/specify an
      // appointment in chat. For manage we DON'T keep model sentences (that's where
      // it merges/invents appointment details) — the link shows the accurate list.
      const fenced =
        upcoming.length === 0
          ? defuseSchedulingQuestion(replyText)
          : defuseSchedulingQuestion(replyText, { bridge: FENCE_BRIDGE_MANAGE, keepWarmth: false });
      if (fenced.defused) {
        console.log(`[platform-turn] fence: neutralized in-chat selection question (manage, ${upcoming.length} appts)`);
        replyText = fenced.text;
      }
      replyText = appendPlatformLink(replyText, label, url, lastAssistant, messageText);
      logPlatformLink(linkAttached, url);
    } else if (wantsBooking) {
      // DETERMINISTIC FENCE: a booking-intent reply must never ask the customer
      // to pick service/day/time in chat — that's the website's job. Validation
      // showed the model still slips a scheduling question in ~60-80% of the time
      // even with the persona rules, so we strip it deterministically here.
      const fenced = defuseSchedulingQuestion(replyText);
      if (fenced.defused) {
        console.log("[platform-turn] fence: stripped in-chat scheduling question (booking intent → link-first)");
        replyText = fenced.text;
      }
      const url = buildBookingLink(ctx.business.slug, customerPhone);
      replyText = appendPlatformLink(replyText, BOOK_LINE, url, lastAssistant, messageText);
      linkAttached = "booking";
      logPlatformLink(linkAttached, url);
    }
  }

  if (ctx.aiSettings?.emoji_usage === "none") {
    replyText = stripEmojis(replyText);
  }

  await safeLog(businessId, customerId, decision);
  console.log(
    `[platform-turn] ai_called=${decision.geminiCalled} intent=${u?.intent ?? "-"}` +
    ` appt_intent=${u?.appointmentIntent ?? "-"} link=${linkAttached ?? "-"}` +
    ` src=${decision.replySource} memLines=${memory.turnsUsed}`
  );

  return { replyText, decision, linkAttached };
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function lastAssistantLine(transcript: string): string | null {
  const lines = transcript.split("\n").filter((l) => l.startsWith("Assistant (you, earlier): "));
  if (lines.length === 0) return null;
  return lines[lines.length - 1].replace("Assistant (you, earlier): ", "").replace(/\s+/g, " ").trim();
}

// ── Deterministic link-control (overrides Gemini's intent classification) ──────
// Complaints about the bot/links, bare meta-questions, and trivial messages must
// never trigger a booking/manage link. Gemini frequently mislabels these as BOOK.
const LINK_COMPLAINT_RE =
  /קישורים|שני\s*קישור|שתי\s*קישור|תפסיק|להפסיק|נמאס|באג|מבלבל|מבחבל|מתסכל|לא\s*טוב|טעית|בלי\s*שכתבתי|למה\s*כתבת|די\s/;
const META_ONLY_RE =
  /^(מה|למה|הא|נו|אה|לא\s*הבנתי|מה\s*זאת\s*אומרת|מה\s*אמרת|מה\s*זה|באמת|מה\s*קרה)\s*[?!.…׳"']*$/;
// An explicit REQUEST for the link (imperative/future) — these DO get one link.
const EXPLICIT_LINK_REQUEST_RE =
  /תשלח|תשלחי|שלח\s*לי|שלחי\s*לי|אפשר\s*(את\s*)?ה?קישור|איפה\s*ה?קישור|תן\s*לי\s*(את\s*)?ה?קישור|תני\s*לי\s*(את\s*)?ה?קישור|רוצה\s*(את\s*)?ה?(קישור|לינק)/;

export const COMPLAINT_ACK =
  "סליחה על הבלבול! 🙏 אני כאן לכל שאלה על העסק. מתי שתרצה לקבוע, לשנות או לבטל תור — תגיד לי ואשלח קישור אחד מסודר.";
export const META_FALLBACK =
  "לא בטוח/ה שהבנתי 🙂 אפשר לשאול אותי כל דבר על העסק, ואם תרצה לקבוע, לשנות או לבטל תור — רק תגיד.";

export function isExplicitLinkRequest(message: string): boolean {
  return EXPLICIT_LINK_REQUEST_RE.test(message);
}

/** True when this message must NOT receive a link, whatever Gemini classified it
 *  as: one-char/punctuation, bare meta-questions, and complaints — unless the user
 *  explicitly asks for the link (then they get exactly one). */
export function suppressLinkFor(message: string): boolean {
  const t = (message ?? "").trim();
  if (isExplicitLinkRequest(t)) return false;
  if (t.length <= 1) return true;
  if (/^[?؟!.…״"'\s,־-]+$/.test(t)) return true;
  if (META_ONLY_RE.test(t)) return true;
  if (LINK_COMPLAINT_RE.test(t)) return true;
  return false;
}

/** Removes any URL the model wrote so the final message carries at most the one
 *  deterministic platform link (prevents the "two links" the user complained of). */
export function stripModelUrls(text: string): string {
  return (text ?? "")
    .replace(/\bhttps?:\/\/\S+/gi, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Appends the single deterministic link — OR, if we just sent this exact link and
 *  the user didn't ask for it again, references it instead of re-spamming the URL. */
function appendPlatformLink(
  reply: string, label: string, url: string, lastAssistant: string | null, message: string
): string {
  if (lastAssistant?.includes(url) && !isExplicitLinkRequest(message)) {
    return `${reply}\n\nהקישור שכבר שלחתי קודם עדיין מחכה לך — בודקים שם 🙂`;
  }
  return `${reply}\n\n${label}\n${url}`;
}

// In-chat selection questions the model must never ask in platform mode (the
// website collects service/day/time AND lets the customer pick which appointment).
// Covers booking ("איזה שירות/יום/שעה?") and manage ("איזה תור?", "לאיזה תאריך?").
const SCHEDULING_Q = new RegExp(
  [
    "איז[הו]\\s+(שירות|טיפול|יום|תאריך|שעה|תור)",
    "מתי\\s+(נוח|בא\\s*לך|מתאים|תרצ|תוכל|יתאים)",
    "מה\\s+התאריך",
    "באיז[הו]\\s+(תאריך|שעה|שירות|יום|תור)",
    "לאיז[הו]\\s+(שעה|תאריך|יום|שירות|תור)",
    "איז[הו]\\s+\\S{1,12}\\s+(את|אתה)\\s+(רוצ|מעוניינ|תרצ)",
    // English forms — the model occasionally answers in English on thin context.
    "\\bwhich\\s+(appointment|service|one|day|time|date)",
    "\\bwhat\\s+(date|time|service)\\b",
    "\\bwhen\\s+(would|works|suits)",
  ].join("|"),
  "i"
);

export const FENCE_BRIDGE_BOOK = "את השירות, היום והשעה בוחרים ישירות בקישור — קל ומהיר.";
export const FENCE_BRIDGE_MANAGE = "כל הפרטים והניהול בקישור — בוחרים תור וצופים, משנים או מבטלים אותו.";

/**
 * Deterministic platform fence: if a reply asked the customer to pick a
 * service/day/time/appointment in chat, neutralize it and bridge to the link.
 *  - book mode (keepWarmth=true): drop the offending sentence(s) + any question,
 *    keep the model's non-question warmth.
 *  - manage mode (keepWarmth=false): replace the whole reply — manage
 *    disambiguation is exactly where the model MERGES/INVENTS appointment details
 *    ("the OTHER one was צביעת at 10:30" — wrong), so we don't keep its sentences.
 * If no selection question is present the reply is returned untouched (good
 * replies are never altered; FAQ / small talk never reach here).
 */
export function defuseSchedulingQuestion(
  reply: string,
  opts: { bridge?: string; keepWarmth?: boolean } = {}
): { text: string; defused: boolean } {
  if (!SCHEDULING_Q.test(reply)) return { text: reply, defused: false };
  const bridge = opts.bridge ?? FENCE_BRIDGE_BOOK;
  if (opts.keepWarmth === false) return { text: `בטח! ${bridge}`, defused: true };
  const warmth = reply
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !SCHEDULING_Q.test(s) && !s.includes("?") && !s.includes("？"))
    .join(" ")
    .trim();
  const text = warmth.length >= 8 ? `${warmth} ${bridge}` : `בטח! ${bridge}`;
  return { text, defused: true };
}

/**
 * Diagnostics for the attached CTA: logs the link's base ORIGIN + PATH only.
 * Never logs the `?p=<phone>` query (dropped) or the full appointment-id access
 * token (truncated to 8 chars) — no secrets, no PII. Lets us confirm at a glance
 * that PUBLIC_BASE_URL resolved to the intended domain (e.g. the Vercel URL) and
 * not the localhost fallback.
 */
function logPlatformLink(kind: PlatformLink, url: string): void {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.replace(
      /\/appointment\/([0-9a-f]{8})[0-9a-f-]*/i,
      "/appointment/$1…"
    );
    console.log(`[platform-turn] link_attached=${kind} base=${parsed.origin} path=${path}`);
  } catch {
    console.log(`[platform-turn] link_attached=${kind} (url parse failed)`);
  }
}

function errorDecision(branch: string, ok = false): ReceptionistDecision {
  return {
    geminiCalled: false, ok, turn: null,
    replyText: FALLBACK.error, responseType: ok ? "degraded" : "error",
    grounded: null, replySource: "fallback", wantsToCancel: false,
    branch, fallbackReason: ok ? undefined : branch,
  };
}

async function safeLog(businessId: string, customerId: string, d: ReceptionistDecision): Promise<void> {
  await logAIEvent({
    businessId,
    customerId,
    called: d.geminiCalled,
    intent: d.turn?.understanding.intent ?? null,
    confidence: null,
    success: d.responseType !== "error",
    responseType: d.responseType,
  });
}
