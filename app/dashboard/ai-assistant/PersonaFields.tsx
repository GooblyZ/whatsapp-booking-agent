"use client";

// app/dashboard/ai-assistant/PersonaFields.tsx
// "Define your receptionist" — a deliberately small form. Five plain sections that
// map to how an owner thinks, NOT to the AI architecture:
//
//   מה ה-AI עושה   (capabilities)  — operational on/off switches
//   מי הוא          (identity)      — name + gender
//   האישיות         (personality)   — ONE natural-language description (the voice)
//   סגנון כתיבה     (writing style) — length / emoji / language (format, not personality)
//   הנחיות נוספות   (style guidance) — soft wording/topics to avoid (never overrides the system)
//
// No tone presets, no business-type field, no prompt jargon. The personality is a
// single field the owner writes in their own words; the optional ✨ button asks the
// AI to polish that description (owner reviews/edits before saving).

import { useState, useTransition } from "react";
import type { AISettings } from "@/types/database";
import { PERSONA_PRESETS } from "@/lib/ai/persona-presets";
import { flagsBusinessPolicy } from "./policy-lint";
import { enhancePersonaAction } from "./actions";

type Gender = "neutral" | "female" | "male";

const LANGUAGES = [
  { code: "he", label: "עברית" },
  { code: "en", label: "English" },
  { code: "ar", label: "العربية" },
  { code: "ru", label: "Русский" },
  { code: "es", label: "Español" },
  { code: "fr", label: "Français" },
] as const;

const inputStyle: React.CSSProperties = {
  width: "100%", padding: "8px", borderRadius: "4px", border: "1px solid #ccc",
  boxSizing: "border-box", fontSize: "14px",
};
const fieldWrap: React.CSSProperties = { display: "flex", flexDirection: "column", gap: "4px" };
const fieldLabel: React.CSSProperties = { fontWeight: 500, fontSize: "14px" };
const hint: React.CSSProperties = { fontSize: "12px", color: "#888", lineHeight: "1.4" };
const fieldset: React.CSSProperties = {
  border: "1px solid #e0e0e0", borderRadius: "8px", padding: "14px 16px", margin: 0,
  display: "flex", flexDirection: "column", gap: "12px",
};
const legend: React.CSSProperties = { fontWeight: 600, fontSize: "14px", padding: "0 6px" };

