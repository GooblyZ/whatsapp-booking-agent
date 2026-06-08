"use server";

import { getDefaultBusinessId } from "@/lib/config";
import { updateBusinessSettings } from "@/lib/services/business";
import { redirect } from "next/navigation";

/** Accepts Israeli mobile/landline and international E.164 formats. */
const PHONE_RE = /^[\+\d][\d\s\-().]{5,19}$/;

/** Returns true if the string is a valid IANA timezone identifier. */
function isValidTimezone(tz: string): boolean {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function orNull(v: string): string | null {
  return v.trim().length > 0 ? v.trim() : null;
}

export async function saveBusinessSettingsAction(formData: FormData) {
  const businessId = getDefaultBusinessId();

  const name = (formData.get("name") as string)?.trim() ?? "";
  if (name.length < 2) {
    redirect("/dashboard/business-settings?error=invalid_name");
  }

  const tzRaw = (formData.get("timezone") as string)?.trim() ?? "";
  const timezoneProvided = tzRaw.length > 0;
  const timezoneValid    = timezoneProvided && isValidTimezone(tzRaw);
  const timezoneError    = timezoneProvided && !timezoneValid;

  const phoneRaw   = (formData.get("phone") as string)?.trim() ?? "";
  const phoneValid = phoneRaw.length === 0 || PHONE_RE.test(phoneRaw);

  if (timezoneError) {
    redirect("/dashboard/business-settings?error=invalid_timezone");
  }
  if (!phoneValid) {
    redirect("/dashboard/business-settings?error=invalid_phone");
  }

  const durationRaw = parseInt((formData.get("default_slot_duration_minutes") as string) ?? "30", 10);
  const duration    = Number.isNaN(durationRaw) || durationRaw < 5 ? 30 : durationRaw;

  await updateBusinessSettings(businessId, {
    name,
    phone:    phoneRaw.length > 0 ? phoneRaw : null,
    timezone: timezoneValid ? tzRaw : undefined,
    // Location (identity fields — not booking logic)
    address: orNull(formData.get("address") as string ?? ""),
    city:    orNull(formData.get("city") as string ?? ""),
    // Booking system
    booking_enabled:               formData.get("booking_enabled") === "true",
    default_slot_duration_minutes: duration,
    // NOTE: parking_instructions, entrance_instructions, cancellation_policy_text,
    // and language are intentionally NOT saved here anymore.
    // Parking/entrance → Knowledge Base (category: parking, contact)
    // Cancellation policy → Knowledge Base (category: policy)
    // Language → ai_settings.language only
  });

  redirect("/dashboard/business-settings?saved=1");
}
