"use client";

// app/dashboard/ai-debug/AIDebugForm.tsx
// Client form for the developer AI test panel. Uses React 19 useActionState so
// the pasted message is sent via a server action (POST) and never appears in the URL.

import { useActionState } from "react";
import { runAIDebug, type AIDebugState } from "./actions";

const initial: AIDebugState = { ran: false };

const box: React.CSSProperties = {
  border: "1px solid #e0e0e0",
  borderRadius: "8px",
  padding: "14px 16px",
  background: "#fff",
};

const labelStyle: React.CSSProperties = { fontSize: "11px", color: "#888", marginBottom: "2px" };
const valStyle: React.CSSProperties = { fontSize: "14px", fontWeight: 600 };

const preStyle: React.CSSProperties = {
  margin: 0,
  fontSize: "12px",
  fontFamily: "ui-monospace, Menlo, Consolas, monospace",
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
  direction: "ltr",
  textAlign: "left",
  background: "#0d1117",
  color: "#c9d1d9",
  padding: "12px",
  borderRadius: "6px",
  maxHeight: "320px",
  overflow: "auto",
};

function Check({ ok, label }: { ok: boolean; label: string }) {
  return (
    <div style={{ fontSize: "13px", color: ok ? "#198754" : "#dc3545" }}>
      {ok ? "✓" : "✗"} {label}
    </div>
  );
}

