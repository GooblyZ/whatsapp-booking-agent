import {
  type DB,
  getConversationState,
  upsertConversationState,
  loadActiveServices,
  getBusinessTimezone,
  updateCustomerName,
  isBookingEnabled,
} from "./helpers";
import { getAvailableSlots, isIntervalFree, parseHebrewDate, businessTimeToUTC, todayInTZ } from "./availability";
import { sendOutbound } from "./outbound";
import { runConversationTurn } from "@/lib/ai/idle-handler";
import { runPlatformTurn } from "@/lib/ai/platform-turn";
import { loadBookingSession } from "@/lib/ai/booking-session";
import { getBookingMode } from "@/lib/config";

// Conversation states that mean "a booking is in progress, missing field X".
// These are CONTEXT for the AI receptionist, not menus that own the conversation.
const BOOKING_STATES = new Set<string>([
  "booking_collect_name", "booking_select_service",
  "booking_select_date", "booking_select_slot", "booking_confirm",
]);

// Explicit, unambiguous cancel COMMANDS — handled deterministically for reliability.
// EXACT match only (after stripping trailing punctuation). Substring matching is
// forbidden here: phrases like "לא רוצה" are routine FRAGMENTS of correction
// sentences ("...אבל לא רוצה את זה" = rejecting a detail), and matching them wiped
// an active booking live. Natural / softer cancels ("עזוב", "לא משנה", "לא רוצה"
// inside a sentence) are understood by Gemini instead.
const CANCEL_COMMANDS = new Set([
  "ביטול", "בטל", "לבטל", "ביטול תור", "בטל תור", "בטל את התור", "יציאה", "stop", "cancel",
]);

export function isCancelIntent(text: string): boolean {
  const t = text.trim().toLowerCase().replace(/[!?.…\s]+$/g, "").trim();
  return CANCEL_COMMANDS.has(t);
}

// Outbound sending (settings enforcement, health recording, persistence) lives
// in ./outbound.ts — the SAME chokepoint serves this router and the booking
// platform, so owner settings can never diverge between the two paths.
// TODO: future — add a retry queue for failed WhatsApp sends (e.g. SQS, BullMQ).
async function reply(
  db: DB, businessId: string, customerId: string, toPhone: string, rawText: string
): Promise<void> {
  await sendOutbound(db, businessId, customerId, toPhone, rawText);
}

/**
 * AI-FIRST router over a BOOKING-CONTEXT architecture.
 *
 * The conversation engine (lib/ai/idle-handler.ts) handles almost every message:
 * it maintains the booking SESSION (service/day/time gathered in any order),
 * computes availability from accumulated context, and arms the deterministic
 * confirm step when everything is set and the slot is free.
 *
 * Deterministic handling is reserved for:
 *   - the final confirm step ("כן"/"לא" → existing appointment INSERT, unchanged)
 *   - explicit cancel commands ("ביטול")
 *   - valid structured input while in a LEGACY menu state (technical fallback mode)
 *   - technical failures (AI disabled / API down) → legacy menu as last resort
 */
