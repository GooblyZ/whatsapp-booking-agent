"use client";

import { useActionState } from "react";
import { sendTestWhatsAppMessage, SendTestState } from "./actions";

export default function WhatsAppTestForm() {
  const [state, formAction, pending] = useActionState<SendTestState, FormData>(
    sendTestWhatsAppMessage,
    null
  );

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-6 max-w-lg">
      <form action={formAction} className="space-y-4">
        <div>
          <label htmlFor="to" className="block text-sm font-medium text-gray-700 mb-1">
            Recipient phone (international format)
          </label>
          <input
            id="to"
            name="to"
            type="text"
            placeholder="9725XXXXXXXX"
            required
            className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gray-400"
          />
        </div>

        <div>
          <label htmlFor="body" className="block text-sm font-medium text-gray-700 mb-1">
            Message body
          </label>
          <textarea
            id="body"
            name="body"
            rows={3}
            placeholder="Test reply from Booking Agent"
            required
            className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gray-400 resize-none"
          />
        </div>

        <button
          type="submit"
          disabled={pending}
          className="w-full bg-gray-900 text-white text-sm font-medium px-4 py-2 rounded-md hover:bg-gray-700 disabled:opacity-50 transition-colors"
        >
          {pending ? "Sending…" : "Send test message"}
        </button>
      </form>

      {state && (
        <div
          className={`mt-4 p-3 rounded-md text-sm ${
            state.success
              ? "bg-green-50 border border-green-200 text-green-800"
              : "bg-red-50 border border-red-200 text-red-800"
          }`}
        >
          {state.success ? (
            <>
              <p className="font-medium">Message sent successfully.</p>
              {state.messageId && (
                <p className="mt-1 text-xs text-green-600">Meta ID: {state.messageId}</p>
              )}
            </>
          ) : (
            <p>{state.error}</p>
          )}
        </div>
      )}
    </div>
  );
}
