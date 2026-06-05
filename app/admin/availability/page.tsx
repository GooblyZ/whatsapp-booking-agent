import Link from "next/link";
import { getServices, getStaff } from "@/lib/booking/services";
import AvailabilityChecker from "@/components/admin/AvailabilityChecker";

export const dynamic = "force-dynamic";

export default async function AvailabilityPage() {
  let services: { id: string; name: string; durationMinutes: number }[] = [];
  let staff: { id: string; name: string }[] = [];
  let dbError = false;

  try {
    const [rawServices, rawStaff] = await Promise.all([getServices(), getStaff()]);
    services = rawServices.map((s) => ({
      id: s.id,
      name: s.name,
      durationMinutes: s.durationMinutes,
    }));
    staff = rawStaff.map((s) => ({ id: s.id, name: s.name }));
  } catch {
    dbError = true;
  }

  return (
    <main className="min-h-screen bg-gray-50 p-8">
      <div className="flex items-center gap-4 mb-8">
        <Link href="/admin" className="text-sm text-gray-500 hover:text-gray-700">
          ← Admin
        </Link>
        <h1 className="text-3xl font-bold text-gray-900">Check Availability</h1>
      </div>

      {dbError && (
        <div className="mb-6 p-4 bg-amber-50 border border-amber-200 rounded-lg text-amber-800 text-sm">
          Database not connected. Connect a PostgreSQL database and run the seed script.
        </div>
      )}

      <AvailabilityChecker services={services} staff={staff} />
    </main>
  );
}
