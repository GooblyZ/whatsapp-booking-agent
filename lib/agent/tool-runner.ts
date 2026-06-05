import { getJerusalemDateString, getJerusalemDayOfWeek } from "@/lib/booking/timezone";
import type { AgentAnalysisResult, SuggestedTool, ToolRunResult } from "./types";
import {
  getServicesTool,
  getBusinessInfoTool,
  checkAvailabilityTool,
  getCustomerAppointmentsTool,
  ServiceResult,
  AvailabilityResult,
  CustomerAppointmentsResult,
  BusinessInfoResult,
} from "./tools";

// ─── Tool routing ──────────────────────────────────────────────────────────────

// Tools allowed to execute in this stage (read-only)
const READ_ONLY_TOOLS = new Set<SuggestedTool>([
  "getServices",
  "getBusinessInfo",
  "checkAvailability",
  "getCustomerAppointments",
]);

// Write tools that are forbidden even if suggested
const FORBIDDEN_TOOLS = new Set<SuggestedTool>(["createAppointment"]);

// For cancel/reschedule, run getCustomerAppointments as the pre-flight read
const CANCEL_TOOLS = new Set<SuggestedTool>(["cancelAppointment", "rescheduleAppointment"]);

// ─── Date resolver ─────────────────────────────────────────────────────────────

const DOW: Record<string, number> = {
  Sunday: 0, Monday: 1, Tuesday: 2, Wednesday: 3,
  Thursday: 4, Friday: 5, Saturday: 6,
};

