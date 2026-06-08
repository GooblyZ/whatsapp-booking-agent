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

  const tzRaw = (formData.get("timezone") as string)?.trim() ?? "";
  const timezoneProvided = tzRaw.length > 0;
  const timezoneValid    = timezoneProvided && isValidTimezone(tzRaw);
  const timezoneError    = timezoneProvided && !timezoneValid;

  const phoneRaw = (formData.get("phone") as string)?.trim() ?? "";
  const phoneProvided = phoneRaw.length > 0;
  const phoneValid    = !phoneProvided || PHONE_RE.test(phoneRaw);

  const durationRaw = parseInt((formData.get("default_slot_duration_minutes") as string) ?? "30", 10);
  const duration    = Number.isNaN(durationRaw) || durationRaw < 5 ? 30 : durationRaw;

  if (timezoneError) {
    redirect("/dashboard/business-settings?error=invalid_timezone");
  }
  if (!phoneValid) {
    redirect("/dashboard/business-settings?error=invalid_phone");
  }

  await updateBusinessSettings(businessId, {
    name:     (formData.get("name") as string)?.trim() || undefined,
    phone:    phoneProvided ? phoneRaw : null,
    timezone: timezoneValid ? tzRaw : undefined,
    language: (formData.get("language") as string)?.trim() || undefined,
    booking_enabled:               formData.get("booking_enabled") === "true",
    default_slot_duration_minutes: duration,
    cancellation_policy_text:      orNull(formData.get("cancellation_policy_text") as string ?? ""),
    // Location
    address:              orNull(formData.get("address") as string ?? ""),
    city:                 orNull(formData.get("city") as string ?? ""),
    parking_instructions: orNull(formData.get("parking_instructions") as string ?? ""),
    entrance_instructions: orNull(formData.get("entrance_instructions") as string ?? ""),
  });

  redirect("/dashboard/business-settings?saved=1");
}
