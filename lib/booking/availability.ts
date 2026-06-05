import { prisma } from "@/lib/db/prisma";
import { getJerusalemDayOfWeek, jerusalemLocalToUtc } from "./timezone";

// How far apart slot start times are. Service duration is independent of this.
const DEFAULT_SLOT_INTERVAL_MINUTES = 30;

export async function getAvailableSlots({
  serviceId,
  staffId,
  date,
}: {
  serviceId: string;
  staffId: string;
  date: string; // "YYYY-MM-DD" interpreted in Asia/Jerusalem
}): Promise<Date[]> {
  const service = await prisma.service.findUnique({ where: { id: serviceId } });
  if (!service) return [];

  const dayOfWeek = getJerusalemDayOfWeek(date);

  const workingHour = await prisma.workingHour.findUnique({
    where: { staffId_dayOfWeek: { staffId, dayOfWeek } },
  });
  if (!workingHour) return []; // closed day

  const dayStart = jerusalemLocalToUtc(date, workingHour.startTime);
  const dayEnd = jerusalemLocalToUtc(date, workingHour.endTime);

  const [blockedTimes, appointments] = await Promise.all([
    prisma.blockedTime.findMany({
      where: { staffId, startAt: { lt: dayEnd }, endAt: { gt: dayStart } },
    }),
    prisma.appointment.findMany({
      where: {
        staffId,
        status: { not: "CANCELLED" },
        startAt: { lt: dayEnd },
        endAt: { gt: dayStart },
      },
    }),
  ]);

  const durationMs = service.durationMinutes * 60_000;
  const intervalMs = DEFAULT_SLOT_INTERVAL_MINUTES * 60_000;
  const now = new Date();
  const slots: Date[] = [];

  for (
    let t = dayStart.getTime();
    t + durationMs <= dayEnd.getTime();
    t += intervalMs
  ) {
    const slotStart = new Date(t);
    const slotEnd = new Date(t + durationMs);

    if (slotStart <= now) continue;

    const blocked = blockedTimes.some(
      (b) => b.startAt < slotEnd && b.endAt > slotStart
    );
    if (blocked) continue;

    const booked = appointments.some(
      (a) => a.startAt < slotEnd && a.endAt > slotStart
    );
    if (booked) continue;

    slots.push(slotStart);
  }

  return slots;
}
