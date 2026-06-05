export type BookingErrorCode =
  | "CUSTOMER_NAME_REQUIRED"
  | "CUSTOMER_PHONE_REQUIRED"
  | "SERVICE_NOT_FOUND"
  | "SERVICE_INACTIVE"
  | "STAFF_NOT_FOUND"
  | "STAFF_INACTIVE"
  | "START_TIME_IN_PAST"
  | "OUTSIDE_WORKING_HOURS"
  | "BLOCKED_TIME_OVERLAP"
  | "BLOCKED_TIME_NOT_FOUND"
  | "BLOCKED_TIME_INVALID_RANGE"
  | "BLOCKED_TIME_OVERLAPS_APPOINTMENTS"
  | "APPOINTMENT_OVERLAP"
  | "APPOINTMENT_NOT_FOUND"
  | "APPOINTMENT_ALREADY_CANCELLED"
  | "APPOINTMENT_CANNOT_BE_CANCELLED"
  | "INVALID_SOURCE";

export class BookingError extends Error {
  readonly code: BookingErrorCode;

  constructor(code: BookingErrorCode, message: string) {
    super(message);
    this.name = "BookingError";
    this.code = code;
  }
}