export function PersonaFields({ initial }: { initial: AISettings | null }) {
  const [personality, setPersonality] = useState(
    // Back-compat: show a legacy persona_voice value if custom_instructions is empty.
    initial?.custom_instructions ?? initial?.persona_voice ?? ""
  );
  const [enhanceMsg, setEnhanceMsg] = useState<string | null>(null);
  const [enhanceOk, setEnhanceOk] = useState(false);
  const [pending, startTransition] = useTransition();
  // Controlled so the policy-lint advisory can run live. Initial value = the saved text
  // verbatim (Phase A0 never edits or remaps existing settings).
  const [avoid, setAvoid] = useState(initial?.things_to_avoid ?? "");
  // Advisory (non-blocking): does the free-text read like a business RULE/FACT rather than style?
  const personalityPolicyHits = flagsBusinessPolicy(personality);
  const avoidPolicyHits = flagsBusinessPolicy(avoid);

  // Seed the personality textarea from a preset. OVERWRITE SAFETY: an empty box fills
  // directly; a box that already has text is never silently replaced — the owner must
  // confirm a deliberate replace first (clear Hebrew copy). Presets are a starting point,
  // not a lock: the seeded text is fully editable before saving.
  function applyPreset(text: string) {
    const hasText = personality.trim().length > 0;
    if (hasText && !window.confirm("יש כבר תיאור אישיות. להחליף אותו בתבנית שנבחרה?")) return;
    setPersonality(text);
    setEnhanceMsg(null);
    setEnhanceOk(false);
  }

  function handleEnhance() {
    setEnhanceMsg(null);
    setEnhanceOk(false);
    startTransition(async () => {
      const res = await enhancePersonaAction(personality);
      if (res.status === "done") {
        setPersonality(res.text);
        setEnhanceOk(true);
        setEnhanceMsg("הצענו ניסוח משופר — אפשר לערוך אותו ואז לשמור.");
      } else if (res.status === "error") {
        setEnhanceMsg(res.message);
      }
    });
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "18px" }}>
      {/* CAPABILITIES */}
      <fieldset style={fieldset}>
        <legend style={legend}>מה ה-AI עושה</legend>
        <Toggle
          name="ai_enabled" defaultChecked={initial?.ai_enabled !== false}
          title="AI פעיל"
          desc="כשמכובה — הבוט עדיין מקבל תורים, אך לא עונה על שאלות חופשיות."
        />
        <Toggle
          name="faq_enabled" defaultChecked={initial?.faq_enabled !== false}
          title="מענה לשאלות (FAQ)"
          desc="מענה אוטומטי לשאלות על שעות, מחירים, מיקום ועוד — מבוסס בסיס הידע."
        />
        <Toggle
          name="intent_detection_enabled" defaultChecked={initial?.intent_detection_enabled !== false}
          title="זיהוי כוונת קביעת תור"
          desc="זיהוי משפטים כמו &quot;אני רוצה לקבוע תור למחר&quot; והצעה לפתוח תהליך קביעת תור."
        />
      </fieldset>

      {/* IDENTITY */}
      <fieldset style={fieldset}>
        <legend style={legend}>מי הוא</legend>
        <label style={fieldWrap}>
          <span style={fieldLabel}>שם העוזר</span>
          <input
            name="assistant_name" defaultValue={initial?.assistant_name ?? "עוזר"} style={inputStyle}
          />
          <span style={hint}>השם שהבוט משתמש בו כשהוא מציג את עצמו.</span>
        </label>
        <label style={fieldWrap}>
          <span style={fieldLabel}>מין הדמות</span>
          <select
            name="assistant_gender"
            defaultValue={(initial?.assistant_gender as Gender) ?? "neutral"}
            style={inputStyle}
          >
            <option value="neutral">ניטרלי</option>
            <option value="female">נקבה</option>
            <option value="male">זכר</option>
          </select>
          <span style={hint}>
            איך הבוט מתייחס לעצמו בעברית (&quot;אני שמחה&quot; מול &quot;אני שמח&quot;). אל הלקוח/ה הוא תמיד פונה בלשון מתאימה.
          </span>
        </label>
      </fieldset>

      {/* PERSONALITY — the single voice authority. */}
      <fieldset style={fieldset}>
        <legend style={legend}>האישיות</legend>
        <p style={{ ...hint, margin: 0 }}>
          תאר/י את הקבלן/ית כמו שהיית מתאר/ת עובד/ת אמיתי/ת. במשפט-שניים — איך מדבר/ת, איך מתייחס/ת ללקוחות, מה האופי.
        </p>
        {/* PRESET CHOOSER (Slice 1) — seeds the textarea below with a ready voice paragraph.
            Voice only; the owner edits before saving. Overwrite-safe via applyPreset. */}
        <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
          <span style={hint}>
            אפשר להתחיל מתבנית מוכנה ולערוך אותה. התבנית קובעת כיוון סגנון כללי; השדות בהמשך (אורך תשובות, אימוג׳י, הנחיות ניסוח) הם כוונון ידני נוסף מעל הכיוון הזה.
          </span>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}>
            {PERSONA_PRESETS.map((preset) => (
              <button
                key={preset.id}
                type="button"
                onClick={() => applyPreset(preset.text)}
                style={{
                  padding: "6px 12px", borderRadius: "999px", fontSize: "13px",
                  border: "1px solid #cbd5e1", background: "#fff", color: "#334155",
                  cursor: "pointer", fontWeight: 500,
                }}
              >
                {preset.label}
              </button>
            ))}
          </div>
        </div>
        <label style={fieldWrap}>
          <textarea
            name="custom_instructions" value={personality}
            onChange={(e) => setPersonality(e.target.value)} rows={5} maxLength={2000}
            placeholder="לדוגמה: הסגנון צריך להיות חם, אישי ומקצועי, עם נגיעה של הומור — אנושי וזורם, אף פעם לא רובוטי."
            style={{ ...inputStyle, resize: "vertical" }}
          />
          <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
            <button
              type="button"
              onClick={handleEnhance}
              disabled={pending || personality.trim().length === 0}
              style={{
                padding: "7px 14px", borderRadius: "999px", fontSize: "13px",
                border: "1px solid #0070f3", background: pending ? "#eef5ff" : "#fff",
                color: "#0070f3", cursor: pending || !personality.trim() ? "default" : "pointer",
                opacity: personality.trim().length === 0 ? 0.5 : 1, fontWeight: 600,
              }}
            >
              {pending ? "משפר…" : "✨ שפר עם AI"}
            </button>
            <span style={hint}>ה-AI ינסח מחדש את התיאור — תמיד אפשר לערוך לפני שמירה.</span>
          </div>
          {enhanceMsg && (
            <span style={{ ...hint, color: enhanceOk ? "#0070f3" : "#9a3412" }}>{enhanceMsg}</span>
          )}
          <PolicyHint hits={personalityPolicyHits} />
        </label>
      </fieldset>

      {/* WRITING STYLE — format; independent of personality. */}
      <fieldset style={fieldset}>
        <legend style={legend}>סגנון כתיבה</legend>
        <p style={{ ...hint, margin: 0 }}>פורמט בלבד — כוונון ידני מעל כיוון התבנית, לא תלוי באישיות. גם דמות רצינית וגם דמות מצחיקה יכולות לכתוב קצר.</p>
        <label style={fieldWrap}>
          <span style={fieldLabel}>אורך תשובות</span>
          <select name="response_length" defaultValue={initial?.response_length ?? "medium"} style={inputStyle}>
            <option value="short">קצר — משפט אחד</option>
            <option value="medium">בינוני — 1-3 משפטים</option>
            <option value="long">ארוך — 3-5 משפטים</option>
          </select>
        </label>
        <label style={fieldWrap}>
          <span style={fieldLabel}>שימוש באמוג&#39;י</span>
          <select name="emoji_usage" defaultValue={initial?.emoji_usage ?? "low"} style={inputStyle}>
            <option value="none">ללא</option>
            <option value="low">מועט</option>
            <option value="medium">בינוני</option>
          </select>
        </label>
        <label style={fieldWrap}>
          <span style={fieldLabel}>שפת תקשורת עם לקוחות</span>
          <select name="language" defaultValue={initial?.language ?? "he"} style={inputStyle}>
            {LANGUAGES.map((l) => (
              <option key={l.code} value={l.code}>{l.label}</option>
            ))}
          </select>
        </label>
      </fieldset>

      {/* STYLE GUIDANCE — soft wording/topics to avoid; applied through the assistant, never a system override. */}
      <fieldset style={fieldset}>
        <legend style={legend}>הנחיות סגנון נוספות</legend>
        <label style={fieldWrap}>
          <span style={fieldLabel}>דברים שכדאי לעוזר להימנע מהם בניסוח</span>
          <textarea
            name="things_to_avoid" value={avoid}
            onChange={(e) => setAvoid(e.target.value)} rows={3} maxLength={1000}
            placeholder="לדוגמה: בלי סלנג; לא להיות מכירתי מדי; לא להאריך מדי."
            style={{ ...inputStyle, resize: "vertical" }}
          />
          <span style={hint}>
            הנחיות ניסוח/טון בלבד. <b>מתאים כאן:</b> &quot;בלי סלנג&quot;, &quot;לא להיות מכירתי מדי&quot;, &quot;לא להאריך מדי&quot;.{" "}
            <b>לא מתאים כאן:</b> מחירים, מי מתקבל כלקוח, כללי תורים, שירותים או מדיניות ביטול — אלה עובדות/כללים שמקומם ב
            <a href="/dashboard/knowledge-base" style={{ color: "#0070f3" }}>בסיס הידע</a>, והגדרות כאן לא משנות אותם.
          </span>
          <PolicyHint hits={avoidPolicyHits} />
        </label>
      </fieldset>
    </div>
  );
}

