"use client";

import { useState } from "react";
import { fetchSlots } from "@/app/admin/availability/actions";

const TZ = "Asia/Jerusalem";

function formatSlotTime(isoStr: string): string {
  return new Intl.DateTimeFormat("en-IL", {
    timeZone: TZ,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(isoStr));
}

type SimpleService = { id: string; name: string; durationMinutes: number };
type SimpleStaff = { id: string; name: string };

export default function AvailabilityChecker({
  services,
  staff,
}: {
  services: SimpleService[];
  staff: SimpleStaff[];
}) {
  const [serviceId, setServiceId] = useState(services[0]?.id ?? "");
  const [staffId, setStaffId] = useState(staff[0]?.id ?? "");
  const [date, setDate] = useState("");
  const [slots, setSlots] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [searched, setSearched] = useState(false);

  async function handleCheck() {
    if (!serviceId || !staffId || !date) return;
    setLoading(true);
    setError("");
    setSlots([]);
    setSearched(false);

    const result = await fetchSlots(serviceId, staffId, date);
    setLoading(false);
    setSearched(true);

    if (result.error) {
      setError(result.error);
    } else {
      setSlots(result.slots);
    }
  }

  if (services.length === 0) {
    return (
      <p className="text-gray-500 text-sm">
        No services found. Connect the database and run the seed script first.
      </p>
    );
  }

  return (
    <div className="max-w-xl">
      <div className="bg-white rounded-lg border border-gray-200 p-6 space-y-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Service</label>
          <select
            value={serviceId}
            onChange={(e) => setServiceId(e.target.value)}
            className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gray-400"
          >
            {services.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} ({s.durationMinutes} min)
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Staff</label>
          <select
            value={staffId}
            onChange={(e) => setStaffId(e.target.value)}
            className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gray-400"
          >
            {staff.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Date</label>
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gray-400"
          />
        </div>

        <button
          onClick={handleCheck}
          disabled={loading || !date}
          className="w-full bg-gray-900 text-white rounded-md px-4 py-2 text-sm font-medium hover:bg-gray-700 disabled:opacity-40 transition-colors"
        >
          {loading ? "Checking…" : "Check Availability"}
        </button>
      </div>

      {error && (
        <div className="mt-4 p-4 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
          {error}
        </div>
      )}

      {searched && !error && slots.length === 0 && (
        <div className="mt-4 p-6 bg-white border border-gray-200 rounded-lg text-center text-gray-400 text-sm">
          No available slots for the selected date.
        </div>
      )}

      {slots.length > 0 && (
        <div className="mt-4">
          <p className="text-sm font-medium text-gray-700 mb-2">
            {slots.length} available slot{slots.length !== 1 ? "s" : ""} (Jerusalem time):
          </p>
          <div className="grid grid-cols-4 gap-2">
            {slots.map((s) => (
              <div
                key={s}
                className="bg-white border border-gray-200 rounded-md px-3 py-2 text-center text-sm text-gray-700 font-mono"
              >
                {formatSlotTime(s)}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
