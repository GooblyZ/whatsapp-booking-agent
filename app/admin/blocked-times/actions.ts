"use server";

import { revalidatePath } from "next/cache";
import {
  createBlockedTime,
  deleteBlockedTime,
  BlockedTimeConflictError,
} from "@/lib/booking/blocked-times";
import { BookingError } from "@/lib/booking/errors";
import { jerusalemLocalToUtc } from "@/lib/booking/timezone";

export type { ConflictAppointment } from "@/lib/booking/blocked-times";

export type CreateBlockedTimeResult =
  | { success: true }
  | {
      success: false;
      error: string;
      code?: string;
      conflicts?: import("@/lib/booking/blocked-times").ConflictAppointment[];
      totalConflicts?: number;
    };

// ─── Create blocked time ──────────────────────────────────────────────────────

export async function createAdminBlockedTime(data: {
  staffId: string;
  startDate: string;
  startTime: string;
  endDate: string;
  endTime: string;
  reason: string;
}): Promise<CreateBlockedTimeResult> {
  if (!data.staffId)
    return { success: false, error: "Please select a staff member." };
  if (!data.startDate || !data.startTime)
    return { success: false, error: "Start date and time are required." };
  if (!data.endDate || !data.endTime)
    return { success: false, error: "End date and time are required." };

  const startAt = jerusalemLocalToUtc(data.startDate, data.startTime);
  const endAt = jerusalemLocalToUtc(data.endDate, data.endTime);

  try {
    await createBlockedTime({
      staffId: data.staffId,
      startAt,
      endAt,
      reason: data.reason.trim() || undefined,
    });
    return { success: true };
  } catch (e) {
    if (e instanceof BlockedTimeConflictError) {
      return {
        success: false,
        error: e.message,
        code: e.code,
        conflicts: e.conflicts,
        totalConflicts: e.totalConflicts,
      };
    }
    if (e instanceof BookingError) {
      return { success: false, error: e.message, code: e.code };
    }
    return { success: false, error: "Failed to create blocked time." };
  }
}

// ─── Delete blocked time ──────────────────────────────────────────────────────

export type DeleteBlockedTimeState = { error: string } | null;

export async function deleteAdminBlockedTime(
  _prevState: DeleteBlockedTimeState,
  formData: FormData
): Promise<DeleteBlockedTimeState> {
  const id = formData.get("blockedTimeId");
  if (typeof id !== "string" || !id) return { error: "Invalid blocked time ID." };

  try {
    await deleteBlockedTime({ blockedTimeId: id });
    revalidatePath("/admin/blocked-times");
    return null;
  } catch (e) {
    if (e instanceof BookingError) return { error: e.message };
    return { error: "An unexpected error occurred." };
  }
}
