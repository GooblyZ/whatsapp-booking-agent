"use client";

// app/dashboard/ai-assistant/PresetCards.tsx
// The style-package chooser (AI Settings v1): five preset cards + a first-class התאמה-אישית card.
// PURE PRESENTATION — selection is reported via callbacks; PersonaFields owns all state and the
// overwrite-confirm. A preset card is a PACKAGE: its "כולל" line shows the length+emoji defaults
// (server-resolved from the resolver's own PRESET_STYLE_DEFAULTS) that apply together with the text.

import type { PersonaPreset } from "@/lib/ai/persona-presets";
import { PRESET_CARD_META, type PreviewPresetId, type StyleDimsData } from "./voice-preview";

const LENGTH_HE: Record<string, string> = { short: "קצר", medium: "בינוני", long: "ארוך" };
const EMOJI_HE: Record<string, string> = { none: "ללא", low: "מועט", medium: "בינוני" };

const cardBase: React.CSSProperties = {
  display: "flex", flexDirection: "column", gap: "6px", textAlign: "start",
  borderRadius: "12px", cursor: "pointer",
};

function cardStyle(selected: boolean, disabled: boolean): React.CSSProperties {
  return {
    ...cardBase,
    // The 1px-vs-2px border delta is absorbed by padding so grid rows stay aligned.
    padding: selected ? "9px 11px" : "10px 12px",
    border: selected ? "2px solid #2563eb" : "1px solid #e2e8f0",
    background: selected ? "#eff6ff" : "#f8fafc",
    boxShadow: selected ? "0 2px 8px rgba(37,99,235,0.18)" : "0 1px 2px rgba(15,23,42,0.05)",
    cursor: disabled ? "default" : "pointer",
  };
}

function SelectedChip() {
  return (
    <span style={{
      fontSize: "11px", fontWeight: 700, color: "#fff", background: "#2563eb",
      borderRadius: "999px", padding: "2px 8px", whiteSpace: "nowrap",
    }}>
      ✓ נבחר
    </span>
  );
}

export interface PresetCardsProps {
  presets: PersonaPreset[];
  styleData: StyleDimsData;
  /** The currently-detected voice ("warm"…"concise" | "custom" | "default"). */
  activeId: PreviewPresetId;
  /** True when custom mode is explicitly active (owner opened the custom card). */
  customActive: boolean;
  /** AI-off: the whole chooser is disabled (values visible, not clickable). */
  disabled: boolean;
  onPreset: (preset: PersonaPreset) => void;
  onCustom: () => void;
}

export function PresetCards({ presets, styleData, activeId, customActive, disabled, onPreset, onCustom }: PresetCardsProps) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(170px, 1fr))", gap: "8px" }}>
      {presets.map((preset) => {
        const meta = PRESET_CARD_META[preset.id as keyof typeof PRESET_CARD_META];
        const dims = styleData.presets[preset.id];
        const selected = !customActive && activeId === preset.id;
        return (
          <button
            key={preset.id}
            type="button"
            disabled={disabled}
            onClick={() => onPreset(preset)}
            aria-pressed={selected}
            style={cardStyle(selected, disabled)}
          >
            <span style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "6px" }}>
              <span style={{ fontSize: "13px", fontWeight: 700, color: selected ? "#1d4ed8" : "#334155" }}>
                {preset.label}
              </span>
              {selected && <SelectedChip />}
            </span>
            {meta && (
              <>
                <span style={{ fontSize: "12px", color: "#64748b", lineHeight: 1.4 }}>{meta.description}</span>
                <span style={{
                  fontSize: "12px", color: "#475569", fontStyle: "italic", lineHeight: 1.4,
                  background: "#fff", border: "1px solid #e2e8f0", borderRadius: "8px", padding: "6px 8px",
                }}>
                  ”{meta.sample}“
                </span>
              </>
            )}
            {dims && (
              <span style={{ fontSize: "11px", color: "#94a3b8" }}>
                כולל: אורך {LENGTH_HE[dims.lengthDefault] ?? dims.lengthDefault} · אימוג׳י {EMOJI_HE[dims.emojiDefault] ?? dims.emojiDefault}
              </span>
            )}
          </button>
        );
      })}

      {/* CUSTOM MODE — a first-class choice, not a fallback: the owner describes the assistant in
          their own words (used as-is; the ✨ enhance offer lives next to the textarea). */}
      <button
        type="button"
        disabled={disabled}
        onClick={onCustom}
        aria-pressed={customActive}
        style={cardStyle(customActive, disabled)}
      >
        <span style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "6px" }}>
          <span style={{ fontSize: "13px", fontWeight: 700, color: customActive ? "#1d4ed8" : "#334155" }}>
            התאמה אישית
          </span>
          {customActive && <SelectedChip />}
        </span>
        <span style={{ fontSize: "12px", color: "#64748b", lineHeight: 1.4 }}>
          תיאור חופשי במילים שלך — איך העוזר מדבר ומתנהג.
        </span>
        <span style={{ fontSize: "11px", color: "#94a3b8" }}>אורך ואימוג׳י נקבעים בהגדרות המתקדמות.</span>
      </button>
    </div>
  );
}
