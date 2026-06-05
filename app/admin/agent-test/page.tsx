import Link from "next/link";
import AgentTestForm from "./AgentTestForm";

export default function AgentTestPage() {
  return (
    <main className="min-h-screen bg-gray-50 p-8">
      <div className="mb-6">
        <Link href="/admin" className="text-sm text-gray-500 hover:text-gray-700">
          ← Admin
        </Link>
      </div>

      <h1 className="text-2xl font-bold text-gray-900 mb-1">Agent Test Console</h1>
      <p className="text-sm text-gray-500 mb-8">
        Simulate how the booking agent will interpret customer messages. No actions are executed. Internal use only.
      </p>

      <AgentTestForm />
    </main>
  );
}