export async function handleBookingFlow(
  db: DB, businessId: string, fromPhone: string, customerId: string, messageText: string
): Promise<void> {
  const { state: rawState, context: rawContext, expiresAt } = await getConversationState(db, businessId, customerId);
  const timezone = await getBusinessTimezone(db, businessId);

  // Lazy session expiry for non-idle states.
  let state = rawState;
  let context = rawContext;
  if (state !== "idle" && expiresAt && expiresAt < new Date()) {
    console.log(`[booking] session expired (state="${state}") — resetting to idle`);
    await upsertConversationState(db, businessId, customerId, "idle", {});
    state = "idle";
    context = {};
  }

  const replyFn = (text: string) => reply(db, businessId, customerId, fromPhone, text);

  // PLATFORM MODE (TRANSITION_PLAN.md): conversational scheduling is OFF — the
  // AI converses + detects intent; links route to the booking platform. The
  // entire conversational-booking pipeline below is bypassed.
  if (getBookingMode() === "platform") {
    console.log(`[router] mode=platform state="${state}" → platform turn`);
    const turnAnchor = await latestInboundAt(db, businessId, customerId);
    const outcome = await runPlatformTurn(db, businessId, customerId, fromPhone, messageText, state);
    if (await hasNewerInbound(db, businessId, customerId, turnAnchor)) {
      console.log(`[router] superseded by newer inbound message — reply skipped`);
      return;
    }
    await replyFn(outcome.replyText);
    return;
  }

  const isMenuState = BOOKING_STATES.has(state);
  const session = loadBookingSession(context);
  const bookingActive = isMenuState || state === "booking_confirm" || session.active;
  const textPreview = messageText.slice(0, 40) + (messageText.length > 40 ? "…" : "");
  console.log(`[router] state="${state}" booking_active=${bookingActive} input="${textPreview}"`);

  // Explicit cancel COMMAND while any booking is active → deterministic, reliable stop.
  if (bookingActive && isCancelIntent(messageText)) {
    console.log(`[router] state=${state} ai_called=false deterministic_called=true reason=explicit_cancel reply_source=system`);
    await replyFn("קביעת התור בוטלה. נשמח לעזור בכל עת! 😊");
    await upsertConversationState(db, businessId, customerId, "idle", {});
    return;
  }

  // Final confirm step: literal yes/no → existing deterministic execution path.
  if (state === "booking_confirm" && isYesNoInput(messageText)) {
    console.log(`[router] state=booking_confirm structured_input_match=true ai_called=false deterministic_called=true reason=final_confirmation reply_source=system`);
    await handleConfirmation(db, businessId, customerId, fromPhone, messageText, context, timezone);
    return;
  }

  // LEGACY menu states (reachable only via technical fallback): valid structured
  // input keeps the menu working; anything else flows to the engine, which
  // MIGRATES the legacy progress into the booking session.
  if (isMenuState) {
    const structured = isStructuredInputForState(state, messageText, context, timezone);
    console.log(`[router] state=${state} structured_input_match=${structured}`);
    if (structured) {
      console.log(`[router] state=${state} ai_called=false deterministic_called=true reason=valid_structured_input reply_source=system`);
      await dispatchDeterministic(db, businessId, customerId, fromPhone, messageText, state, context, timezone);
      return;
    }
  }

  // EVERYTHING ELSE → the conversation engine (AI-first; one Gemini call).
  console.log(`[router] state=${state} ai_called=true deterministic_called=false reply_source=gemini`);
  const turnAnchor = await latestInboundAt(db, businessId, customerId);
  const outcome = await runConversationTurn(db, businessId, customerId, messageText, context, timezone, state);

  // Technical failure + clear booking keyword → legacy menu as a TRUE fallback
  // (never used for conversational uncertainty).
  if (isTechnicalFailure(outcome.decision.fallbackReason) && /תור/.test(messageText)) {
    console.log(`[router] technical_fallback=${outcome.decision.fallbackReason} → legacy menu flow`);
    await startMenuFallback(db, businessId, customerId, fromPhone);
    return;
  }

  // SUPERSEDE CHECK (zero-latency burst handling): if a newer message arrived
  // while we were thinking, skip this reply — the newest message's turn answers
  // with the full combined context (session merge was already persisted).
  if (await hasNewerInbound(db, businessId, customerId, turnAnchor)) {
    console.log(`[router] superseded by newer inbound message — reply skipped (state preserved)`);
    return;
  }

  await replyFn(outcome.replyText);
}

// ── Router helpers ─────────────────────────────────────────────────────────────

function isTechnicalFailure(reason: string | undefined): boolean {
  if (!reason) return false;
  // Transient overload is NOT a menu-fallback trigger: degraded mode keeps the
  // conversational session going deterministically — better than a menu reset.
  if (reason === "gemini_overloaded") return false;
  return reason === "ai_disabled" || reason === "not_configured" || reason === "context_load_error" ||
    reason === "malformed_json" || reason.startsWith("gemini_");
}

/** created_at of the newest inbound message for this customer (turn anchor). */
async function latestInboundAt(db: DB, businessId: string, customerId: string): Promise<string | null> {
  const { data } = await db
    .from("messages")
    .select("created_at")
    .eq("business_id", businessId)
    .eq("customer_id", customerId)
    .eq("direction", "inbound")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data?.created_at as string) ?? null;
}

