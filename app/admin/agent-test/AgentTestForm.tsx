"use client";

import { useActionState } from "react";
import { analyzeWhatsAppMessage, AnalyzeState } from "./actions";
import type { AgentAnalysisResult, AgentConfidence, AgentIntent, MissingField, ToolRunResult, ToolStatus } from "@/lib/agent";

const INTENT_COLORS: Record<AgentIntent, string> = {
  BOOK_APPOINTMENT:     "bg-green-100 text-green-800",
  CANCEL_APPOINTMENT:   "bg-red-100 text-red-800",
  RESCHEDULE_APPOINTMENT: "bg-orange-100 text-orange-800",
  ASK_SERVICES:         "bg-blue-100 text-blue-800",
  ASK_PRICES:           "bg-purple-100 text-purple-800",
  ASK_AVAILABILITY:     "bg-teal-100 text-teal-800",
  ASK_BUSINESS_HOURS:   "bg-indigo-100 text-indigo-800",
  HUMAN_HANDOFF:        "bg-yellow-100 text-yellow-800",
  UNKNOWN:              "bg-gray-100 text-gray-600",
};

const CONFIDENCE_COLORS: Record<AgentConfidence, string> = {
  HIGH:   "bg-green-50 text-green-700 border border-green-200",
  MEDIUM: "bg-yellow-50 text-yellow-700 border border-yellow-200",
  LOW:    "bg-red-50 text-red-700 border border-red-200",
};

const MISSING_LABELS: Record<MissingField, string> = {
  service:       "Service",
  date:          "Date",
  time:          "Time",
  customerName:  "Customer name",
  customerPhone: "Phone number",
};

function Field({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="flex gap-3">
      <span className="text-xs text-gray-400 w-40 shrink-0 pt-0.5">{label}</span>
      <span className={`text-sm ${value ? "text-gray-800" : "text-gray-300 italic"}`}>
        {value ?? "—"}
      </span>
    </div>
  );
}

function ResultPanel({ result }: { result: AgentAnalysisResult }) {
  return (
    <div className="mt-6 space-y-5">
      {/* Intent + confidence */}
      <div className="flex items-center gap-3 flex-wrap">
        <span className={`px-3 py-1 rounded-full text-sm font-semibold ${INTENT_COLORS[result.intent]}`}>
          {result.intent.replace(/_/g, " ")}
        </span>
        <span className={`px-2 py-0.5 rounded text-xs font-medium ${CONFIDENCE_COLORS[result.confidence]}`}>
          {result.confidence} confidence
        </span>
      </div>

      {/* Extracted entities */}
      <div className="bg-white border border-gray-200 rounded-lg p-4 space-y-2">
        <p className="text-xs font-semibold text-gray-500 uppercase mb-3">Extracted fields</p>
        <Field label="Service" value={result.extractedService} />
        <Field label="Date preference" value={result.extractedDate} />
        <Field label="Time preference" value={result.extractedTime} />
        <Field label="Customer name" value={result.extractedCustomerName} />
        <Field label="Exact time?" value={result.hasExactTime ? "Yes" : "No — preference only"} />
        <Field label="Needs availability check?" value={result.needsAvailabilityCheck ? "Yes" : "No"} />
      </div>

      {/* Missing fields */}
      {result.missingFields.length > 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-4">
          <p className="text-xs font-semibold text-amber-700 uppercase mb-2">Missing fields</p>
          <ul className="list-disc list-inside space-y-1">
            {result.missingFields.map((f) => (
              <li key={f} className="text-sm text-amber-800">{MISSING_LABELS[f]}</li>
            ))}
          </ul>
        </div>
      )}

      {/* Suggested tool */}
      <div className="bg-white border border-gray-200 rounded-lg p-4">
        <p className="text-xs font-semibold text-gray-500 uppercase mb-3">Suggested tool call</p>
        <p className="text-sm font-mono font-bold text-gray-900">{result.suggestedToolCall.tool}()</p>
        <p className="text-sm text-gray-500 mt-1">{result.suggestedToolCall.reason}</p>
      </div>

      {/* Draft response */}
      <div className="bg-gray-900 rounded-lg p-4">
        <p className="text-xs font-semibold text-gray-400 uppercase mb-2">Draft customer response</p>
        <p className="text-sm text-white leading-relaxed">{result.draftResponse}</p>
      </div>

      {/* Notes / safety flags */}
      {result.notes && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4">
          <p className="text-xs font-semibold text-red-600 uppercase mb-1">Safety note</p>
          <p className="text-sm text-red-800">{result.notes}</p>
        </div>
      )}
    </div>
  );
}

const TOOL_STATUS_STYLES: Record<ToolStatus, string> = {
  executed: "bg-green-100 text-green-800",
  skipped:  "bg-yellow-100 text-yellow-800",
  forbidden: "bg-red-100 text-red-800",
};

