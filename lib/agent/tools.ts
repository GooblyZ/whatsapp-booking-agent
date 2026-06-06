import { prisma } from "@/lib/db/prisma";
import { getAvailableSlots } from "@/lib/booking/availability";
import { getJerusalemDayOfWeek } from "@/lib/booking/timezone";

// ─── Result types ──────────────────────────────────────────────────────────────

export interface ServiceResult {
  id: string;
  name: string;
  description: string | null;
  durationMinutes: number;
  price: string;
  isActive: boolean;
}

export interface WorkingHourResult {
  dayOfWeek: number;
  dayLabel: string;
  startTime: string | null;
  endTime: string | null;
  isClosed: boolean;
}

export interface BusinessInfoResult {
  staffName: string | null;
  workingHours: WorkingHourResult[];
  source: "database" | "static_fallback";
}

export interface AvailabilityResult {
  dateStr: string;
  serviceName: string;
  serviceId: string | null;
  serviceFound: boolean;
  allSlotTimes: string[];
  filteredSlotTimes: string[];
  filterApplied: string | null;
  noSlotsReason: string | null;
  // Working-hour metadata sourced from WorkingHour table (or static fallback).
  // Used by the response composer for accurate business-hours explanations.
  workingDayStart: string | null;
  workingDayEnd: string | null;
  isWorkingDay: boolean;
}

export interface AppointmentResult {
  id: string;
  service: string;
  staff: string;
  startAt: string;
  status: string;
  dateLabel: string;
  timeLabel: string;
}