function addDays(dateStr: string, n: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

function resolveDatePreference(label: string | null): string | null {
  if (!label) return null;
  const todayStr = getJerusalemDateString(new Date());
  const todayDow = getJerusalemDayOfWeek(todayStr);

  // Next occurrence of a given day (always >= 1 day ahead)
  const nextDow = (targetDow: number): string => {
    let offset = targetDow - todayDow;
    if (offset < 1) offset += 7;
    return addDays(todayStr, offset);
  };

  switch (label) {
    case "today": return todayStr;
    case "tomorrow": return addDays(todayStr, 1);
    case "day after tomorrow": return addDays(todayStr, 2);
    case "next week": return addDays(todayStr, 7);
    case "this week": return todayStr;
  }

  if (label.startsWith("next ")) {
    const dayName = label.slice(5);
    const dow = DOW[dayName];
    if (dow !== undefined) return nextDow(dow);
  }

  // Bare day name → nearest future occurrence
  const dow = DOW[label];
  if (dow !== undefined) return nextDow(dow);

  return null;
}

// ─── Language detection ────────────────────────────────────────────────────────

function isHebrew(text: string): boolean {
  return /[א-ת]/.test(text);
}

// ─── Draft generators ──────────────────────────────────────────────────────────

function draftServices(
  services: ServiceResult[],
  intent: string,
  extractedService: string | null,
  hebrew: boolean
): string {
  if (services.length === 0)
    return hebrew ? "מצטערים, אין לנו שירותים פעילים כרגע." : "Sorry, we have no active services at the moment.";

  // Price query for specific service
  if ((intent === "ASK_PRICES" || intent === "BOOK_APPOINTMENT") && extractedService) {
    const target = extractedService.toLowerCase().replace(/[+&]/g, "and");
    const match = services.find((s) => {
      const n = s.name.toLowerCase().replace(/[+&]/g, "and");
      return n.includes(target) || target.includes(n);
    });
    if (match) {
      return hebrew
        ? `${match.name} עולה ₪${match.price} ולוקח כ-${match.durationMinutes} דקות.`
        : `A ${match.name} costs ₪${match.price} and takes about ${match.durationMinutes} minutes.`;
    }
  }

  // Full list
  const list = services.map((s) => `${s.name} — ₪${s.price} (${s.durationMinutes} min)`).join("\n");
  const names = services.map((s) => s.name).join(", ");

  return hebrew
    ? `אנחנו מציעים את השירותים הבאים:\n${list}\n\nאיזה שירות תרצה?`
    : `We offer the following services:\n${list}\n\nWhich would you like to book?`;
}

function draftBusinessInfo(info: BusinessInfoResult, hebrew: boolean): string {
  const open = info.workingHours.filter((h) => !h.isClosed);
  const closed = info.workingHours.filter((h) => h.isClosed);
  const lines = open.map((h) => `${h.dayLabel}: ${h.startTime}–${h.endTime}`);
  if (closed.length) lines.push(`${closed.map((h) => h.dayLabel).join(", ")}: Closed`);

  return hebrew
    ? `שעות הפעילות שלנו:\n${lines.join("\n")}\n\nנשמח לראותך!`
    : `Our business hours:\n${lines.join("\n")}\n\nWe look forward to seeing you!`;
}

function draftAvailability(av: AvailabilityResult, intent: string, hebrew: boolean): string {
  const { serviceName, dateStr, filteredSlotTimes, allSlotTimes, filterApplied, noSlotsReason } = av;

  if (noSlotsReason) {
    return hebrew
      ? `לא הצלחנו למצוא תורים ל${serviceName} בתאריך ${dateStr}. ${noSlotsReason}.`
      : `No slots found for ${serviceName} on ${dateStr}. ${noSlotsReason}.`;
  }

  const top5 = (arr: string[]) => arr.slice(0, 5).join(", ");

  if (filteredSlotTimes.length > 0) {
    const slots = top5(filteredSlotTimes);
    return hebrew
      ? `${serviceName} ב-${dateStr}${filterApplied ? ` (${filterApplied})` : ""}: ${slots}. איזה שעה מתאימה לך?`
      : `Available ${serviceName} times on ${dateStr}${filterApplied ? ` (${filterApplied})` : ""}: ${slots}. Which works for you?`;
  }

  // Filtered result was empty but all-slots is not
  const alternatives = top5(allSlotTimes);
  const prefLabel = filterApplied ?? "that time";
  return hebrew
    ? `אין תורים ל${serviceName} ב${prefLabel} בתאריך ${dateStr}. השעות הפנויות הן: ${alternatives}. מה מתאים?`
    : `No ${serviceName} slots available ${prefLabel} on ${dateStr}. The available times are: ${alternatives}. Would any of those work?`;
}

function draftCustomerAppointments(
  res: CustomerAppointmentsResult,
  intent: string,
  hebrew: boolean
): string {
  if (!res.customerFound) {
    return hebrew
      ? "לא מצאנו תורים עבור המספר הזה. האם אתה בטוח שהמספר נכון?"
      : "No booking history found for this phone number. Are you sure it's correct?";
  }

  if (res.appointments.length === 0) {
    return hebrew
      ? `${res.customerName}, אין לך תורים פעילים כרגע.`
      : `${res.customerName}, you have no upcoming appointments.`;
  }

  const action = intent === "CANCEL_APPOINTMENT"
    ? (hebrew ? "לבטל" : "cancel")
    : (hebrew ? "להזיז" : "reschedule");

  if (res.appointments.length === 1) {
    const a = res.appointments[0];
    return hebrew
      ? `מצאנו תור ל${a.service} ב-${a.dateLabel} בשעה ${a.timeLabel}. האם לבטל את התור הזה?`
      : `Found your ${a.service} appointment on ${a.dateLabel} at ${a.timeLabel}. Would you like to ${action} it?`;
  }

  const list = res.appointments
    .map((a, i) => `${i + 1}. ${a.service} — ${a.dateLabel} at ${a.timeLabel}`)
    .join("\n");

  return hebrew
    ? `מצאנו ${res.appointments.length} תורים:\n${list}\n\nאיזה מהם תרצה ${action}?`
    : `Found ${res.appointments.length} upcoming appointments:\n${list}\n\nWhich one would you like to ${action}?`;
}

// ─── Main runner ───────────────────────────────────────────────────────────────

export async function runSuggestedTool(
  analysis: AgentAnalysisResult,
  originalMessage: string,
  phone?: string
): Promise<ToolRunResult> {
  const suggestedTool = analysis.suggestedToolCall.tool;
  const hebrew = isHebrew(originalMessage);
  const intent = analysis.intent;

  const skip = (reason: string): ToolRunResult => ({
    status: "skipped",
    actualToolName: suggestedTool,
    args: {},
    result: null,
    skippedReason: reason,
    enrichedDraft: analysis.draftResponse,
  });

  // ── Forbidden ──────────────────────────────────────────────────────────────
  if (FORBIDDEN_TOOLS.has(suggestedTool)) {
    return {
      status: "forbidden",
      actualToolName: suggestedTool,
      args: {},
      result: null,
      skippedReason: `${suggestedTool} is a write operation and is not permitted at this stage.`,
      enrichedDraft: analysis.draftResponse,
    };
  }

  // ── handoffToHuman — no data tool to call ─────────────────────────────────
  if (suggestedTool === "handoffToHuman") {
    return skip("Human handoff — no automated tool to execute.");
  }

  // ── Cancel/Reschedule → getCustomerAppointments ───────────────────────────
  if (CANCEL_TOOLS.has(suggestedTool)) {
    if (!phone?.trim()) {
      return skip(
        "Customer phone required to look up appointments. In live WhatsApp integration, the sender phone is provided automatically."
      );
    }
    const args = { phone };
    const result = await getCustomerAppointmentsTool(args);
    const draft = draftCustomerAppointments(result, intent, hebrew);
    return { status: "executed", actualToolName: "getCustomerAppointments", args, result, skippedReason: null, enrichedDraft: draft };
  }

  // ── getServices ────────────────────────────────────────────────────────────
  if (suggestedTool === "getServices") {
    const result = await getServicesTool();
    const draft = draftServices(result, intent, analysis.extractedService, hebrew);
    return { status: "executed", actualToolName: "getServices", args: {}, result, skippedReason: null, enrichedDraft: draft };
  }

  // ── getBusinessInfo ────────────────────────────────────────────────────────
  if (suggestedTool === "getBusinessInfo") {
    const result = await getBusinessInfoTool();
    const draft = draftBusinessInfo(result, hebrew);
    return { status: "executed", actualToolName: "getBusinessInfo", args: {}, result, skippedReason: null, enrichedDraft: draft };
  }

  // ── checkAvailability ──────────────────────────────────────────────────────
  if (suggestedTool === "checkAvailability") {
    if (!analysis.extractedService) {
      return skip("Service name required to check availability. Ask the customer which service they want.");
    }
    const resolvedDate = resolveDatePreference(analysis.extractedDate);
    if (!resolvedDate) {
      return skip("Could not resolve date preference to a specific date. Ask the customer for a concrete date.");
    }
    const args = {
      extractedService: analysis.extractedService,
      dateStr: resolvedDate,
      timePreference: analysis.extractedTime,
    };
    const result = await checkAvailabilityTool(args);
    const draft = draftAvailability(result, intent, hebrew);
    return { status: "executed", actualToolName: "checkAvailability", args, result, skippedReason: null, enrichedDraft: draft };
  }

  // ── getCustomerAppointments (direct suggestion) ────────────────────────────
  if (suggestedTool === "getCustomerAppointments") {
    if (!phone?.trim()) return skip("Customer phone required.");
    const args = { phone };
    const result = await getCustomerAppointmentsTool(args);
    const draft = draftCustomerAppointments(result, intent, hebrew);
    return { status: "executed", actualToolName: "getCustomerAppointments", args, result, skippedReason: null, enrichedDraft: draft };
  }

  return skip(`No handler for tool: ${suggestedTool}`);
}
