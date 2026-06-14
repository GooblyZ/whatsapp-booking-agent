import { todayInTZ } from "./availability";
import { upcomingDates } from "./platform";

export interface DayOption {
  dateISO: string;
  label: string; // "היום" / "מחר" / weekday name
  sub: string;   // "15/6"
}

/** Hebrew labels for the day picker, computed server-side. */
export function buildDayOptions(timezone: string): DayOption[] {
  const today = todayInTZ(timezone);
  const weekday = new Intl.DateTimeFormat("he-IL", { timeZone: "UTC", weekday: "long" });
  return upcomingDates(timezone).map((dateISO, i) => {
    const noon = new Date(dateISO + "T12:00:00Z");
    const [, m, d] = dateISO.split("-");
    const label = i === 0 && dateISO === today ? "היום" : i === 1 ? "מחר" : weekday.format(noon);
    return { dateISO, label, sub: `${parseInt(d, 10)}/${parseInt(m, 10)}` };
  });
}
