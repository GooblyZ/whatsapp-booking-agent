import Link from "next/link";
import { prisma } from "@/lib/db/prisma";
import WhatsAppTestForm from "./WhatsAppTestForm";

export const dynamic = "force-dynamic";

async function getRecentMessages() {
  return prisma.message.findMany({
    orderBy: { createdAt: "desc" },
    take: 10,
    select: {
      id: true,
      direction: true,
      fromPhone: true,
      toPhone: true,
      body: true,
      status: true,
      statusUpdatedAt: true,
      createdAt: true,
    },
  });
}

function maskPhone(phone: string | null): string {
  if (!phone) return "—";
  return phone.slice(0, 4) + "*".repeat(Math.max(0, phone.length - 6)) + phone.slice(-2);
}

export default async function WhatsAppTestPage() {
  const messages = await getRecentMessages();

  return (
    <main className="min-h-screen bg-gray-50 p-8">
      <div className="mb-6">
        <Link href="/admin" className="text-sm text-gray-500 hover:text-gray-700">
          ← Admin
        </Link>
      </div>

      <h1 className="text-2xl font-bold text-gray-900 mb-1">WhatsApp Test</h1>
      <p className="text-sm text-gray-500 mb-8">
        Send a plain text message to an approved WhatsApp test recipient. Internal use only.
      </p>

      <WhatsAppTestForm />

      <h2 className="text-lg font-semibold text-gray-800 mt-10 mb-4">Recent messages</h2>
      {messages.length === 0 ? (
        <p className="text-sm text-gray-400">No messages yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm bg-white border border-gray-200 rounded-lg">
            <thead>
              <tr className="border-b border-gray-200 text-left text-xs text-gray-500 uppercase">
                <th className="px-4 py-3">Direction</th>
                <th className="px-4 py-3">Phone</th>
                <th className="px-4 py-3">Body</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Created (UTC)</th>
              </tr>
            </thead>
            <tbody>
              {messages.map((m) => {
                const phone = m.direction === "INBOUND" ? m.fromPhone : m.toPhone;
                return (
                  <tr key={m.id} className="border-b border-gray-100 last:border-0">
                    <td className="px-4 py-3">
                      <span
                        className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${
                          m.direction === "INBOUND"
                            ? "bg-blue-50 text-blue-700"
                            : "bg-green-50 text-green-700"
                        }`}
                      >
                        {m.direction}
                      </span>
                    </td>
                    <td className="px-4 py-3 font-mono text-gray-600">{maskPhone(phone)}</td>
                    <td className="px-4 py-3 text-gray-700 max-w-xs truncate">{m.body ?? "—"}</td>
                    <td className="px-4 py-3">
                      {m.status ? (
                        <span
                          className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${
                            m.status === "READ"
                              ? "bg-purple-50 text-purple-700"
                              : m.status === "DELIVERED"
                              ? "bg-teal-50 text-teal-700"
                              : m.status === "SENT"
                              ? "bg-gray-100 text-gray-600"
                              : "bg-red-50 text-red-700"
                          }`}
                        >
                          {m.status}
                        </span>
                      ) : (
                        <span className="text-gray-300">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-gray-400 text-xs whitespace-nowrap">
                      {m.createdAt.toISOString().replace("T", " ").slice(0, 19)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
