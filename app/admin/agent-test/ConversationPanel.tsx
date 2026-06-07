"use client";

import type { ConversationState, MessageTurn, BookingLifecycle } from "@/lib/agent";

// ─── Lifecycle badge ───────────────────────────────────────────────────────────

const LIFECYCLE_STYLES: Record<BookingLifecycle, string> = {
  collecting_details:   "bg-gray-100 text-gray-700 border border-gray-300",
  slot_selected:        "bg-blue-100 text-blue-800 border border-blue-300",
  pending_confirmation: "bg-amber-100 text-amber-800 border border-amber-300",
  test_mode_confirmed:  "bg-orange-100 text-orange-800 border border-orange-300",
  confirmed:            "bg-green-100 text-green-800 border border-green-300",
};

function LifecycleBadge({ lifecycle }: { lifecycle: BookingLifecycle }) {
  return (
    <span className={`text-xs font-semibold px-2 py-0.5 rounded ${LIFECYCLE_STYLES[lifecycle]}`}>
      {lifecycle}
    </span>
  );
}

// ─── Shared row ────────────────────────────────────────────────────────────────

function StateRow({
  label,
  value,
  highlight,
}: {
  label: string;
  value: string | null | undefined;
  highlight?: boolean;
}) {
  return (
    <div className="flex gap-2">
      <span className="text-xs text-gray-400 w-36 shrink-0 pt-0.5">{label}</span>
      <span className={`text-xs ${value ? highlight ? "text-violet-700 font-semibold" : "text-gray-800" : "text-gray-300 italic"}`}>
        {value ?? "—"}
      </span>
    </div>
  );
}

// ─── Validated row: green=confirmed, red=not_confirmed ─────────────────────────

function ValidatedRow({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div className="flex gap-2">
      <span className="text-xs text-gray-500 w-28 shrink-0 pt-0.5">{label}</span>
      {value ? (
        <span className="text-xs text-emerald-700 font-semibold">{value}</span>
      ) : (
        <span className="text-xs text-rose-500 italic">not_confirmed</span>
      )}
    </div>
  );
}

// ─── Booking lifecycle panel ───────────────────────────────────────────────────

function BookingLifecyclePanel({ state }: { state: ConversationState }) {
  const isTerminal =
    state.bookingLifecycle === "test_mode_confirmed" ||
    state.bookingLifecycle === "confirmed";

  return (
    <div
      className={`rounded-lg p-4 space-y-2 border-2 ${
        isTerminal
          ? "border-orange-300 bg-orange-50"
          : state.bookingLifecycle === "pending_confirmation"
          ? "border-amber-300 bg-amber-50"
          : "border-gray-200 bg-white"
      }`}
    >
      <div className="flex items-center justify-between mb-2">
        <p className="text-xs font-semibold text-gray-500 uppercase">Booking Lifecycle</p>
        <LifecycleBadge lifecycle={state.bookingLifecycle} />
      </div>

      <div className="flex gap-2">
        <span className="text-xs text-gray-400 w-36 shrink-0 pt-0.5">pendingConfirmation</span>
        <span
          className={`text-xs font-semibold ${
            state.pendingConfirmation
              ? "text-amber-700 bg-amber-50 px-1.5 rounded"
              : "text-gray-300 italic"
          }`}
        >
          {state.pendingConfirmation ? "YES — awaiting כן / yes" : "no"}
        </span>
      </div>

      <StateRow
        label="nextRequiredField"
        value={state.nextRequiredField ?? "none"}
        highlight={!!state.nextRequiredField}
      />

      <div className="flex gap-2">
        <span className="text-xs text-gray-400 w-36 shrink-0 pt-0.5">appointmentCreated</span>
        <span
          className={`text-xs font-semibold ${
            state.appointmentCreated ? "text-green-700" : "text-gray-400"
          }`}
        >
          {state.appointmentCreated ? "✓ YES — real booking" : "no"}
        </span>
      </div>

      <StateRow label="realAppointmentId" value={state.appointmentId ?? null} />
    </div>
  );
}

// ─── Validated booking state panel ────────────────────────────────────────────
// Shows only server-validated state. Green = confirmed. Red = not_confirmed.
// This is the authoritative source — not raw LLM guesses.