export function AIDebugForm() {
  const [state, formAction, pending] = useActionState(runAIDebug, initial);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
      <form action={formAction} style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
        <textarea
          name="message"
          rows={3}
          required
          placeholder="הדבק/י הודעת לקוח לבדיקה, לדוגמה: מה שעות הפעילות? / אני רוצה תספורת מחר בערב"
          defaultValue={state.message ?? ""}
          style={{
            width: "100%",
            padding: "10px",
            borderRadius: "6px",
            border: "1px solid #ccc",
            fontSize: "14px",
            boxSizing: "border-box",
            resize: "vertical",
          }}
        />
        <button
          type="submit"
          disabled={pending}
          style={{
            alignSelf: "flex-start",
            padding: "10px 20px",
            background: "#0070f3",
            color: "#fff",
            border: "none",
            borderRadius: "6px",
            cursor: pending ? "default" : "pointer",
            fontSize: "14px",
            fontWeight: 600,
            opacity: pending ? 0.7 : 1,
          }}
        >
          {pending ? "בודק…" : "הרץ בדיקה"}
        </button>
      </form>

      {state.error && (
        <div
          style={{
            background: "#fdecea",
            border: "1px solid #f5c2c0",
            color: "#b71c1c",
            borderRadius: "6px",
            padding: "10px 14px",
            fontSize: "14px",
          }}
        >
          {state.error}
        </div>
      )}

      {state.ran && (
        <>
          {!state.geminiConfigured && (
            <div
              style={{
                background: "#fff3cd",
                border: "1px solid #ffc107",
                color: "#856404",
                borderRadius: "6px",
                padding: "10px 14px",
                fontSize: "13px",
              }}
            >
              ⚠️ <strong>GEMINI_API_KEY</strong> לא מוגדר — תשובות חופשיות מתקבלות מכללי הגיבוי
              הקבועים בלבד (הבוט עדיין תקין).
            </div>
          )}

          {/* Summary */}
          <div style={box}>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
                gap: "12px",
              }}
            >
              <div>
                <div style={labelStyle}>נקרא ל‑Gemini?</div>
                <div style={{ ...valStyle, color: state.geminiCalled ? "#198754" : "#6c757d" }}>
                  {state.geminiCalled ? "כן" : "לא"}
                  {state.skipReason ? ` (${state.skipReason})` : ""}
                </div>
              </div>
              <div>
                <div style={labelStyle}>Intent (metadata)</div>
                <div style={valStyle}>{state.intent ?? "—"}</div>
              </div>
              <div>
                <div style={labelStyle}>Response type</div>
                <div style={valStyle}>{state.responseType ?? "—"}</div>
              </div>
              <div>
                <div style={labelStyle}>Grounded?</div>
                <div style={{ ...valStyle, color: state.grounded === false ? "#dc3545" : state.grounded ? "#198754" : "#6c757d" }}>
                  {state.grounded == null ? "—" : state.grounded ? "כן" : "נכשל"}
                </div>
              </div>
              <div>
                <div style={labelStyle}>Reply source</div>
                <div style={{ ...valStyle, color: state.replySource === "gemini" ? "#198754" : "#6c757d" }}>
                  {state.replySource ?? "—"}
                </div>
              </div>
              <div>
                <div style={labelStyle}>קטגוריית זמינות</div>
                <div style={valStyle}>{state.evaluationCategory ?? "—"}</div>
              </div>
              <div>
                <div style={labelStyle}>Model</div>
                <div style={{ ...valStyle, direction: "ltr", textAlign: "right" }}>{state.model ?? "—"}</div>
              </div>
            </div>
          </div>

          {/* Reasoning & routing (debug) */}
          <div style={box}>
            <div style={{ ...labelStyle, marginBottom: "6px" }}>הסקה וניתוב (מפתחים)</div>
            <div style={{ display: "flex", flexDirection: "column", gap: "4px", fontSize: "13px" }}>
              <div>🎯 מטרת שיחה: <strong>{state.conversationGoal ?? "—"}</strong></div>
              <div>❓ מידע חסר (לפי Gemini): <strong>{state.missingInformation ?? "—"}</strong></div>
              <div>🧭 ענף נבחר (branch): <strong>{state.branch ?? "—"}</strong></div>
              {state.fallbackReason && <div>↩️ סיבת גיבוי: <strong>{state.fallbackReason}</strong></div>}
              {state.wantsToCancel && <div>🛑 הלקוח ביקש לעצור (cancel_request)</div>}
              <div>
                🆕 שדות שחולצו בתור זה: <strong>{state.newFields && state.newFields.length > 0 ? state.newFields.join(", ") : "—"}</strong>
                {state.missingFields && state.missingFields.length > 0 ? ` · עדיין חסר: ${state.missingFields.join(", ")}` : ""}
              </div>
              <div>
                🗓️ זמינות: <strong>{state.availabilityPreview ?? "—"}</strong>
              </div>
              {state.extractedFields && (
                <details>
                  <summary style={{ cursor: "pointer", fontSize: "12px", color: "#666" }}>booking_context לאחר התור (תצוגה)</summary>
                  <pre style={{ ...preStyle, marginTop: "6px", maxHeight: "160px" }}>{state.extractedFields}</pre>
                </details>
              )}
            </div>
          </div>

          {/* AI Settings applied (authoritative behavior layer) */}
          {state.appliedSettings && (
            <div style={box}>
              <div style={{ ...labelStyle, marginBottom: "6px" }}>הגדרות AI שהוחלו (שכבת ההתנהגות הסמכותית)</div>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
                  gap: "8px",
                  fontSize: "13px",
                }}
              >
                <div>שם: <strong>{state.appliedSettings.assistantName}</strong></div>
                <div>שפה: <strong>{state.appliedSettings.language}</strong></div>
                <div>מין הדמות: <strong>{state.appliedSettings.gender}</strong></div>
                <div>אורך: <strong>{state.appliedSettings.responseLength}</strong></div>
                <div>אמוג&#39;י: <strong>{state.appliedSettings.emojiUsage}</strong></div>
                <div>הוראות מיוחדות: <strong>{state.appliedSettings.hasCustomInstructions ? "כן" : "לא"}</strong></div>
                <div>AI פעיל: <strong>{state.appliedSettings.aiEnabled ? "כן" : "לא"}</strong></div>
                <div>FAQ: <strong>{state.appliedSettings.faqEnabled ? "כן" : "לא"}</strong></div>
                <div>זיהוי כוונת תור: <strong>{state.appliedSettings.intentDetectionEnabled ? "כן" : "לא"}</strong></div>
              </div>
              {state.memoryNote && (
                <div style={{ fontSize: "12px", color: "#888", marginTop: "8px", lineHeight: 1.5 }}>
                  🧠 {state.memoryNote}
                </div>
              )}
            </div>
          )}

          {/* Final customer-facing reply */}
          <div style={box}>
            <div style={{ ...labelStyle, marginBottom: "6px" }}>תשובה סופית ללקוח</div>
            <div
              style={{
                whiteSpace: "pre-wrap",
                fontSize: "14px",
                background: "#e7f7ed",
                border: "1px solid #b7e4c7",
                borderRadius: "8px",
                padding: "10px 14px",
              }}
            >
              {state.reply}
            </div>
          </div>

          {/* Grounding failure detail */}
          {state.grounded === false && state.groundingViolations && state.groundingViolations.length > 0 && (
            <div
              style={{
                background: "#fdecea",
                border: "1px solid #f5c2c0",
                color: "#b71c1c",
                borderRadius: "6px",
                padding: "10px 14px",
                fontSize: "13px",
              }}
            >
              <strong>הארקה נכשלה (strict grounding)</strong> — התשובה של Gemini נחסמה והוחלפה בגיבוי בטוח:
              <ul style={{ margin: "6px 0 0", paddingInlineStart: "18px", direction: "ltr", textAlign: "left" }}>
                {state.groundingViolations.map((v, i) => <li key={i}>{v}</li>)}
              </ul>
            </div>
          )}

          {/* Structured understanding (internal metadata) */}
          <div style={box}>
            <div style={{ ...labelStyle, marginBottom: "6px" }}>understanding (מטא-דאטה פנימית — הלקוח לא רואה)</div>
            <pre style={preStyle}>{state.structured}</pre>
          </div>

          {/* Context audit (PART 7) */}
          {state.audit && (
            <div style={box}>
              <div style={{ ...labelStyle, marginBottom: "6px" }}>
                מה Gemini מקבל — ביקורת הקשר ({state.audit.activeKbCount} פריטי ידע, {state.audit.activeServiceCount} שירותים)
              </div>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
                  gap: "6px",
                }}
              >
                <Check ok={state.audit.aboutIncluded} label="אודות העסק" />
                <Check ok={state.audit.faqIncluded} label="שאלות נפוצות (FAQ)" />
                <Check ok={state.audit.pricingIncluded} label="תמחור" />
                <Check ok={state.audit.parkingIncluded} label="חניה והגעה" />
                <Check ok={state.audit.policyIncluded} label="מדיניות" />
                <Check ok={state.audit.contactIncluded} label="יצירת קשר" />
                <Check ok={state.audit.servicesIncluded} label="שירותים" />
                <Check ok={state.audit.hoursIncluded} label="שעות פעילות" />
              </div>
            </div>
          )}

          {/* Raw facts / system prompt (collapsible) */}
          {state.factsPreview && (
            <details style={box}>
              <summary style={{ cursor: "pointer", fontSize: "13px", fontWeight: 600 }}>
                בלוק העובדות שנשלח ל‑Gemini (ללא סודות)
              </summary>
              <pre style={{ ...preStyle, marginTop: "10px" }}>{state.factsPreview}</pre>
            </details>
          )}
          {state.systemPrompt && (
            <details style={box}>
              <summary style={{ cursor: "pointer", fontSize: "13px", fontWeight: 600 }}>
                הנחיית המערכת המלאה (system prompt)
              </summary>
              <pre style={{ ...preStyle, marginTop: "10px" }}>{state.systemPrompt}</pre>
            </details>
          )}
        </>
      )}
    </div>
  );
}