function ToolRunPanel({ toolRun }: { toolRun: ToolRunResult }) {
  return (
    <div className="mt-8 space-y-4">
      <div className="flex items-center gap-3">
        <h3 className="text-sm font-semibold text-gray-700 uppercase tracking-wide">Tool Execution</h3>
        <span className={`px-2 py-0.5 rounded text-xs font-semibold ${TOOL_STATUS_STYLES[toolRun.status]}`}>
          {toolRun.status.toUpperCase()}
        </span>
      </div>

      <div className="bg-white border border-gray-200 rounded-lg p-4 space-y-3">
        <div className="flex gap-3">
          <span className="text-xs text-gray-400 w-32 shrink-0">Tool called</span>
          <span className="text-sm font-mono font-bold text-gray-900">{toolRun.actualToolName}()</span>
        </div>
        {Object.keys(toolRun.args).length > 0 && (
          <div className="flex gap-3">
            <span className="text-xs text-gray-400 w-32 shrink-0">Args</span>
            <pre className="text-xs text-gray-700 bg-gray-50 rounded p-2 overflow-x-auto flex-1">
              {JSON.stringify(toolRun.args, null, 2)}
            </pre>
          </div>
        )}
        {toolRun.skippedReason && (
          <div className="flex gap-3">
            <span className="text-xs text-gray-400 w-32 shrink-0">Reason</span>
            <span className="text-sm text-yellow-700">{toolRun.skippedReason}</span>
          </div>
        )}
      </div>

      {toolRun.result !== null && (
        <div className="bg-white border border-gray-200 rounded-lg p-4">
          <p className="text-xs font-semibold text-gray-500 uppercase mb-2">Tool result</p>
          <pre className="text-xs text-gray-700 bg-gray-50 rounded p-3 overflow-x-auto max-h-64">
            {JSON.stringify(toolRun.result, null, 2)}
          </pre>
        </div>
      )}

      <div className="bg-gray-900 rounded-lg p-4">
        <p className="text-xs font-semibold text-gray-400 uppercase mb-2">Final draft response</p>
        <p className="text-sm text-white leading-relaxed whitespace-pre-line">{toolRun.enrichedDraft}</p>
      </div>
    </div>
  );
}

const EXAMPLES = [
  "Hi, I want to book a haircut tomorrow evening",
  "Can I get haircut and beard next Friday after 4?",
  "How much is a beard trim?",
  "What services do you offer?",
  "Cancel my appointment",
  "Move my appointment to next week",
  "What's the weather today?",
  "אני רוצה תספורת מחר בערב",
  "אפשר לקבוע תספורת וזקן ביום שישי אחרי 4?",
  "כמה עולה זקן?",
  "מה שעות הפעילות?",
  "לבטל תור",
];

export default function AgentTestForm() {
  const [state, formAction, pending] = useActionState<AnalyzeState, FormData>(
    analyzeWhatsAppMessage,
    null
  );

  return (
    <div className="max-w-2xl">
      <form action={formAction} className="space-y-4">
        <div>
          <label htmlFor="message" className="block text-sm font-medium text-gray-700 mb-1">
            Simulated customer message
          </label>
          <textarea
            id="message"
            name="message"
            rows={3}
            required
            placeholder="e.g. Hi, I want to book a haircut tomorrow evening"
            className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gray-400 resize-none"
          />
        </div>

        <div>
          <label htmlFor="phone" className="block text-sm font-medium text-gray-700 mb-1">
            Simulated customer phone <span className="text-gray-400 font-normal">(optional)</span>
          </label>
          <input
            id="phone"
            name="phone"
            type="text"
            placeholder="9725XXXXXXXX"
            className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gray-400"
          />
        </div>

        <button
          type="submit"
          disabled={pending}
          className="w-full bg-gray-900 text-white text-sm font-medium px-4 py-2 rounded-md hover:bg-gray-700 disabled:opacity-50 transition-colors"
        >
          {pending ? "Analyzing…" : "Analyze message"}
        </button>
      </form>

      {/* Quick examples */}
      <div className="mt-5">
        <p className="text-xs text-gray-400 mb-2 uppercase font-semibold">Quick examples</p>
        <div className="flex flex-wrap gap-2">
          {EXAMPLES.map((ex) => (
            <button
              key={ex}
              type="button"
              onClick={() => {
                const el = document.getElementById("message") as HTMLTextAreaElement | null;
                if (el) el.value = ex;
              }}
              className="text-xs bg-gray-100 hover:bg-gray-200 text-gray-700 px-2 py-1 rounded transition-colors"
            >
              {ex.length > 40 ? ex.slice(0, 40) + "…" : ex}
            </button>
          ))}
        </div>
      </div>

      {/* Error */}
      {"error" in (state ?? {}) && (
        <div className="mt-4 p-3 bg-red-50 border border-red-200 rounded-md text-sm text-red-800">
          {(state as { error: string }).error}
        </div>
      )}

      {/* Analysis + tool execution */}
      {state && "result" in state && (
        <>
          <ResultPanel result={state.result} />
          {state.toolRun && <ToolRunPanel toolRun={state.toolRun} />}
        </>
      )}
    </div>
  );
}
