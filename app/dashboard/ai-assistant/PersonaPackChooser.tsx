"use client";

// app/dashboard/ai-assistant/PersonaPackChooser.tsx
// Gate D — the PRIMARY persona chooser: two first-class RICH packs + Custom. Replaces the retired
// 5-lite-preset chooser (those seeded custom_instructions text and never felt like a strong persona).
// PURE PRESENTATION — selection is reported via onSelect; PersonaFields owns all state.
//
// AUTHORITY IS UNAMBIGUOUS (no blended state):
//   • a rich pack selected → the PACK defines voice / style / emoji (advanced style fields are hidden).
//   • Custom selected      → the advanced settings + free-text description define the voice.

import { PERSONA_PACKS, type PersonaSelection } from "@/lib/ai/persona-packs";

const cardBase: React.CSSProperties = {
  display: "flex", flexDirection: "column", gap: "6px", textAlign: "start", borderRadius: "12px",
};
function cardStyle(selected: boolean, disabled: boolean): React.CSSProperties {
  return {
    ...cardBase,
    // 1px↔2px border delta absorbed by padding so the grid row stays aligned.
    padding: selected ? "11px 13px" : "12px 14px",
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

interface Option { id: PersonaSelection; label: string; tagline: string; note: string }
const OPTIONS: Option[] = [
  { id: "warm_casual", label: PERSONA_PACKS.warm_casual.label, tagline: PERSONA_PACKS.warm_casual.tagline, note: "החבילה מגדירה את הטון, האימוג׳י והאורך." },
  { id: "professional_elegant", label: PERSONA_PACKS.professional_elegant.label, tagline: PERSONA_PACKS.professional_elegant.tagline, note: "החבילה מגדירה את הטון, האימוג׳י והאורך." },
  { id: "custom", label: "מותאם אישית", tagline: "מתארים את העוזר במילים שלכם — התיאור וההגדרות המתקדמות קובעים את הקול.", note: "אפשר גם להתחיל מערכה קיימת ולהתאים." },
];

export function PersonaPackChooser({
  value, disabled, onSelect,
}: {
  value: PersonaSelection;
  disabled: boolean;
  onSelect: (v: PersonaSelection) => void;
}) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: "8px" }}>
      {OPTIONS.map((o) => {
        const selected = value === o.id;
        return (
          <button
            key={o.id}
            type="button"
            disabled={disabled}
            onClick={() => onSelect(o.id)}
            aria-pressed={selected}
            style={cardStyle(selected, disabled)}
          >
            <span style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "6px" }}>
              <span style={{ fontSize: "14px", fontWeight: 700, color: selected ? "#1d4ed8" : "#334155" }}>{o.label}</span>
              {selected && <SelectedChip />}
            </span>
            <span style={{ fontSize: "12px", color: "#64748b", lineHeight: 1.45 }}>{o.tagline}</span>
            <span style={{ fontSize: "11px", color: "#94a3b8" }}>{o.note}</span>
          </button>
        );
      })}
    </div>
  );
}
