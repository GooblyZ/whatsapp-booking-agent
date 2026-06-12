import type { DB } from "./helpers";

function pad(n: number): string {
  return n.toString().padStart(2, "0");
}

// Returns the current date as YYYY-MM-DD in the given timezone.
export function todayInTZ(timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(new Date());
}

// Returns the UTC offset in minutes for a timezone at a given instant.
// Positive = ahead of UTC (e.g. Asia/Jerusalem in summer = +180).
function getTZOffsetMinutes(date: Date, timezone: string): number {
  const utcStr = date.toLocaleString("en-US", { timeZone: "UTC" });
  const tzStr  = date.toLocaleString("en-US", { timeZone: timezone });
  // Both strings are parsed as server-local time; the server-local offset cancels.
  return (new Date(utcStr).getTime() - new Date(tzStr).getTime()) / 60_000;
}

// Converts a business-local date ("YYYY-MM-DD") and time ("HH:MM") to a UTC Date.
export function businessTimeToUTC(dateStr: string, timeStr: string, timezone: string): Date {
  const [h, m] = timeStr.split(":").map(Number);
  const [yr, mo, dy] = dateStr.split("-").map(Number);

  // Treat local time as if it were UTC to get an approximate UTC instant
  const approx = new Date(Date.UTC(yr, mo - 1, dy, h, m, 0));

  // Measure the actual offset at that instant and apply it
  const offset = getTZOffsetMinutes(approx, timezone);
  const result = new Date(approx.getTime() + offset * 60_000);

  // One correction pass handles DST edge cases
  const offset2 = getTZOffsetMinutes(result, timezone);
  return new Date(approx.getTime() + offset2 * 60_000);
}

// Formats a UTC Date as "HH:MM" displayed in the business timezone.
export function formatTimeInTZ(date: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const h = parts.find((p) => p.type === "hour")?.value ?? "00";
  const m = parts.find((p) => p.type === "minute")?.value ?? "00";
  return `${h}:${m}`;
}

// Returns available slot times ("HH:MM" in business timezone) for a given date.
// date is YYYY-MM-DD in business timezone.
export async function getAvailableSlots(
  db: DB,
  businessId: string,
  date: string,
  durationMinutes: number,
  timezone: string
): Promise<string[]> {
  // day_of_week: 0 = Sunday … 6 = Saturday (matches JS Date.getDay())
  const dayOfWeek = new Date(date + "T12:00:00Z").getDay();

  const { data: hoursRow } = await db
    .from("business_hours")
    .select("opens_at, closes_at, is_closed")
    .eq("business_id", businessId)
    .eq("day_of_week", dayOfWeek)
    .maybeSingle();

  // Default to 09:00-18:00 when no hours are configured
  let opensAt  = "09:00";
  let closesAt = "18:00";

  if (hoursRow) {
    if (hoursRow.is_closed) return [];
    if (hoursRow.opens_at)  opensAt  = hoursRow.opens_at  as string;
    if (hoursRow.closes_at) closesAt = hoursRow.closes_at as string;
  }

  // Fetch booked appointments for this calendar day (queried in UTC)
  const dayStartUTC = businessTimeToUTC(date, "00:00", timezone);
  const dayEndUTC   = businessTimeToUTC(date, "23:59", timezone);

  const { data: booked } = await db
    .from("appointments")
    .select("start_time, end_time")
    .eq("business_id", businessId)
    .in("status", ["pending", "confirmed"])
    .gte("start_time", dayStartUTC.toISOString())
    .lte("start_time", dayEndUTC.toISOString());

  const bookedRanges = (booked ?? []).map((a) => ({
    start: new Date(a.start_time as string),
    end:   new Date(a.end_time   as string),
  }));

  const [openH, openM]  = opensAt.split(":").map(Number);
  const [closeH, closeM] = closesAt.split(":").map(Number);
  const openMinutes  = openH  * 60 + openM;
  const closeMinutes = closeH * 60 + closeM;

  const available: string[] = [];

  for (let m = openMinutes; m + durationMinutes <= closeMinutes; m += durationMinutes) {
    const hh = pad(Math.floor(m / 60));
    const mm = pad(m % 60);
    const slotStartUTC = businessTimeToUTC(date, `${hh}:${mm}`, timezone);
    const slotEndUTC   = new Date(slotStartUTC.getTime() + durationMinutes * 60_000);

    const overlaps = bookedRanges.some((b) => slotStartUTC < b.end && slotEndUTC > b.start);
    if (!overlaps) available.push(`${hh}:${mm}`);
  }

  return available;
}

