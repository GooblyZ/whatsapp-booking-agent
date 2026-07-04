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
        <h1 style={{ margin: 0 }}>מעבדת AI — תצוגת הבנה וסגנון</h1>
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

      <p style={{ color: "#666", marginTop: "4px", marginBottom: "12px", fontSize: "14px" }}>
        עמוד בדיקה בטוח — מריץ את מוח ה-AI עם הפרומפט האמיתי של מצב הפלטפורמה,{" "}
        <strong>ללא שמירה לבסיס הנתונים, ללא קביעת תורים, וללא ספירת שימוש</strong>.
        זו תצוגת הבנה וסגנון — לא סימולציה מלאה של שיחת וואטסאפ.
      </p>

      {/* HONESTY PANEL (post-v1 audit Slice 1b): exactly what a run here proves — and what it
          deliberately does NOT. Mirrors the AI-Settings scope-panel pattern. */}
      <aside
        aria-label="מה הבדיקה בודקת"
        style={{
          background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: "8px",
          padding: "12px 16px", marginBottom: "16px", maxWidth: "720px", fontSize: "13px", color: "#475569",
        }}
      >
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "12px" }}>
          <div style={{ background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: "8px", padding: "8px 12px" }}>
            <strong style={{ color: "#15803d", display: "block", marginBottom: "4px" }}>✓ מה זה בודק</strong>
            <ul style={{ margin: 0, paddingInlineStart: "18px", lineHeight: 1.6 }}>
              <li>מוח ה-AI האמיתי + פרומפט הפלטפורמה המלא</li>
              <li>הגדרות העוזר (אישיות, סגנון, שם, מין)</li>
              <li>עובדות העסק ובסיס הידע האמיתיים</li>
              <li>זיהוי כוונה, הבנה מובנית ועיגון עובדות</li>
            </ul>
          </div>
          <div style={{ background: "#fef2f2", border: "1px solid #fecaca", borderRadius: "8px", padding: "8px 12px" }}>
            <strong style={{ color: "#b91c1c", display: "block", marginBottom: "4px" }}>✗ מה זה לא בודק</strong>
            <ul style={{ margin: 0, paddingInlineStart: "18px", lineHeight: 1.6 }}>
              <li>זיכרון שיחה והיסטוריה (ריצה חד-פעמית, בלי לקוח)</li>
              <li>ניתוב וצירוף קישורי קביעה/ניהול</li>
              <li>מוני הודעות חריגות, מצב גיבוי ובריאות ספק</li>
              <li>מסנני היציאה (אימוג׳י/אורך/לשון) — התשובה כאן לפני המסננים</li>
              <li>עיצוב וואטסאפ והודעות אינטראקטיביות</li>
            </ul>
          </div>
        </div>
      </aside>

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
