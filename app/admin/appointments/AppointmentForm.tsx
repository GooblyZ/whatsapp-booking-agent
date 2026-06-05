"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { fetchAdminSlots, createAdminAppointment } from "./actions";

const TZ = "Asia/Jerusalem";

function formatSlot(isoStr: string): string {
  return new Intl.DateTimeFormat("en-IL", {
    timeZone: TZ,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(isoStr));
}

type SimpleService = { id: string; name: string; durationMinutes: number };
type SimpleStaff = { id: string; name: string };

export default function AppointmentForm({
  services,
  staff,
}: {
  services: SimpleService[];
  staff: SimpleStaff[];
}) {
  const router = useRouter();

  const [customerName, setCustomerName] = useState("");
  const [customerPhone, setCustomerPhone] = useState("");
  const [serviceId, setServiceId] = useState(services[0]?.id ?? "");
  const [staffId, setStaffId] = useState(staff[0]?.id ?? "");
  const [date, setDate] = useState("");
  const [slots, setSlots] = useState<string[]>([]);
  const [selectedSlot, setSelectedSlot] = useState("");
  const [loadingSlots, setLoadingSlots] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [successMsg, setSuccessMsg] = useState("");

  async function loadSlots(svcId: string, stfId: string, dt: string) {
    if (!svcId || !stfId || !dt) return;
    setLoadingSlots(true);
    setSlots([]);
    setSelectedSlot("");
    setError("");
    const result = await fetchAdminSlots(svcId, stfId, dt);
    setLoadingSlots(false);
    if (result.error) {
      setError(result.error);
    } else {
      setSlots(result.slots);
      if (result.slots.length === 0) {
        setError("No available slots for the selected date.");
      }
    }
  }

  function handleServiceChange(v: string) {
    setServiceId(v);
    if (date) loadSlots(v, staffId, date);
  }

  function handleStaffChange(v: string) {
    setStaffId(v);
    if (date) loadSlots(serviceId, v, date);
  }

  function handleDateChange(v: string) {
    setDate(v);
    if (v) loadSlots(serviceId, staffId, v);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setSuccessMsg("");

    // Client-side pre-checks (server re-validates anyway)
    if (!customerName.trim()) { setError("Customer name is required."); return; }
    if (!customerPhone.trim()) { setError("Phone number is required."); return; }
    if (!serviceId) { setError("Please select a service."); return; }
    if (!staffId) { setError("Please select a staff member."); return; }
    if (!date) { setError("Please select a date."); return; }
    if (!selectedSlot) { setError("Please select a time slot."); return; }

    setSubmitting(true);
    const result = await createAdminAppointment({
      customerName,
      customerPhone,
      serviceId,
      staffId,
      startAt: selectedSlot,
    });
    setSubmitting(false);

    if (!result.success) {
      setError(result.error);
      // Re-fetch slots when the overlap error is from the booking engine
      if (result.code === "APPOINTMENT_OVERLAP" || result.code === "BLOCKED_TIME_OVERLAP") {
        loadSlots(serviceId, staffId, date);
      }
      return;
    }

    // Reset form state
    setCustomerName("");
    setCustomerPhone("");
    setDate("");
    setSlots([]);
    setSelectedSlot("");
    setSuccessMsg("Appointment created successfully.");

    // Refresh the server component so the appointments table updates
    router.refresh();
  }

  const slotPlaceholder = !date
    ? "Select a date first"
    : loadingSlots
    ? "Loading…"
    : slots.length === 0
    ? "No slots available"
    : "Select a slot";

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-6 mb-8">
      <h2 className="text-lg font-semibold text-gray-900 mb-5">Create Appointment</h2>

      {error && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
          {error}
        </div>
      )}
      {successMsg && (
        <div className="mb-4 p-3 bg-green-50 border border-green-200 rounded-lg text-green-700 text-sm">
          {successMsg}
        </div>
      )}

      <form onSubmit={handleSubmit} className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Customer Name */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Customer Name
          </label>
          <input
            type="text"
            value={customerName}
            onChange={(e) => setCustomerName(e.target.value)}
            placeholder="Full name"
            className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gray-400"
          />
        </div>

        {/* Phone */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Phone
          </label>
          <input
            type="tel"
            value={customerPhone}
            onChange={(e) => setCustomerPhone(e.target.value)}
            placeholder="+972..."
            className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gray-400"
          />
        </div>

        {/* Service */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Service
          </label>
          <select
            value={serviceId}
            onChange={(e) => handleServiceChange(e.target.value)}
            className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gray-400"
          >
            {services.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} ({s.durationMinutes} min)
              </option>
            ))}
          </select>
        </div>

        {/* Staff */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Staff
          </label>
          <select
            value={staffId}
            onChange={(e) => handleStaffChange(e.target.value)}
            className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gray-400"
          >
            {staff.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </div>

        {/* Date */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Date
          </label>
          <input
            type="date"
            value={date}
            onChange={(e) => handleDateChange(e.target.value)}
            className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gray-400"
          />
        </div>

        {/* Slot */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Time Slot{" "}
            {loadingSlots && (
              <span className="text-gray-400 font-normal text-xs">(Loading…)</span>
            )}
          </label>
          <select
            value={selectedSlot}
            onChange={(e) => setSelectedSlot(e.target.value)}
            disabled={slots.length === 0 || loadingSlots}
            className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gray-400 disabled:opacity-50 disabled:bg-gray-50"
          >
            <option value="">{slotPlaceholder}</option>
            {slots.map((s) => (
              <option key={s} value={s}>
                {formatSlot(s)}
              </option>
            ))}
          </select>
        </div>

        {/* Submit */}
        <div className="md:col-span-2 pt-2">
          <button
            type="submit"
            disabled={submitting || !selectedSlot || loadingSlots}
            className="bg-gray-900 text-white rounded-md px-6 py-2 text-sm font-medium hover:bg-gray-700 disabled:opacity-40 transition-colors"
          >
            {submitting ? "Creating…" : "Create Appointment"}
          </button>
        </div>
      </form>
    </div>
  );
}
