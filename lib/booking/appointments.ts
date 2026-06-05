import { prisma } from "@/lib/db/prisma";
import { AppointmentSource } from "@/app/generated/prisma/client";
import { BookingError } from "./errors";
import {
  getJerusalemDateString,
  getJerusalemDayOfWeek,
  jerusalemLocalToUtc,
} from "./timezone";

const VALID_SOURCES: AppointmentSource[] = ["WEBSITE", "WHATSAPP", "ADMIN"];

export async function getAppointments() {
  return prisma.appointment.findMany({
    include: { customer: true, service: true, staff: true },
    orderBy: { startAt: "desc" },
  });
}

export async function createAppointment({
  customerName,
  customerPhone,
  serviceId,
  staffId,
  startAt,
  source,
}: {
  customerName: string;
  customerPhone: string;
  serviceId: string;
  staffId: string;
  startAt: Date;
  source: AppointmentSource;
}) {
  // ── 1. Basic input validation ──────────────────────────────────────────────
  if (!customerName.trim())
    throw new BookingError("CUSTOMER_NAME_REQUIRED", "Customer name is required.");
  if (!customerPhone.trim())
    throw new BookingError("CUSTOMER_PHONE_REQUIRED", "Customer phone is required.");
  if (!VALID_SOURCES.includes(source))
    throw new BookingError("INVALID_SOURCE", `Invalid booking source: ${source}.`);

  // ── 2. Service and staff existence + active status ─────────────────────────
  const [service, staff] = await Promise.all([
    prisma.service.findUnique({ where: { id: serviceId } }),
    prisma.staff.findUnique({ where: { id: staffId } }),
  ]);

  if (!service) throw new BookingError("SERVICE_NOT_FOUND", "Service not found.");
  if (!service.isActive) throw new BookingError("SERVICE_INACTIVE", "Service is not currently active.");
  if (!staff) throw new BookingError("STAFF_NOT_FOUND", "Staff member not found.");
  if (!staff.isActive) throw new BookingError("STAFF_INACTIVE", "Staff member is not currently active.");

  // ── 3. Start time must be in the future ───────────────────────────────────
  if (startAt <= new Date())
    throw new BookingError("START_TIME_IN_PAST", "Appointment start time is in the past.");

  // ── 4. endAt derived from service duration — never trusted from the caller ─
  const durationMs = service.durationMinutes * 60_000;
  const endAt = new Date(startAt.getTime() + durationMs);

  // ── 5. Working-hours check ────────────────────────────────────────────────
  const jerusalemDate = getJerusalemDateString(startAt);
  const dayOfWeek = getJerusalemDayOfWeek(jerusalemDate);
  const workingHour = await prisma.workingHour.findUnique({
    where: { staffId_dayOfWeek: { staffId, dayOfWeek } },
  });
  if (!workingHour)
    throw new BookingError("OUTSIDE_WORKING_HOURS", "Staff does not work on this day.");

  const dayStart = jerusalemLocalToUtc(jerusalemDate, workingHour.startTime);
  const dayEnd = jerusalemLocalToUtc(jerusalemDate, workingHour.endTime);

  if (startAt < dayStart || endAt > dayEnd)
    throw new BookingError(
      "OUTSIDE_WORKING_HOURS",
      "Appointment falls outside staff working hours."
    );

  // ── 6. Overlap checks + insert inside a single transaction ────────────────
  //
  // TODO(production): The application-level overlap check below has a TOCTOU
  // race window when two concurrent requests reach this point simultaneously.
  // For production, replace or supplement with one of:
  //   • A PostgreSQL exclusion constraint:
  //       EXCLUDE USING gist
  //         (staff_id WITH =, tstzrange(start_at, end_at, '[)') WITH &&)
  //   • A serializable isolation transaction that aborts one conflicting writer.
  //   • A PostgreSQL advisory lock keyed on (staff_id, date) acquired before
  //     the check and released after the insert.
  return prisma.$transaction(async (tx) => {
    const blockedOverlap = await tx.blockedTime.findFirst({
      where: { staffId, startAt: { lt: endAt }, endAt: { gt: startAt } },
    });
    if (blockedOverlap)
      throw new BookingError(
        "BLOCKED_TIME_OVERLAP",
        "The selected time overlaps a blocked period."
      );

    const appointmentOverlap = await tx.appointment.findFirst({
      where: {
        staffId,
        status: { not: "CANCELLED" },
        startAt: { lt: endAt },
        endAt: { gt: startAt },
      },
    });
    if (appointmentOverlap)
      throw new BookingError("APPOINTMENT_OVERLAP", "Time slot is already booked.");

    const customer = await tx.customer.upsert({
      where: { phone: customerPhone.trim() },
      update: { name: customerName.trim() },
      create: { name: customerName.trim(), phone: customerPhone.trim() },
    });

    return tx.appointment.create({
      data: {
        customerId: customer.id,
        serviceId,
        staffId,
        startAt,
        endAt,
        source,
        status: "CONFIRMED",
      },
      include: { customer: true, service: true, staff: true },
    });
  });
}

export async function cancelAppointment({ appointmentId }: { appointmentId: string }) {
  const appt = await prisma.appointment.findUnique({ where: { id: appointmentId } });

  if (!appt)
    throw new BookingError("APPOINTMENT_NOT_FOUND", "Appointment not found.");
  if (appt.status === "CANCELLED")
    throw new BookingError("APPOINTMENT_ALREADY_CANCELLED", "Appointment is already cancelled.");
  if (appt.status === "COMPLETED" || appt.status === "NO_SHOW")
    throw new BookingError(
      "APPOINTMENT_CANNOT_BE_CANCELLED",
      "Completed or no-show appointments cannot be cancelled."
    );

  return prisma.appointment.update({
    where: { id: appointmentId },
    data: { status: "CANCELLED" },
  });
}
