"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { createAdminBlockedTime } from "./actions";
import type { ConflictAppointment } from "./actions";

const TZ = "Asia/Jerusalem";

function formatConflictTime(isoStr: string): string {
  return new Intl.DateTimeFormat("en-IL", {
    timeZone: TZ,
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(isoStr));
}

type SimpleStaff = { id: string; name: string };

const MAX_SHOWN = 5;

export default function BlockedTimeForm({ staff }: { staff: SimpleStaff[] }) {
  const router = useRouter();

  const [staffId, setStaffId] = useState(staff[0]?.id ?? "");
  const [startDate, setStartDate] = useState("");
  const [startTime, setStartTime] = useState("09:00");
  const [endDate, setEndDate] = useState("");
  const [endTime, setEndTime] = useState("18:00");
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [successMsg, setSuccessMsg] = useState("");
  const [conflicts, setConflicts] = useState<ConflictAppointment[]>([]);
  const [totalConflicts, setTotalConflicts] = useState(0);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setSuccessMsg("");
    setConflicts([]);
    setTotalConflicts(0);

    if (!startDate || !endDate) {
      setError("Please select start and end dates.");
      return;
    }

    setSubmitting(true);
    const result = await createAdminBlockedTime({
      staffId,
      startDate,
      startTime,
      endDate,
      endTime,
      reason,
    });
    setSubmitting(false);

    if (!result.success) {
      setError(result.error);
      setConflicts(result.conflicts ?? []);
      setTotalConflicts(result.totalConflicts ?? 0);
      return;
    }

    setStartDate("");
    setEndDate("");
    setReason("");
    setSuccessMsg("Blocked time created.");
    router.refresh();
  }

  const shownConflicts = conflicts.slice(0, MAX_SHOWN);
  const hiddenCount = totalConflicts - shownConflicts.length;

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-6 mb-8">
      <h2 className="text-lg font-semibold text-gray-900 mb-5">Block Time</h2>

      {error && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-sm">
          <p className="text-red-700 font-medium">{error}</p>

          {shownConflicts.length > 0 && (
            <ul className="mt-2 space-y-1.5">
              {shownConflicts.map((c) => (
                <li
                  key={c.id}
                  className="text-xs border-l-2 border-red-300 pl-2 text-red-600"
                >
                  <span className="font-medium">{c.customerName}</span>
                  {" · "}
                  {c.customerPhone}
                  {" · "}
                  {c.serviceName}
                  {" · "}
                  {formatConflictTime(c.startAt)}
                  {" · "}
                  <span className="capitalize">{c.status.toLowerCase()}</span>
                </li>
              ))}
            </ul>
          )}

          {hiddenCount > 0 && (
            <p className="mt-1.5 text-xs text-red-500">
              And {hiddenCount} more appointment{hiddenCount === 1 ? "" : "s"}…
            </p>
          )}

          {shownConflicts.length > 0 && (
            <Link
              href="/admin/appointments"
              className="mt-2 inline-block text-xs text-red-700 underline hover:text-red-900"
            >
              View appointments →
            </Link>
          )}
        </div>
      )}

      {successMsg && (
        <div className="mb-4 p-3 bg-green-50 border border-green-200 rounded-lg text-green-700 text-sm">
          {successMsg}
        </div>
      )}

      <form onSubmit={handleSubmit} className="grid grid-cols-1 md:grid-cols-2 gap-4">
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
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Reason (optional)
          </label>
          <input
            type="text"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. Lunch break, Holiday…"
            className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gray-400"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Start (Jerusalem time)
          </label>
          <div className="flex gap-2">
            <input
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              className="flex-1 border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gray-400"
            />
            <input
              type="time"
              value={startTime}
              onChange={(e) => setStartTime(e.target.value)}
              className="w-28 border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gray-400"
            />
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            End (Jerusalem time)
          </label>
          <div className="flex gap-2">
            <input
              type="date"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
              className="flex-1 border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gray-400"
            />
            <input
              type="time"
              value={endTime}
              onChange={(e) => setEndTime(e.target.value)}
              className="w-28 border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gray-400"
            />
          </div>
        </div>

        <div className="md:col-span-2 pt-2">
          <button
            type="submit"
            disabled={submitting}
            className="bg-gray-900 text-white rounded-md px-6 py-2 text-sm font-medium hover:bg-gray-700 disabled:opacity-40 transition-colors"
          >
            {submitting ? "Blocking…" : "Block Time"}
          </button>
        </div>
      </form>
    </div>
  );
}
