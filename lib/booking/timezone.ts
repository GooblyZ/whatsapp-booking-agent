const TZ = "Asia/Jerusalem";

// Returns the Jerusalem UTC offset in minutes (positive = ahead of UTC).
export function getJerusalemOffsetMinutes(utcDate: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(utcDate);

  const get = (t: string) => {
    const p = parts.find((x) => x.type === t);
    return p ? parseInt(p.value, 10) : 0;
  };

  // hour can be "24" at midnight in some locales — normalise it
  const hour = get("hour") === 24 ? 0 : get("hour");

  const tzAsUtc = new Date(
    Date.UTC(get("year"), get("month") - 1, get("day"), hour, get("minute"), get("second"))
  );

  return (tzAsUtc.getTime() - utcDate.getTime()) / 60_000;
}

// Convert a Jerusalem local time ("HH:MM" on a given "YYYY-MM-DD") to a UTC Date.
export function jerusalemLocalToUtc(dateStr: string, timeStr: string): Date {
  const [year, month, day] = dateStr.split("-").map(Number);
  const [hours, minutes] = timeStr.split(":").map(Number);

  // Approximate UTC assuming no offset, then apply the real offset at that point.
  const approx = new Date(Date.UTC(year, month - 1, day, hours, minutes));
  const offset = getJerusalemOffsetMinutes(approx);
  return new Date(approx.getTime() - offset * 60_000);
}

// Returns 0 (Sunday) … 6 (Saturday) for a "YYYY-MM-DD" date in Jerusalem TZ.
export function getJerusalemDayOfWeek(dateStr: string): number {
  const [year, month, day] = dateStr.split("-").map(Number);
  // Use noon UTC so we never straddle a date boundary regardless of TZ offset
  const noon = new Date(Date.UTC(year, month - 1, day, 12));
  const dayName = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    weekday: "short",
  }).format(noon);
  const map: Record<string, number> = {
    Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
  };
  return map[dayName] ?? 0;
}

// Returns "YYYY-MM-DD" for a UTC Date interpreted in Jerusalem TZ.
export function getJerusalemDateString(utcDate: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(utcDate);
}