/** True if an inbound message newer than the anchor exists (burst supersede). */
async function hasNewerInbound(db: DB, businessId: string, customerId: string, anchorISO: string | null): Promise<boolean> {
  if (!anchorISO) return false;
  const { data } = await db
    .from("messages")
    .select("id")
    .eq("business_id", businessId)
    .eq("customer_id", customerId)
    .eq("direction", "inbound")
    .gt("created_at", anchorISO)
    .limit(1);
  return !!(data && data.length > 0);
}

/** Is the message clean structured input for the current LEGACY menu step? */
function isStructuredInputForState(
  state: string, text: string, context: Record<string, unknown>, timezone: string
): boolean {
  const t = text.trim();
  switch (state) {
    case "booking_collect_name": {
      if (t.includes("?")) return false;
      const stop = new Set(["מה", "מה?", "היי", "הי", "שלום", "עזוב", "לא משנה", "לא", "כן", "אהלן", "הלו", "מה נשמע"]);
      if (stop.has(t)) return false;
      return NAME_RE.test(t);
    }
    case "booking_select_service": {
      const list = (context.services_list ?? []) as Array<{ name: string }>;
      const n = parseInt(t, 10);
      if (/^\d+$/.test(t) && n >= 1 && n <= list.length) return true;
      return list.some((s) => s.name.trim().toLowerCase() === t.toLowerCase());
    }
    case "booking_select_date":
      return parseHebrewDate(t, timezone) !== null;
    case "booking_select_slot": {
      const slots = (context.available_slots ?? []) as string[];
      const n = parseInt(t, 10);
      return /^\d+$/.test(t) && n >= 1 && n <= slots.length;
    }
    default:
      return false;
  }
}

/**
 * Unified final-confirmation parsing (router + confirm handler use the SAME
 * logic). Notes from live behavior:
 *   - assent slang counts ("יאללה", "סגור") — a soft model CTA invites these
 *   - "כן אבל / כן רק ש…" is NOT a clean yes — a qualified answer goes to the
 *     engine, which understands the qualification (the old startsWith("כן")
 *     would have booked over the customer's objection)
 */
export function parseYesNo(text: string): "yes" | "no" | null {
  const t = text.trim().toLowerCase();
  if (t === "לא" || t === "no" || t === "לא תודה") return "no";
  const yes = ["כן", "אישור", "אשר", "מאשר", "מאשרת", "yes", "ok", "אוקיי", "בטח", "סבבה", "סגור", "יאללה"];
  if (yes.includes(t)) return "yes";
  if (/^כן[\s,.!]/.test(t)) {
    return /אבל|רק\s|חוץ\s?מ|בעצם/.test(t) ? null : "yes";
  }
  return null;
}

function isYesNoInput(text: string): boolean {
  return parseYesNo(text) !== null;
}

/** Routes valid structured input to the existing deterministic step handler. */
async function dispatchDeterministic(
  db: DB, businessId: string, customerId: string, fromPhone: string,
  text: string, state: string, context: Record<string, unknown>, timezone: string
): Promise<void> {
  switch (state) {
    case "booking_collect_name":   await handleNameCollection(db, businessId, customerId, fromPhone, text); break;
    case "booking_select_service": await handleServiceSelection(db, businessId, customerId, fromPhone, text, context); break;
    case "booking_select_date":    await handleDateSelection(db, businessId, customerId, fromPhone, text, context, timezone); break;
    case "booking_select_slot":    await handleSlotSelection(db, businessId, customerId, fromPhone, text, context); break;
  }
}

/** Legacy menu entry — used ONLY on technical failure of the AI layer. */
async function startMenuFallback(
  db: DB, businessId: string, customerId: string, fromPhone: string
): Promise<void> {
  const enabled = await isBookingEnabled(db, businessId);
  if (!enabled) {
    await reply(db, businessId, customerId, fromPhone,
      "קביעת תורים אינה זמינה כרגע. לפרטים נוספים אנא צרו קשר ישירות עם העסק."
    );
    return;
  }
  await startServiceSelection(db, businessId, customerId, fromPhone);
}

