"use client";

// app/dashboard/ai-assistant/StylePanel.tsx
// "הסגנון שנבחר — במבט אחד": style-dimension bars + the static voice SAMPLE. PURE PRESENTATION —
// receives the server-resolved dimension data as plain JSON (resolveStyleProfile is server-only; it
// imports node crypto) and composes the sample via the pure client-safe helper. No network, no
// Gemini, nothing persisted; updates live as the owner switches preset/length/emoji before saving.
//
// UI v2 corrective: the preview is framed as a MOCK ("דוגמת סגנון" pill + dashed surface + honest
// caption) so it never reads as a real sent message or a guarantee of exact live output.

import type { AISettingsEmojiUsage, AISettingsResponseLength } from "@/types/database";
import { buildVoicePreview, type PreviewPresetId, type StyleDimsData } from "./voice-preview";

const REGISTER_HE: Record<string, string> = {
  refined: "מוקפד",
  formal: "רשמי",
  plain: "רגיל",
  casual: "קליל",
};

const dimLabel: React.CSSProperties = { fontSize: "12px", color: "#475569", width: "64px", flexShrink: 0 };
const segmentRow: React.CSSProperties = { display: "flex", gap: "3px", flex: 1 };
const valueChip: React.CSSProperties = { fontSize: "11px", color: "#64748b", width: "28px", flexShrink: 0, textAlign: "center" };

/** One 1–5 dimension as five segments + an n/5 value chip. Plain divs, no animation. */
function DimensionBar({ label, value }: { label: string; value: number }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
      <span style={dimLabel}>{label}</span>
      <div style={segmentRow} role="img" aria-label={`${label}: ${value} מתוך 5`}>
        {[1, 2, 3, 4, 5].map((i) => (
          <div
            key={i}
            style={{
              flex: 1, height: "10px", borderRadius: "5px",
              background: i <= value ? "#2563eb" : "#e2e8f0",
            }}
          />
        ))}
      </div>
      <span style={valueChip}>{value}/5</span>
    </div>
  );
}

export interface StylePanelProps {
  activePresetId: PreviewPresetId;
  /** Custom mode HONESTY: precise bars render ONLY for a resolver-recognized preset. In custom
   *  mode the vector is not derived from the owner's text, so bars would be false precision —
   *  an explanatory state renders instead, and the sample is forced to the generic bank. */
  customActive: boolean;
  styleData: StyleDimsData;
  emojiUsage: AISettingsEmojiUsage;
  responseLength: AISettingsResponseLength;
  language: string;
}

export function StylePanel({ activePresetId, customActive, styleData, emojiUsage, responseLength, language }: StylePanelProps) {
  const dims = styleData.presets[activePresetId] ?? styleData.neutral;
  const brevity = styleData.brevityByLength[responseLength] ?? 3;
  const preview = buildVoicePreview({ presetId: customActive ? "custom" : activePresetId, emojiUsage, responseLength });

  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: "18px" }}>
      {/* Dimensions — shown ONLY when truly resolver-derived (a recognized preset); custom text
          gets an honest explanation instead of generic bars dressed up as analysis. */}
      <div style={{ display: "flex", flexDirection: "column", gap: "9px" }}>
        <span style={{ fontSize: "13px", fontWeight: 700, color: "#334155" }}>מאפייני הסגנון</span>
        {customActive ? (
          <div style={{
            background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: "10px",
            padding: "12px 14px", fontSize: "13px", color: "#475569", lineHeight: 1.6,
          }}>
            הסגנון נקבע לפי הטקסט שכתבת. מאפייני סגנון מדויקים (רשמיות, חום, אנרגיה) זמינים בסגנונות המוכנים.
          </div>
        ) : (
          <>
            <DimensionBar label="רשמיות" value={dims.formality} />
            <DimensionBar label="חום" value={dims.warmth} />
            <DimensionBar label="אנרגיה" value={dims.energy} />
            <DimensionBar label="תמציתיות" value={brevity} />
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <span style={dimLabel}>משלב</span>
              <span style={{
                fontSize: "12px", fontWeight: 600, color: "#334155", background: "#f1f5f9",
                border: "1px solid #e2e8f0", borderRadius: "999px", padding: "2px 12px",
              }}>
                {REGISTER_HE[dims.register] ?? dims.register}
              </span>
            </div>
          </>
        )}
      </div>

      {/* Static SAMPLE — deliberately framed as a mock (pill + dashed surface + honest caption):
          never a real message, never a Gemini call, never a promise of exact live wording. */}
      <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
        <span style={{ alignSelf: "flex-start", fontSize: "11px", fontWeight: 700, color: "#475569",
          background: "#f1f5f9", border: "1px solid #e2e8f0", borderRadius: "999px", padding: "2px 10px" }}>
          דוגמת סגנון
        </span>
        <div style={{
          background: "#e5ddd5", border: "1px dashed #b8ad9d", borderRadius: "12px", padding: "14px",
        }}>
          <div style={{
            background: "#dcf8c6", border: "1px solid #c8e6b0", borderRadius: "12px 12px 12px 2px",
            padding: "10px 14px", fontSize: "15px", lineHeight: 1.6, color: "#1f2937",
            maxWidth: "420px", boxShadow: "0 1px 1px rgba(0,0,0,0.12)",
          }}>
            {preview}
          </div>
        </div>
        <span style={{ fontSize: "12px", color: "#94a3b8", lineHeight: 1.5 }}>
          דוגמה סטטית להמחשת הסגנון בלבד — לא נוצרה על ידי ה-AI, אינה מבוססת על נתוני העסק שלך, ואינה מבטיחה נוסח מדויק בשיחה אמיתית.
          {customActive && " בהתאמה אישית הדוגמה כללית וממחישה אורך ואימוג׳י בלבד — הסגנון בפועל נקבע לפי הטקסט שכתבת."}
          {language !== "he" && " הדוגמה מוצגת בעברית."}
        </span>
      </div>
    </div>
  );
}
