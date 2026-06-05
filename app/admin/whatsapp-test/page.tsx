import Link from "next/link";
import WhatsAppTestForm from "./WhatsAppTestForm";

export default function WhatsAppTestPage() {
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
    </main>
  );
}