// Accepts and validates the customer's name, then moves to service selection.
// Hebrew/English only, 2–50 characters.
const NAME_RE = /^[a-zA-Z֐-׿\s'\-]{2,50}$/;

async function handleNameCollection(
  db: DB, businessId: string, customerId: string, fromPhone: string, text: string
): Promise<void> {
  const name = text.trim();

  if (!NAME_RE.test(name)) {
    await reply(db, businessId, customerId, fromPhone,
      "שם לא תקין 🙏 אנא שלח שם בעברית או אנגלית (לפחות 2 תווים)."
    );
    return;
  }

  await updateCustomerName(db, customerId, name);
  await startServiceSelection(db, businessId, customerId, fromPhone);
}

// Sends the service list and advances state to booking_select_service.
async function startServiceSelection(
  db: DB, businessId: string, customerId: string, fromPhone: string
): Promise<void> {
  const services = await loadActiveServices(db, businessId);

  if (services.length === 0) {
    const fallback = "מצטערים, אין שירותים זמינים כרגע לקביעת תור. אנא פנה אלינו ישירות.";
    console.warn(`[booking] NO ACTIVE SERVICES — sending fallback: "${fallback}"`);
    await reply(db, businessId, customerId, fromPhone, fallback);
    return;
  }

  let msg = "שמחים שפנית! 😊 איזה שירות תרצה לקבוע?\n\n";
  services.forEach((s, i) => {
    const price = s.price != null ? ` — ₪${Number(s.price).toFixed(0)}` : "";
    msg += `${i + 1}. ${s.name} (${s.duration_minutes} דק׳${price})\n`;
  });
  msg += "\nשלח את *מספר* השירות הרצוי.\nלביטול שלח *ביטול*.";

  await reply(db, businessId, customerId, fromPhone, msg);
  await upsertConversationState(db, businessId, customerId, "booking_select_service", {
    services_list: services.map((s) => ({ id: s.id, name: s.name, duration_minutes: s.duration_minutes })),
  });
}

async function handleServiceSelection(
  db: DB, businessId: string, customerId: string, fromPhone: string,
  text: string, context: Record<string, unknown>
): Promise<void> {
  const list = (context.services_list ?? []) as Array<{ id: string; name: string; duration_minutes: number }>;
  const t = text.trim();
  // Accept a number OR an exact service name (case-insensitive).
  const idx = /^\d+$/.test(t)
    ? parseInt(t, 10) - 1
    : list.findIndex((s) => s.name.trim().toLowerCase() === t.toLowerCase());

  if (isNaN(idx) || idx < 0 || idx >= list.length) {
    let msg =
      "אנחנו באמצע קביעת תור 😊\n" +
      `כדי להמשיך, שלח/י את *מספר* השירות הרצוי (1-${list.length}).\n` +
      "אם רצית לשאול משהו אחר, שלח/י 'ביטול' ואז כתוב/כתבי את השאלה.\n\n";
    list.forEach((s, i) => { msg += `${i + 1}. ${s.name}\n`; });
    await reply(db, businessId, customerId, fromPhone, msg);
    return;
  }

  const selected = list[idx];
  await reply(db, businessId, customerId, fromPhone,
    `בחרת: *${selected.name}* ✓\n\nבאיזה תאריך תרצה להגיע?\n` +
    `שלח תאריך בפורמט יום/חודש (לדוגמה: 15/6)\n` +
    `או שלח *מחר* / *מחרתיים*.\n\nלביטול שלח *ביטול*.`
  );
  await upsertConversationState(db, businessId, customerId, "booking_select_date", {
    ...context,
    selected_service_id: selected.id,
    selected_service_name: selected.name,
    selected_duration_minutes: selected.duration_minutes,
  });
}

async function handleDateSelection(
  db: DB, businessId: string, customerId: string, fromPhone: string,
  text: string, context: Record<string, unknown>, timezone: string
): Promise<void> {
  const date = parseHebrewDate(text, timezone);

  if (!date) {
    await reply(db, businessId, customerId, fromPhone,
      "אנחנו באמצע קביעת תור 😊\n" +
      "כדי להמשיך, שלח/י תאריך בפורמט יום/חודש (לדוגמה: 15/6), או 'מחר' / 'מחרתיים'.\n" +
      "אם רצית לשאול משהו אחר, שלח/י 'ביטול' ואז כתוב/כתבי את השאלה."
    );
    return;
  }

  if (date < todayInTZ(timezone)) {
    await reply(db, businessId, customerId, fromPhone,
      "התאריך שנבחר כבר עבר. שלח תאריך עתידי."
    );
    return;
  }

  const duration = (context.selected_duration_minutes as number) ?? 30;
  const slots    = await getAvailableSlots(db, businessId, date, duration, timezone);

  if (slots.length === 0) {
    const [y, mo, d] = date.split("-");
    await reply(db, businessId, customerId, fromPhone,
      `אין שעות פנויות בתאריך ${d}/${mo}/${y}.\n` +
      `שלח תאריך אחר, או שלח *ביטול* לסיום.`
    );
    return;
  }

  const [y, mo, d] = date.split("-");
  let msg = `אלו השעות הפנויות בתאריך ${d}/${mo}/${y}:\n\n`;
  slots.forEach((slot, i) => { msg += `${i + 1}. ${slot}\n`; });
  msg += "\nשלח את *מספר* השעה הרצויה.\nלביטול שלח *ביטול*.";

  await reply(db, businessId, customerId, fromPhone, msg);
  await upsertConversationState(db, businessId, customerId, "booking_select_slot", {
    ...context,
    selected_date: date,
    available_slots: slots,
  });
}

async function handleSlotSelection(
  db: DB, businessId: string, customerId: string, fromPhone: string,
  text: string, context: Record<string, unknown>
): Promise<void> {
  const slots = (context.available_slots ?? []) as string[];
  const idx   = parseInt(text.trim(), 10) - 1;

  if (isNaN(idx) || idx < 0 || idx >= slots.length) {
    let msg =
      "אנחנו באמצע קביעת תור 😊\n" +
      `כדי להמשיך, שלח/י את *מספר* השעה הרצויה (1-${slots.length}).\n` +
      "אם רצית לשאול משהו אחר, שלח/י 'ביטול' ואז כתוב/כתבי את השאלה.\n\n";
    slots.forEach((s, i) => { msg += `${i + 1}. ${s}\n`; });
    await reply(db, businessId, customerId, fromPhone, msg);
    return;
  }

  const slot        = slots[idx];
  const date        = context.selected_date as string;
  const [y, mo, d]  = date.split("-");
  const serviceName = context.selected_service_name as string;

  await reply(db, businessId, customerId, fromPhone,
    `לאשר את התור?\n\n` +
    `שירות: *${serviceName}*\n` +
    `תאריך: *${d}/${mo}/${y}*\n` +
    `שעה: *${slot}*\n\n` +
    `שלח *כן* לאישור סופי.\nשלח *לא* לביטול.`
  );
  await upsertConversationState(db, businessId, customerId, "booking_confirm", {
    ...context,
    selected_slot_time: slot,
  });
}

/** The chosen slot is no longer free (conflict / race) — offer live alternatives. */
async function offerAlternativesAfterConflict(
  db: DB, businessId: string, customerId: string, fromPhone: string,
  date: string, slotTime: string, duration: number, timezone: string,
  context: Record<string, unknown>
): Promise<void> {
  console.warn(`[booking] slot conflict business=${businessId} date=${date} slot=${slotTime}`);
  const updatedSlots = await getAvailableSlots(db, businessId, date, duration, timezone);
  if (updatedSlots.length === 0) {
    const [y, mo, d] = date.split("-");
    await reply(db, businessId, customerId, fromPhone,
      `השעה הזו כבר נתפסה ואין שעות פנויות אחרות בתאריך ${d}/${mo}/${y}.\n` +
      `שלח תאריך אחר, או שלח *ביטול* לסיום.`
    );
    await upsertConversationState(db, businessId, customerId, "booking_select_date", {
      ...context,
      selected_slot_time: undefined,
      available_slots: undefined,
    });
  } else {
    let msg = "השעה הזו כבר נתפסה. הנה שעות פנויות אחרות:\n\n";
    updatedSlots.forEach((s, i) => { msg += `${i + 1}. ${s}\n`; });
    msg += "\nשלח את *מספר* השעה הרצויה.\nלביטול שלח *ביטול*.";
    await reply(db, businessId, customerId, fromPhone, msg);
    await upsertConversationState(db, businessId, customerId, "booking_select_slot", {
      ...context,
      selected_slot_time: undefined,
      available_slots: updatedSlots,
    });
  }
}

async function handleConfirmation(
  db: DB, businessId: string, customerId: string, fromPhone: string,
  text: string, context: Record<string, unknown>, timezone: string
): Promise<void> {
  const t = text.trim();

  // Explicit cancellation (same parser as the router — no drift).
  if (parseYesNo(t) === "no" || isCancelIntent(t)) {
    await reply(db, businessId, customerId, fromPhone, "קביעת התור בוטלה. נשמח לעזור בכל עת! 😊");
    await upsertConversationState(db, businessId, customerId, "idle", {});
    return;
  }

  const isYes = parseYesNo(t) === "yes";
  if (!isYes) {
    const svc = context.selected_service_name as string;
    const slot = context.selected_slot_time as string;
    const [yy, mm, dd] = ((context.selected_date as string) ?? "--").split("-");
    await reply(db, businessId, customerId, fromPhone,
      "אנחנו באמצע קביעת תור 😊\n" +
      "כדי לסיים, שלח/י *כן* לאישור או *לא* לביטול.\n" +
      "אם רצית לשאול משהו אחר, שלח/י 'ביטול' ואז כתוב/כתבי את השאלה.\n\n" +
      `שירות: *${svc}*\nתאריך: *${dd}/${mm}/${yy}*\nשעה: *${slot}*`
    );
    return;
  }

  const date      = context.selected_date      as string;
  const slotTime  = context.selected_slot_time as string;
  const serviceId = context.selected_service_id as string | undefined;
  const duration  = (context.selected_duration_minutes as number) ?? 30;
  const serviceName = context.selected_service_name as string;

  // PRE-INSERT SAFETY: verify the interval is STILL free. The exact-start unique
  // constraint only catches identical start times — off-grid bookings (e.g.
  // 15:30 on a 45-min grid) could otherwise overlap a neighboring appointment.
  const stillFree = await isIntervalFree(db, businessId, date, slotTime, duration, timezone);
  if (!stillFree) {
    await offerAlternativesAfterConflict(db, businessId, customerId, fromPhone, date, slotTime, duration, timezone, context);
    return;
  }

  // Convert business-local time to UTC for storage
  const startTime = businessTimeToUTC(date, slotTime, timezone);
  const endTime   = new Date(startTime.getTime() + duration * 60_000);

  const { error } = await db.from("appointments").insert({
    business_id: businessId,
    customer_id: customerId,
    service_id:  serviceId ?? null,
    start_time:  startTime.toISOString(),
    end_time:    endTime.toISOString(),
    status:      "confirmed",
    source:      "whatsapp",
  });

  if (error) {
    // Unique constraint violation (error code 23505) = slot was taken by a concurrent booking.
    if (error.code === "23505") {
      await offerAlternativesAfterConflict(db, businessId, customerId, fromPhone, date, slotTime, duration, timezone, context);
      return;
    }

    console.error("[booking] failed to create appointment:", error.message);
    await reply(db, businessId, customerId, fromPhone,
      "אירעה שגיאה בקביעת התור. אנא פנה אלינו ישירות."
    );
    return;
  }

  const [y, mo, d] = date.split("-");
  await reply(db, businessId, customerId, fromPhone,
    `מעולה! התור נקבע בהצלחה 🎉\n\n` +
    `שירות: *${serviceName}*\n` +
    `תאריך: *${d}/${mo}/${y}*\n` +
    `שעה: *${slotTime}*\n\n` +
    `נשמח לראות אותך! 😊`
  );
  await upsertConversationState(db, businessId, customerId, "idle", {});
}