/**
 * True when the interval [time, time+duration] lies inside opening hours and
 * overlaps NO pending/confirmed appointment. Needed for OFF-GRID times: the
 * slot grid steps by service duration, so "15:30" on a 45-minute grid is not a
 * grid slot — but on an empty day a human receptionist would happily book it
 * (live: 15:30 on an empty Friday was reported "taken"). Also used as the
 * pre-INSERT safety check (the exact-start unique constraint cannot catch
 * overlapping bookings with different start times).
 */
export async function isIntervalFree(
  db: DB,
  businessId: string,
  date: string,
  time: string,
  durationMinutes: number,
  timezone: string
): Promise<boolean> {
  const dayOfWeek = new Date(date + "T12:00:00Z").getDay();
  const { data: hoursRow } = await db
    .from("business_hours")
    .select("opens_at, closes_at, is_closed")
    .eq("business_id", businessId)
    .eq("day_of_week", dayOfWeek)
    .maybeSingle();

  let opensAt = "09:00";
  let closesAt = "18:00";
  if (hoursRow) {
    if (hoursRow.is_closed) return false;
    if (hoursRow.opens_at) opensAt = hoursRow.opens_at as string;
    if (hoursRow.closes_at) closesAt = hoursRow.closes_at as string;
  }
  const [h, m] = time.split(":").map(Number);
  const [oh, om] = opensAt.split(":").map(Number);
  const [ch, cm] = closesAt.split(":").map(Number);
  const start = h * 60 + m;
  if (start < oh * 60 + om || start + durationMinutes > ch * 60 + cm) return false;

  const dayStartUTC = businessTimeToUTC(date, "00:00", timezone);
  const dayEndUTC = businessTimeToUTC(date, "23:59", timezone);
  const { data: booked } = await db
    .from("appointments")
    .select("start_time, end_time")
    .eq("business_id", businessId)
    .in("status", ["pending", "confirmed"])
    .gte("start_time", dayStartUTC.toISOString())
    .lte("start_time", dayEndUTC.toISOString());

  const reqStart = businessTimeToUTC(date, time, timezone);
  const reqEnd = new Date(reqStart.getTime() + durationMinutes * 60_000);
  return !(booked ?? []).some((b) => {
    const bStart = new Date(b.start_time as string);
    const bEnd = new Date(b.end_time as string);
    return reqStart < bEnd && reqEnd > bStart;
  });
}

// Parses a Hebrew or numeric date string into YYYY-MM-DD (business timezone).
// Accepts: "מחר", "מחרתיים", "DD/MM", "DD/MM/YYYY"
export function parseHebrewDate(input: string, timezone: string): string | null {
  const t       = input.trim();
  const todayStr = todayInTZ(timezone); // YYYY-MM-DD in business TZ

  if (t === "מחר") {
    const d = new Date(todayStr + "T12:00:00Z");
    d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString().split("T")[0];
  }

  if (t === "מחרתיים") {
    const d = new Date(todayStr + "T12:00:00Z");
    d.setUTCDate(d.getUTCDate() + 2);
    return d.toISOString().split("T")[0];
  }

  const parts = t.split("/");
  if (parts.length >= 2) {
    const day   = parseInt(parts[0], 10);
    const month = parseInt(parts[1], 10);
    const todayYear = parseInt(todayStr.split("-")[0], 10);
    const year  = parts[2] ? parseInt(parts[2], 10) : todayYear;

    if (!isNaN(day) && !isNaN(month) && day >= 1 && day <= 31 && month >= 1 && month <= 12) {
      const candidate = `${year}-${pad(month)}-${pad(day)}`;
      // If the resulting date is in the past, try next year
      return candidate < todayStr ? `${year + 1}-${pad(month)}-${pad(day)}` : candidate;
    }
  }

  return null;
}
