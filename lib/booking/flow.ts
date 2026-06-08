import { sendWhatsAppTextMessage } from "@/lib/whatsapp";
import {
  type DB,
  getConversationState,
  upsertConversationState,
  saveOutboundMessage,
  loadActiveServices,
  getBusinessTimezone,
  getCustomerName,
  updateCustomerName,
  isBookingEnabled,
} from "./helpers";
import { getAvailableSlots, parseHebrewDate, businessTimeToUTC, todayInTZ } from "./availability";

const BOOKING_TRIGGERS = [
  "תור", "קביעת תור", "לקבוע תור", "להזמין תור", "קבע תור", "הזמן תור",
  "לקבוע", "אני רוצה תור", "רוצה תור", "book",
];

const CANCEL_TRIGGERS = [
  "ביטול", "בטל", "לא רוצה", "לא תודה", "יציאה", "צא", "stop", "cancel",
];

function isBookingIntent(text: string): boolean {
  const t = text.trim();
  return BOOKING_TRIGGERS.some((kw) => t === kw || t.includes(kw));
}

function isCancelIntent(text: string): boolean {
  const t = text.trim().toLowerCase();
  return CANCEL_TRIGGERS.some((kw) => t === kw || t.includes(kw));
}

// TODO: future — add a retry queue for failed WhatsApp sends (e.g. SQS, BullMQ).
async function reply(
  db: DB, businessId: string, customerId: string, toPhone: string, text: string
): Promise<void> {
  let sendStatus: "sent" | "failed" = "sent";
  console.log(`[booking] reply → "${text.slice(0, 80)}${text.length > 80 ? "…" : ""}"`);

  const result = await sendWhatsAppTextMessage(toPhone, text);
  if (!result.success) {
    sendStatus = "failed";
    console.error(`[booking] WhatsApp send failed: ${result.error}`);
  }

  // Always save the outbound message regardless of send outcome so no reply is lost.
  try {
    await saveOutboundMessage(db, businessId, customerId, toPhone, text, sendStatus);
  } catch (err) {
    console.error("[booking] failed to save outbound message:", err instanceof Error ? err.message : String(err));
  }
}

export async function handleBookingFlow(
  db: DB, businessId: string, fromPhone: string, customerId: string, messageText: string
): Promise<void> {
  const { state: rawState, context: rawContext, expiresAt } = await getConversationState(db, businessId, customerId);
  const timezone = await getBusinessTimezone(db, businessId);

  // Lazy session expiry: if a non-idle session has passed its TTL, reset silently to idle.
  let state = rawState;
  let context = rawContext;
  if (state !== "idle" && expiresAt && expiresAt < new Date()) {
    console.log(`[booking] session expired (state="${state}") — resetting to idle`);
    await upsertConversationState(db, businessId, customerId, "idle", {});
    state = "idle";
    context = {};
  }

  const textPreview = messageText.slice(0, 40) + (messageText.length > 40 ? "…" : "");
  console.log(`[booking] flow state="${state}" input="${textPreview}"`);

  // Cancel from any active step
  if (state !== "idle" && isCancelIntent(messageText)) {
    await reply(db, businessId, customerId, fromPhone, "קביעת התור בוטלה. נשמח לעזור בכל עת! 😊");
    await upsertConversationState(db, businessId, customerId, "idle", {});
    return;
  }

  // Re-trigger from any active step restarts the flow.
  // Exclude booking_collect_name so a customer's name isn't mistaken for a booking trigger.
  if (state !== "idle" && state !== "booking_collect_name" && isBookingIntent(messageText)) {
    await startBookingFlow(db, businessId, customerId, fromPhone);
    return;
  }

  switch (state) {
    case "idle":
      if (isBookingIntent(messageText)) {
        await startBookingFlow(db, businessId, customerId, fromPhone);
      }
      // Non-booking messages in idle state are ignored here; AI will handle them later.
      break;
    case "booking_collect_name":
      await handleNameCollection(db, businessId, customerId, fromPhone, messageText);
      break;
    case "booking_select_service":
      await handleServiceSelection(db, businessId, customerId, fromPhone, messageText, context);
      break;
    case "booking_select_date":
      await handleDateSelection(db, businessId, customerId, fromPhone, messageText, context, timezone);
      break;
    case "booking_select_slot":
      await handleSlotSelection(db, businessId, customerId, fromPhone, messageText, context);
      break;
    case "booking_confirm":
      await handleConfirmation(db, businessId, customerId, fromPhone, messageText, context, timezone);
      break;
    default:
      await upsertConversationState(db, businessId, customerId, "idle", {});
  }
}

/**
 * Entry point when customer triggers booking intent.
 * Checks booking_enabled setting first, then customer name.
 *   → booking disabled: send "unavailable" reply, stay idle
 *   → no name: ask for it, set state booking_collect_name
 *   → name known: proceed directly to service selection
 */
async function startBookingFlow(
  db: DB, businessId: string, customerId: string, fromPhone: string
): Promise<void> {
  const enabled = await isBookingEnabled(db, businessId);
  if (!enabled) {
    console.log(`[booking] booking disabled for business=${businessId.slice(-6)} — sending unavailable message`);
    await reply(db, businessId, customerId, fromPhone,
      "קביעת תורים אינה זמינה כרגע. לפרטים נוספים אנא צרו קשר ישירות עם העסק."
    );
    return;
  }

  const existingName = await getCustomerName(db, customerId);

  if (!existingName) {
    await reply(db, businessId, customerId, fromPhone, "בשמחה 😊 איך קוראים לך?");
    await upsertConversationState(db, businessId, customerId, "booking_collect_name", {});
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
  const idx  = parseInt(text.trim(), 10) - 1;

  if (isNaN(idx) || idx < 0 || idx >= list.length) {
    let msg = `לא הבנתי. שלח את מספר השירות (1-${list.length}):\n\n`;
    list.forEach((s, i) => { msg += `${i + 1}. ${s.name}\n`; });
    msg += "\nלביטול שלח *ביטול*.";
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
      "לא הצלחתי להבין את התאריך.\n" +
      "שלח בפורמט יום/חודש (לדוגמה: 15/6)\n" +
      "או *מחר* / *מחרתיים*.\n\nלביטול שלח *ביטול*."
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
    let msg = `לא הבנתי. שלח את מספר השעה (1-${slots.length}):\n\n`;
    slots.forEach((s, i) => { msg += `${i + 1}. ${s}\n`; });
    msg += "\nלביטול שלח *ביטול*.";
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

async function handleConfirmation(
  db: DB, businessId: string, customerId: string, fromPhone: string,
  text: string, context: Record<string, unknown>, timezone: string
): Promise<void> {
  const t = text.trim();

  // Explicit cancellation
  if (t === "לא" || isCancelIntent(t)) {
    await reply(db, businessId, customerId, fromPhone, "קביעת התור בוטלה. נשמח לעזור בכל עת! 😊");
    await upsertConversationState(db, businessId, customerId, "idle", {});
    return;
  }

  const isYes = ["כן", "אישור", "אשר", "yes", "ok"].includes(t) || t.startsWith("כן");
  if (!isYes) {
    await reply(db, businessId, customerId, fromPhone, "שלח *כן* לאישור התור או *לא* לביטול.");
    return;
  }

  const date      = context.selected_date      as string;
  const slotTime  = context.selected_slot_time as string;
  const serviceId = context.selected_service_id as string | undefined;
  const duration  = (context.selected_duration_minutes as number) ?? 30;
  const serviceName = context.selected_service_name as string;

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
      console.warn(`[booking] slot collision business=${businessId} date=${date} slot=${slotTime}`);
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