// Non-blocking advisory: shown when a STYLE field contains text that reads like a business
// rule/fact. It NEVER blocks saving and NEVER edits the text — it only nudges the owner toward
// the Knowledge Base. Renders nothing when there are no flagged terms.
function PolicyHint({ hits }: { hits: string[] }) {
  if (hits.length === 0) return null;
  return (
    <span
      role="note"
      style={{
        fontSize: "12px", lineHeight: 1.4, color: "#9a3412",
        background: "#fff7ed", border: "1px solid #fed7aa", borderRadius: "6px", padding: "8px 10px",
      }}
    >
      חלק מהטקסט נשמע כמו כלל עסקי או מידע (למשל מחירים, תורים או מדיניות) ולא כמו הנחיית סגנון.
      הגדרות כאן משפיעות רק על סגנון הדיבור ולא משנות עובדות או כללים — מידע כזה עדיף להגדיר ב
      <a href="/dashboard/knowledge-base" style={{ color: "#9a3412", fontWeight: 600 }}>בסיס הידע</a>.
    </span>
  );
}

function Toggle({
  name, defaultChecked, title, desc,
}: { name: string; defaultChecked: boolean; title: string; desc: string }) {
  return (
    <label style={{ display: "flex", alignItems: "flex-start", gap: "8px", fontSize: "14px" }}>
      <input type="checkbox" name={name} value="on" defaultChecked={defaultChecked} style={{ marginTop: "3px" }} />
      <span>
        <strong>{title}</strong>
        <span style={{ ...hint, display: "block" }}>{desc}</span>
      </span>
    </label>
  );
}
