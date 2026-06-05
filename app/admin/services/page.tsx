import Link from "next/link";
import { getServices } from "@/lib/booking/services";

export const dynamic = "force-dynamic";

export default async function ServicesPage() {
  let services: Awaited<ReturnType<typeof getServices>> = [];
  let dbError = false;

  try {
    services = await getServices();
  } catch {
    dbError = true;
  }

  return (
    <main className="min-h-screen bg-gray-50 p-8">
      <div className="flex items-center gap-4 mb-8">
        <Link href="/admin" className="text-sm text-gray-500 hover:text-gray-700">
          ← Admin
        </Link>
        <h1 className="text-3xl font-bold text-gray-900">Services</h1>
      </div>

      {dbError && (
        <div className="mb-6 p-4 bg-amber-50 border border-amber-200 rounded-lg text-amber-800 text-sm">
          Database not connected. Connect a PostgreSQL database and run the seed script.
        </div>
      )}

      <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b border-gray-200">
            <tr>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Name</th>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Description</th>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Duration</th>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Price</th>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Status</th>
            </tr>
          </thead>
          <tbody>
            {!dbError && services.length === 0 && (
              <tr>
                <td
                  colSpan={5}
                  className="px-4 py-10 text-center text-gray-400"
                >
                  No services found. Run{" "}
                  <code className="font-mono text-xs">npx prisma db seed</code> to add seed
                  data.
                </td>
              </tr>
            )}
            {services.map((service) => (
              <tr key={service.id} className="border-b border-gray-100 last:border-0">
                <td className="px-4 py-3 font-medium text-gray-900">{service.name}</td>
                <td className="px-4 py-3 text-gray-500">{service.description ?? "—"}</td>
                <td className="px-4 py-3 text-gray-600">{service.durationMinutes} min</td>
                <td className="px-4 py-3 text-gray-600">{"\u20AA" + service.price.toString()}</td>
                <td className="px-4 py-3">
                  <span
                    className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${
                      service.isActive
                        ? "bg-green-100 text-green-700"
                        : "bg-gray-100 text-gray-500"
                    }`}
                  >
                    {service.isActive ? "Active" : "Inactive"}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </main>
  );
}
