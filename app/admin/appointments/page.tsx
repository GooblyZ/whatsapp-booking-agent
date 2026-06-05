import Link from "next/link";
import { getAppointments } from "@/lib/booking/appointments";
import { getServices, getStaff } from "@/lib/booking/services";
import { AppointmentStatus } from "@/app/generated/prisma/client";
import AppointmentForm from "./AppointmentForm";
import CancelButton from "./CancelButton";

export const dynamic = "force-dynamic";

const TZ = "Asia/Jerusalem";

function formatDateTime(date: Date): string {
  return new Intl.DateTimeFormat("en-IL", {
    timeZone: TZ,
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

const statusStyle: Record<AppointmentStatus, string> = {
  PENDING: "bg-yellow-100 text-yellow-700",
  CONFIRMED: "bg-green-100 text-green-700",
  CANCELLED: "bg-red-100 text-red-600",
  COMPLETED: "bg-blue-100 text-blue-700",
  NO_SHOW: "bg-gray-100 text-gray-500",
};

export default async function AppointmentsPage() {
  let appointments: Awaited<ReturnType<typeof getAppointments>> = [];
  let services: { id: string; name: string; durationMinutes: number }[] = [];
  let staff: { id: string; name: string }[] = [];
  let dbError = false;

  try {
    const [appts, svcs, stf] = await Promise.all([
      getAppointments(),
      getServices(),
      getStaff(),
    ]);
    appointments = appts;
    services = svcs.map((s) => ({
      id: s.id,
      name: s.name,
      durationMinutes: s.durationMinutes,
    }));
    staff = stf.map((s) => ({ id: s.id, name: s.name }));
  } catch {
    dbError = true;
  }

  return (
    <main className="min-h-screen bg-gray-50 p-8">
      <div className="flex items-center gap-4 mb-8">
        <Link href="/admin" className="text-sm text-gray-500 hover:text-gray-700">
          ← Admin
        </Link>
        <h1 className="text-3xl font-bold text-gray-900">Appointments</h1>
      </div>

      {dbError && (
        <div className="p-4 bg-amber-50 border border-amber-200 rounded-lg text-amber-800 text-sm">
          Database not connected.
        </div>
      )}

      {!dbError && (
        <>
          {/* Create appointment form */}
          <AppointmentForm services={services} staff={staff} />

          {/* Appointments table */}
          {appointments.length === 0 ? (
            <div className="bg-white rounded-lg border border-gray-200 p-16 text-center">
              <p className="text-gray-400 text-lg font-medium">No appointments yet</p>
              <p className="text-gray-400 text-sm mt-1">
                Use the form above to create your first test appointment.
              </p>
            </div>
          ) : (
            <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 border-b border-gray-200">
                  <tr>
                    <th className="px-4 py-3 text-left font-medium text-gray-700">
                      Customer
                    </th>
                    <th className="px-4 py-3 text-left font-medium text-gray-700">
                      Service
                    </th>
                    <th className="px-4 py-3 text-left font-medium text-gray-700">
                      Staff
                    </th>
                    <th className="px-4 py-3 text-left font-medium text-gray-700">
                      Date & Time (IL)
                    </th>
                    <th className="px-4 py-3 text-left font-medium text-gray-700">
                      Status
                    </th>
                    <th className="px-4 py-3 text-left font-medium text-gray-700">
                      Source
                    </th>
                    <th className="px-4 py-3 text-left font-medium text-gray-700"></th>
                  </tr>
                </thead>
                <tbody>
                  {appointments.map((a) => (
                    <tr
                      key={a.id}
                      className="border-b border-gray-100 last:border-0"
                    >
                      <td className="px-4 py-3">
                        <div className="font-medium text-gray-900">
                          {a.customer.name}
                        </div>
                        <div className="text-gray-400 text-xs">
                          {a.customer.phone}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-gray-600">
                        {a.service.name}
                      </td>
                      <td className="px-4 py-3 text-gray-600">
                        {a.staff.name}
                      </td>
                      <td className="px-4 py-3 text-gray-600">
                        {formatDateTime(a.startAt)}
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${
                            statusStyle[a.status]
                          }`}
                        >
                          {a.status}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-gray-400 text-xs">
                        {a.source}
                      </td>
                      <td className="px-4 py-3">
                        {(a.status === "PENDING" || a.status === "CONFIRMED") && (
                          <CancelButton appointmentId={a.id} />
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </main>
  );
}
