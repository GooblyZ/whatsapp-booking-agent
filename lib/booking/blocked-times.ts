import { prisma } from "@/lib/db/prisma";
import { BookingError } from "./errors";

const ACTIVE_STATUSES = ["PENDING", "CONFIRMED"] as const;

// Serialisable snapshot of a conflicting appointment, safe to pass through
// server actions to client components.
export type ConflictAppointment = {
  id: string;
  customerName: string;
  customerPhone: string;
  serviceName: string;
  startAt: string; // ISO UTC string
  status: string;
};

// Thrown (instead of plain BookingError) when blocked-time creation is rejected
// because active appointments overlap the requested range. Carries structured
// conflict data so the UI can show actionable details.
export class BlockedTimeConflictError extends BookingError {
  readonly conflicts: ConflictAppointment[];
  readonly totalConflicts: number;

  constructor(
    conflicts: ConflictAppointment[],
    totalConflicts: number,
    message: string
  ) {
    super("BLOCKED_TIME_OVERLAPS_APPOINTMENTS", message);
    this.name = "BlockedTimeConflictError";
    this.conflicts = conflicts;
    this.totalConflicts = totalConflicts;
  }
}

// Returns appointments for a staff member whose [startAt, endAt) overlaps the
// given range, with customer and service included for conflict reporting.
export async function findAppointmentsOverlappingRange({
  staffId,
  startAt,
  endAt,
  activeOnly,
}: {
  staffId: string;
  startAt: Date;
  endAt: Date;
  activeOnly: boolean;
}) {
  return prisma.appointment.findMany({
    where: {
      staffId,
      startAt: { lt: endAt },
      endAt: { gt: startAt },
      ...(activeOnly ? { status: { in: [...ACTIVE_STATUSES] } } : {}),
    },
    include: { customer: true, service: true },
  });
}

export async function getBlockedTimes() {
  return prisma.blockedTime.findMany({
    include: { staff: true },
    orderBy: { startAt: "desc" },
  });
}

export async function createBlockedTime({
  staffId,
  startAt,
  endAt,
  reason,
}: {
  staffId: string;
  startAt: Date;
  endAt: Date;
  reason?: string;
}) {
  if (!staffId)
    throw new BookingError("STAFF_NOT_FOUND", "Staff member is required.");

  if (endAt <= startAt)
    throw new BookingError(
      "BLOCKED_TIME_INVALID_RANGE",
      "End time must be after start time."
    );

  const staff = await prisma.staff.findUnique({ where: { id: staffId } });
  if (!staff)
    throw new BookingError("STAFF_NOT_FOUND", "Staff member not found.");

  // Reject if active appointments fall inside the blocked range.
  // We never auto-cancel appointments — the admin must resolve conflicts manually.
  const overlapping = await findAppointmentsOverlappingRange({
    staffId,
    startAt,
    endAt,
    activeOnly: true,
  });

  if (overlapping.length > 0) {
    const count = overlapping.length;
    const conflicts: ConflictAppointment[] = overlapping.map((a) => ({
      id: a.id,
      customerName: a.customer.name,
      customerPhone: a.customer.phone,
      serviceName: a.service.name,
      startAt: a.startAt.toISOString(),
      status: a.status,
    }));

    throw new BlockedTimeConflictError(
      conflicts,
      count,
      `Cannot block this time because there ${
        count === 1
          ? "is 1 active appointment"
          : `are ${count} active appointments`
      } in this range. Cancel or reschedule them first.`
    );
  }

  return prisma.blockedTime.create({
    data: { staffId, startAt, endAt, reason: reason ?? null },
    include: { staff: true },
  });
}

export async function deleteBlockedTime({ blockedTimeId }: { blockedTimeId: string }) {
  const bt = await prisma.blockedTime.findUnique({ where: { id: blockedTimeId } });
  if (!bt)
    throw new BookingError("BLOCKED_TIME_NOT_FOUND", "Blocked time not found.");

  return prisma.blockedTime.delete({ where: { id: blockedTimeId } });
}
