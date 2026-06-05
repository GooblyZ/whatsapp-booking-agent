import Link from "next/link";
import { prisma } from "@/lib/db/prisma";

export const dynamic = "force-dynamic";

async function getStats() {
  try {
    const [appointments, services, staff] = await Promise.all([
      prisma.appointment.count(),
      prisma.service.count({ where: { isActive: true } }),
      prisma.staff.count({ where: { isActive: true } }),
    ]);
    return { appointments, services, staff };
  } catch {
    return null;
  }
}

export default async function AdminPage() {
  const stats = await getStats();

  return (
    <main className="min-h-screen bg-gray-50 p-8">
      <h1 className="text-3xl font-bold text-gray-900 mb-2">Admin Dashboard</h1>
      <p className="text-gray-500 mb-8">WhatsApp AI Booking Agent</p>

      {!stats && (
        <div className="mb-6 p-4 bg-amber-50 border border-amber-200 rounded-lg text-amber-800 text-sm">
          Database not connected. Add a real <code className="font-mono">DATABASE_URL</code> to{" "}
          <code className="font-mono">.env</code>, run{" "}
          <code className="font-mono">npx prisma migrate dev</code>, then{" "}
          <code className="font-mono">npx prisma db seed</code>.
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
        <StatCard label="Total Appointments" value={stats?.appointments ?? "—"} />
        <StatCard label="Active Services" value={stats?.services ?? "—"} />
        <StatCard label="Active Staff" value={stats?.staff ?? "—"} />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <NavCard
          href="/admin/services"
          title="Services"
          description="View and manage all services"
        />
        <NavCard
          href="/admin/appointments"
          title="Appointments"
          description="View and manage appointments"
        />
        <NavCard
          href="/admin/availability"
          title="Availability"
          description="Check available time slots"
        />
        <NavCard
          href="/admin/blocked-times"
          title="Blocked Times"
          description="Block staff unavailability"
        />
      </div>
    </main>
  );
}

function StatCard({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="bg-white rounded-lg border border-gray-200 p-6">
      <p className="text-sm text-gray-500 mb-1">{label}</p>
      <p className="text-4xl font-bold text-gray-900">{value}</p>
    </div>
  );
}

function NavCard({
  href,
  title,
  description,
}: {
  href: string;
  title: string;
  description: string;
}) {
  return (
    <Link
      href={href}
      className="block bg-white rounded-lg border border-gray-200 p-6 hover:border-gray-400 hover:shadow-sm transition-all"
    >
      <h2 className="font-semibold text-gray-900 mb-1">{title}</h2>
      <p className="text-sm text-gray-500">{description}</p>
      <span className="text-sm text-gray-400 mt-2 inline-block">View →</span>
    </Link>
  );
}
