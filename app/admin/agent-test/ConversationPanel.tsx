"use client";

import type { ConversationState, MessageTurn } from "@/lib/agent";

// ─── State row ─────────────────────────────────────────────────────────────────

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
      <span
        className={`text-xs ${
          value
            ? highlight
              ? "text-violet-700 font-semibold"
              : "text-gray-800"
            : "text-gray-300 italic"
        }`}
      >
        {value ?? "—"}
      </span>
    </div>
  );
}

// ─── Conversation state panel ──────────────────────────────────────────────────

function ConversationStatePanel({ state }: { state: ConversationState }) {
  return (
    <div className="bg-white border border-gray-200 rounded-lg p-4 space-y-2">
      <p className="text-xs font-semibold text-gray-500 uppercase mb-3">Session state</p>
      <StateRow label="Session ID" value={state.sessionId} />
      <StateRow label="Intent" value={state.currentIntent} highlight={!!state.currentIntent} />
      <StateRow label="Service" value={state.selectedService} highlight={!!state.selectedService} />
      <StateRow label="Date" value={state.datePreference} highlight={!!state.datePreference} />
      <StateRow label="Time preference" value={state.selectedTimePreference} />
      <StateRow
        label="Offered slots"
        value={state.offeredSlots.length > 0 ? state.offeredSlots.join(", ") : null}
        highlight={state.offeredSlots.length > 0}
      />
      <StateRow label="Selected slot" value={state.selectedSlot} highlight={!!state.selectedSlot} />
      <StateRow label="Customer name" value={state.customerName} highlight={!!state.customerName} />
      <StateRow label="Customer phone" value={state.customerPhone} />

      {state.missingFields.length > 0 && (
        <div className="mt-2 pt-2 border-t border-gray-100">
          <p className="text-xs text-amber-600 font-semibold mb-1">Missing fields</p>
          <p className="text-xs text-amber-700">{state.missingFields.join(", ")}</p>
        </div>
      )}

      <div className="mt-2 pt-2 border-t border-gray-100 space-y-1">
        <StateRow
          label="Next required"
          value={state.nextRequiredField ?? "none"}
          highlight={!!state.nextRequiredField}
        />
        <div className="flex gap-2">
          <span className="text-xs text-gray-400 w-36 shrink-0 pt-0.5">Pending confirm</span>
          <span
            className={`text-xs font-semibold ${
              state.pendingConfirmation
                ? "text-green-700 bg-green-50 px-1.5 rounded"
                : "text-gray-300 italic"
            }`}
          >
            {state.pendingConfirmation ? "YES — awaiting כן / yes" : "no"}
          </span>
        </div>
      </div>
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
          className="text-xs text-gray-400 hover:text-red-600 transition-colors px-2 py-0.5 rounded border border-gray-200 hover:border-red-200"
        >
          New session
        </button>
      </div>
      <MessageHistoryPanel history={history} />
      <ConversationStatePanel state={state} />
    </div>
  );
}
