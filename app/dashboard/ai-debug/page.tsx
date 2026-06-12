export const dynamic = "force-dynamic";

// app/dashboard/ai-debug/page.tsx
// Developer-only AI test panel (behind the password-protected dashboard).
// Paste a message → see whether Gemini was called, the detected intent,
// confidence, the structured output, and the exact reply that would be sent.
// No DB writes, no logging, no appointment creation.

import { isGeminiConfigured, getGeminiModel } from "@/lib/ai/gemini";
import { AIDebugForm } from "./AIDebugForm";

export default function AIDebugPage() {
  const configured = isGeminiConfigured();
  const model = getGeminiModel();

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "4px" }}>
        <h1 style={{ margin: 0 }}>בדיקת AI</h1>
        <span
          style={{
            fontSize: "11px",
            background: "#ede9fe",
            color: "#6d28d9",
            padding: "2px 8px",
            borderRadius: "4px",
            fontWeight: 600,
          }}
        >
          מפתחים
        </span>
      </div>

      <p style={{ color: "#666", marginTop: "4px", marginBottom: "16px", fontSize: "14px" }}>
        עמוד בדיקה בטוח — מריץ את שכבת ה‑AI בדיוק כמו בשיחה אמיתית, אך{" "}
        <strong>ללא שמירה לבסיס הנתונים, ללא קביעת תורים, וללא ספירת שימוש</strong>.
      </p>

      <div
        style={{
          display: "flex",
          gap: "16px",
          flexWrap: "wrap",
          fontSize: "13px",
          color: "#444",
          marginBottom: "20px",
        }}
      >
        <span>
          סטטוס מפתח Gemini:{" "}
          <strong style={{ color: configured ? "#198754" : "#dc3545" }}>
            {configured ? "מוגדר ✓" : "לא מוגדר"}
          </strong>
        </span>
        <span style={{ direction: "ltr" }}>
          model: <strong>{model}</strong>
        </span>
      </div>

      <AIDebugForm />
    </div>
  );
}
