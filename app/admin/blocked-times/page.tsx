import Link from "next/link";
import { getBlockedTimes } from "@/lib/booking/blocked-times";
import { getStaff } from "@/lib/booking/services";
import BlockedTimeForm from "./BlockedTimeForm";
import DeleteBlockedTimeButton from "./DeleteBlockedTimeButton";

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

export default async function BlockedTimesPage() {
  let blockedTimes: Awaited<ReturnType<typeof getBlockedTimes>> = [];
  let staff: { id: string; name: string }[] = [];
  let dbError = false;

  try {
    const [bts, stf] = await Promise.all([getBlockedTimes(), getStaff()]);
    blockedTimes = bts;
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
        <h1 className="text-3xl font-bold text-gray-900">Blocked Times</h1>
      </div>

      {dbError && (
        <div className="p-4 bg-amber-50 border border-amber-200 rounded-lg text-amber-800 text-sm">
          Database not connected.
        </div>
      )}

      {!dbError && (
        <>
          <BlockedTimeForm staff={staff} />

          {blockedTimes.length === 0 ? (
            <div className="bg-white rounded-lg border border-gray-200 p-16 text-center">
              <p className="text-gray-400 text-lg font-medium">No blocked times</p>
              <p className="text-gray-400 text-sm mt-1">
                Use the form above to block off unavailable time.
              </p>
            </div>
          ) : (
            <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 border-b border-gray-200">
                  <tr>
                    <th className="px-4 py-3 text-left font-medium text-gray-700">Staff</th>
                    <th className="px-4 py-3 text-left font-medium text-gray-700">
                      Start (IL)
                    </th>
                    <th className="px-4 py-3 text-left font-medium text-gray-700">End (IL)</th>
                    <th className="px-4 py-3 text-left font-medium text-gray-700">Reason</th>
                    <th className="px-4 py-3 text-left font-medium text-gray-700"></th>
                  </tr>
                </thead>
                <tbody>
                  {blockedTimes.map((bt) => (
                    <tr key={bt.id} className="border-b border-gray-100 last:border-0">
                      <td className="px-4 py-3 font-medium text-gray-900">
                        {bt.staff.name}
                      </td>
                      <td className="px-4 py-3 text-gray-600">
                        {formatDateTime(bt.startAt)}
                      </td>
                      <td className="px-4 py-3 text-gray-600">
                        {formatDateTime(bt.endAt)}
                      </td>
                      <td className="px-4 py-3 text-gray-400">{bt.reason ?? "—"}</td>
                      <td className="px-4 py-3">
                        <DeleteBlockedTimeButton blockedTimeId={bt.id} />
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