export interface CustomerAppointmentsResult {
  customerFound: boolean;
  customerName: string | null;
  phone: string;
  appointments: AppointmentResult[];
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

const DAY_LABELS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function formatUtcAsJerusalem(utcDate: Date, style: "time" | "date"): string {
  if (style === "time") {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Jerusalem",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(utcDate);
  }
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jerusalem",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(utcDate);
}

function slotMinutes(timeStr: string): number {
  const [h, m] = timeStr.split(":").map(Number);
  return h * 60 + m;
}

function filterSlotsByPreference(times: string[], pref: string | null): string[] {
  if (!pref || times.length === 0) return times;
  const tp = pref.toLowerCase();

  if (tp === "morning") return times.filter((t) => slotMinutes(t) < 720);
  if (tp === "afternoon") return times.filter((t) => slotMinutes(t) >= 720 && slotMinutes(t) < 960);
  if (tp === "evening" || tp === "night") return times.filter((t) => slotMinutes(t) >= 960);
  if (tp === "noon") return times.filter((t) => slotMinutes(t) >= 720 && slotMinutes(t) < 840);

  const after = tp.match(/^after\s+(\d{1,2})(?::(\d{2}))?/);
  if (after) {
    const threshold = parseInt(after[1]) * 60 + parseInt(after[2] ?? "0");
    return times.filter((t) => slotMinutes(t) >= threshold);
  }

  const at = tp.match(/^at\s+(\d{1,2})(?::(\d{2}))?/);
  if (at) {
    const target = parseInt(at[1]) * 60 + parseInt(at[2] ?? "0");
    const nearby = times.filter((t) => Math.abs(slotMinutes(t) - target) <= 60);
    return nearby.length > 0 ? nearby : times.filter((t) => slotMinutes(t) >= target);
  }

  return times;
}

// ─── Tool: getServices ─────────────────────────────────────────────────────────

export async function getServicesTool(): Promise<ServiceResult[]> {
  const rows = await prisma.service.findMany({
    where: { isActive: true },
    orderBy: { name: "asc" },
  });
  return rows.map((s) => ({
    id: s.id,
    name: s.name,
    description: s.description,
    durationMinutes: s.durationMinutes,
    price: s.price.toString(),
    isActive: s.isActive,
  }));
}

// ─── Tool: getBusinessInfo ─────────────────────────────────────────────────────

const STATIC_HOURS: WorkingHourResult[] = [
  { dayOfWeek: 0, dayLabel: "Sunday", startTime: "09:00", endTime: "18:00", isClosed: false },
  { dayOfWeek: 1, dayLabel: "Monday", startTime: "09:00", endTime: "18:00", isClosed: false },
  { dayOfWeek: 2, dayLabel: "Tuesday", startTime: "09:00", endTime: "18:00", isClosed: false },
  { dayOfWeek: 3, dayLabel: "Wednesday", startTime: "09:00", endTime: "18:00", isClosed: false },
  { dayOfWeek: 4, dayLabel: "Thursday", startTime: "09:00", endTime: "18:00", isClosed: false },
  { dayOfWeek: 5, dayLabel: "Friday", startTime: "09:00", endTime: "14:00", isClosed: false },
  { dayOfWeek: 6, dayLabel: "Saturday", startTime: null, endTime: null, isClosed: true },
];

export async function getBusinessInfoTool(): Promise<BusinessInfoResult> {
  const staff = await prisma.staff.findFirst({ where: { isActive: true } });
  if (!staff) return { staffName: null, workingHours: STATIC_HOURS, source: "static_fallback" };

  const rows = await prisma.workingHour.findMany({
    where: { staffId: staff.id },
    orderBy: { dayOfWeek: "asc" },
  });
  if (rows.length === 0) return { staffName: staff.name, workingHours: STATIC_HOURS, source: "static_fallback" };

  const covered = new Set(rows.map((r) => r.dayOfWeek));
  const hours: WorkingHourResult[] = DAY_LABELS.map((label, dow) => {
    const row = rows.find((r) => r.dayOfWeek === dow);
    if (row) return { dayOfWeek: dow, dayLabel: label, startTime: row.startTime, endTime: row.endTime, isClosed: false };
    return { dayOfWeek: dow, dayLabel: label, startTime: null, endTime: null, isClosed: !covered.has(dow) };
  });

  return { staffName: staff.name, workingHours: hours, source: "database" };
}

// ─── Tool: checkAvailability ───────────────────────────────────────────────────

export async function checkAvailabilityTool({
  extractedService,
  dateStr,
  timePreference,
}: {
  extractedService: string | null;
  dateStr: string;
  timePreference: string | null;
}): Promise<AvailabilityResult> {
  const base: AvailabilityResult = {
    dateStr,
    serviceName: extractedService ?? "Unknown",
    serviceId: null,
    serviceFound: false,
    allSlotTimes: [],
    filteredSlotTimes: [],
    filterApplied: timePreference,
    noSlotsReason: null,
    workingDayStart: null,
    workingDayEnd: null,
    isWorkingDay: false,
  };

  if (!extractedService) {
    base.noSlotsReason = "No service specified";
    return base;
  }

  // Resolve service
  const service = await resolveServiceByName(extractedService);
  if (!service) {
    base.noSlotsReason = `Service "${extractedService}" not found in database`;
    return base;
  }
  base.serviceFound = true;
  base.serviceId = service.id;
  base.serviceName = service.name;

  // Resolve staff
  const staff = await prisma.staff.findFirst({ where: { isActive: true } });
  if (!staff) {
    base.noSlotsReason = "No active staff found";
    return base;
  }

  // Fetch working-hour metadata for this specific day from the DB.
  // Falls back to STATIC_HOURS so the composer always has accurate data.
  const dayOfWeek = getJerusalemDayOfWeek(dateStr);
  const wh = await prisma.workingHour.findFirst({ where: { staffId: staff.id, dayOfWeek } });
  if (wh) {
    base.workingDayStart = wh.startTime;
    base.workingDayEnd = wh.endTime;
    base.isWorkingDay = true;
  } else {
    const staticDay = STATIC_HOURS.find((h) => h.dayOfWeek === dayOfWeek);
    if (staticDay && !staticDay.isClosed) {
      base.workingDayStart = staticDay.startTime;
      base.workingDayEnd = staticDay.endTime;
      base.isWorkingDay = true;
    }
  }

  // Fetch slots
  const utcSlots = await getAvailableSlots({ serviceId: service.id, staffId: staff.id, date: dateStr });
  const allTimes = utcSlots.map((s) => formatUtcAsJerusalem(s, "time"));
  base.allSlotTimes = allTimes;

  if (allTimes.length === 0) {
    base.noSlotsReason = "No available slots on this date (may be closed or fully booked)";
    return base;
  }

  base.filteredSlotTimes = filterSlotsByPreference(allTimes, timePreference);
  return base;
}

// ─── Tool: getCustomerAppointments ────────────────────────────────────────────

export async function getCustomerAppointmentsTool({
  phone,
}: {
  phone: string;
}): Promise<CustomerAppointmentsResult> {
  const customer = await prisma.customer.findUnique({ where: { phone } });
  if (!customer) {
    return { customerFound: false, customerName: null, phone, appointments: [] };
  }

  const rows = await prisma.appointment.findMany({
    where: { customerId: customer.id, status: { in: ["PENDING", "CONFIRMED"] } },
    include: { service: true, staff: true },
    orderBy: { startAt: "asc" },
  });

  const appointments: AppointmentResult[] = rows.map((a) => ({
    id: a.id,
    service: a.service.name,
    staff: a.staff.name,
    startAt: a.startAt.toISOString(),
    status: a.status,
    dateLabel: formatUtcAsJerusalem(a.startAt, "date"),
    timeLabel: formatUtcAsJerusalem(a.startAt, "time"),
  }));

  return { customerFound: true, customerName: customer.name, phone, appointments };
}

// ─── Service name resolver ─────────────────────────────────────────────────────

async function resolveServiceByName(
  name: string
): Promise<{ id: string; name: string; durationMinutes: number } | null> {
  const services = await prisma.service.findMany({ where: { isActive: true } });
  const normalize = (s: string) =>
    s.toLowerCase().replace(/[+&]/g, "and").replace(/\s+/g, " ").trim();

  const target = normalize(name);

  // Exact
  const exact = services.find((s) => normalize(s.name) === target);
  if (exact) return exact;

  // Target fully contained in service name or vice versa
  const partial = services.find((s) => {
    const n = normalize(s.name);
    return n.includes(target) || target.includes(n);
  });
  if (partial) return partial;

  // Compound: "haircut and beard" → find service with both words
  if (target.includes("haircut") && (target.includes("beard") || target.includes("and beard"))) {
    const compound = services.find((s) => {
      const n = normalize(s.name);
      return n.includes("haircut") && n.includes("beard");
    });
    if (compound) return compound;
  }

  // Single keyword fallback
  const keywords = ["haircut", "beard", "shave", "color", "treatment"];
  for (const kw of keywords) {
    if (target.includes(kw)) {
      const match = services.find((s) => normalize(s.name).includes(kw));
      if (match) return match;
    }
  }

  return null;
}