function ValidatedBookingStatePanel({ state }: { state: ConversationState }) {
  return (
    <div className="bg-white border border-gray-200 rounded-lg p-4 space-y-2">
      <div className="flex items-center gap-2 mb-1">
        <p className="text-xs font-semibold text-gray-500 uppercase">Validated Booking State</p>
        <span className="text-xs bg-emerald-50 text-emerald-600 border border-emerald-200 px-1.5 py-0.5 rounded">
          server-authoritative
        </span>
      </div>
      <p className="text-xs text-gray-400 mb-2">
        Overrides raw LLM output. Green = confirmed in state. Red = not_confirmed.
      </p>

      <ValidatedRow label="service" value={state.selectedService} />
      <ValidatedRow label="date" value={state.datePreference} />
      <ValidatedRow label="selectedSlot" value={state.selectedSlot} />
      <ValidatedRow label="customerName" value={state.customerName} />
      <ValidatedRow label="customerPhone" value={state.customerPhone} />

      <div className="pt-2 border-t border-gray-100 space-y-1">
        <ValidatedRow label="nextRequired" value={state.nextRequiredField} />

        <div className="flex gap-2">
          <span className="text-xs text-gray-500 w-28 shrink-0 pt-0.5">appointmentCreated</span>
          <span
            className={`text-xs font-semibold ${
              state.appointmentCreated ? "text-emerald-700" : "text-gray-400"
            }`}
          >
            {state.appointmentCreated ? "true" : "false"}
          </span>
        </div>

        <div className="flex gap-2">
          <span className="text-xs text-gray-500 w-28 shrink-0 pt-0.5">realAppointmentId</span>
          {state.appointmentId ? (
            <span className="text-xs text-emerald-700 font-mono">{state.appointmentId}</span>
          ) : (
            <span className="text-xs text-gray-400 italic">null</span>
          )}
        </div>

        {state.missingFields.length > 0 && (
          <div className="flex gap-2 pt-1">
            <span className="text-xs text-gray-500 w-28 shrink-0 pt-0.5">missingFields</span>
            <span className="text-xs text-rose-600">{state.missingFields.join(", ")}</span>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Raw session state panel ───────────────────────────────────────────────────
// Secondary fields not covered above (intent, time pref, offered slots).

function RawSessionPanel({ state }: { state: ConversationState }) {
  return (
    <div className="bg-white border border-gray-200 rounded-lg p-4 space-y-2">
      <p className="text-xs font-semibold text-gray-500 uppercase mb-3">Session state</p>
      <StateRow label="Session ID" value={state.sessionId} />
      <StateRow label="Intent" value={state.currentIntent} highlight={!!state.currentIntent} />
      <StateRow label="Time preference" value={state.selectedTimePreference} />
      <StateRow
        label="Offered slots"
        value={state.offeredSlots.length > 0 ? state.offeredSlots.join(", ") : null}
        highlight={state.offeredSlots.length > 0}
      />
    </div>
  );
}

// ─── Message history panel ─────────────────────────────────────────────────────

function MessageHistoryPanel({ history }: { history: MessageTurn[] }) {
  if (history.length === 0) return null;

  return (
    <div className="bg-white border border-gray-200 rounded-lg p-4">
      <p className="text-xs font-semibold text-gray-500 uppercase mb-3">
        Message history ({Math.ceil(history.length / 2)} turns)
      </p>
      <div className="space-y-2 max-h-72 overflow-y-auto">
        {history.map((turn, i) => (
          <div
            key={i}
            className={`flex ${turn.role === "user" ? "justify-end" : "justify-start"}`}
          >
            <div
              className={`max-w-[85%] rounded-lg px-3 py-2 text-xs leading-relaxed whitespace-pre-line ${
                turn.role === "user"
                  ? "bg-gray-900 text-white"
                  : "bg-violet-50 text-violet-900 border border-violet-100"
              }`}
            >
              {turn.text}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Combined panel ────────────────────────────────────────────────────────────

export default function ConversationPanel({
  state,
  history,
  onReset,
}: {
  state: ConversationState;
  history: MessageTurn[];
  onReset: () => void;
}) {
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold text-gray-500 uppercase">Conversation</p>
        <button
          type="button"
          onClick={onReset}
          title="Clears conversation history, session state, and all debug data"
          className="text-xs bg-red-50 text-red-600 hover:bg-red-100 hover:text-red-800 font-semibold transition-colors px-3 py-1 rounded border border-red-200 hover:border-red-300"
        >
          ↺ Reset session
        </button>
      </div>

      <MessageHistoryPanel history={history} />
      <BookingLifecyclePanel state={state} />
      <ValidatedBookingStatePanel state={state} />
      <RawSessionPanel state={state} />
    </div>
  );
}
