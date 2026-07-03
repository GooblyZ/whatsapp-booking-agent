"use client";

// app/dashboard/ai-assistant/PersonaFields.tsx
// AI Settings v1 — "בוחרים איך העוזר מתנהג ומדבר": a master switch + style PACKAGES, not raw
// prompt controls. Page structure (two conceptual areas, one single-save form):
//
//   אזור 1 · תפעול   — ONE master switch (העוזר פעיל). FAQ/intent are core behavior, not settings.
//   אזור 2 · סגנון   — identity → style packages (5 presets + התאמה אישית) → style-at-a-glance →
//                      advanced overrides (length/emoji/language, collapsed) → boundaries.
//
// Key mechanics:
//   • TRUTHFUL SAVE STATES — every field is controlled; a snapshot of the loaded values drives an
//     isDirty flag, so unsaved local edits can never masquerade as persisted ("עודכן עכשיו" yields
//     to "יש שינויים שלא נשמרו"). Everything (incl. the master switch) is local-until-Save.
//   • STRICT AI-OFF — when the LOCAL switch is off, every style control is `disabled` (values
//     visible, dimmed, not editable); only the switch + Save stay active. Disabled fields are
//     absent from FormData, and the save action writes ONLY present fields — so a save-while-off
//     can never wipe style columns.
//   • PACKAGES — a preset card applies text + its resolved length/emoji defaults TOGETHER; raw
//     preset text is hidden behind a read-only collapsible. Custom mode is a first-class card
//     (owner's words used as-is; ✨ enhance offered there only).

import { useEffect, useState, useTransition } from "react";
import type { AISettings, AISettingsEmojiUsage, AISettingsResponseLength } from "@/types/database";
import { PERSONA_PRESETS, type PersonaPreset } from "@/lib/ai/persona-presets";
import { flagsBusinessPolicy } from "./policy-lint";
import { enhancePersonaAction } from "./actions";
import { type PreviewPresetId, type StyleDimsData } from "./voice-preview";
import { StylePanel } from "./StylePanel";
import { PresetCards } from "./PresetCards";

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
// Each section reads as a distinct dashboard MODULE (card + shadow); hierarchy is typographic —
// deliberately no emoji in headers.
const fieldset: React.CSSProperties = {
  border: "1px solid #e2e8f0", borderRadius: "12px", padding: "18px 20px", margin: 0,
  display: "flex", flexDirection: "column", gap: "12px",
  background: "#fff", boxShadow: "0 1px 3px rgba(15,23,42,0.06)",
};
const legend: React.CSSProperties = { fontWeight: 700, fontSize: "15px", color: "#0f172a", padding: "0 8px" };

/** All owner-editable values, snapshotted once from the loaded row to drive the dirty flag. */
interface FieldsSnapshot {
  aiEnabled: boolean;
  assistantName: string;
  gender: Gender;
  personality: string;
  avoid: string;
  responseLength: AISettingsResponseLength;
  emojiUsage: AISettingsEmojiUsage;
  language: string;
}

function snapshotFrom(initial: AISettings | null): FieldsSnapshot {
  return {
    aiEnabled: initial?.ai_enabled !== false,
    assistantName: initial?.assistant_name ?? "עוזר",
    gender: (initial?.assistant_gender as Gender) ?? "neutral",
    // Back-compat: show a legacy persona_voice value if custom_instructions is empty.
    personality: initial?.custom_instructions ?? initial?.persona_voice ?? "",
    avoid: initial?.things_to_avoid ?? "",
    responseLength: initial?.response_length ?? "medium",
    emojiUsage: initial?.emoji_usage ?? "low",
    language: initial?.language ?? "he",
  };
}

export function PersonaFields({
  initial, styleData, updatedAt, saved,
}: {
  initial: AISettings | null;
  styleData: StyleDimsData;
  updatedAt: string | null;
  saved?: string;
}) {
  // Snapshot of the LOADED values (stable across re-renders) — the dirty-state baseline. After a
  // successful save the page re-renders server-side with fresh props, so the baseline resets.
  const [snapshot] = useState<FieldsSnapshot>(() => snapshotFrom(initial));

  const [aiEnabled, setAiEnabled] = useState(snapshot.aiEnabled);
  const [assistantName, setAssistantName] = useState(snapshot.assistantName);
  const [gender, setGender] = useState<Gender>(snapshot.gender);
  const [personality, setPersonality] = useState(snapshot.personality);
  const [avoid, setAvoid] = useState(snapshot.avoid);
  const [responseLength, setResponseLength] = useState<AISettingsResponseLength>(snapshot.responseLength);
  const [emojiUsage, setEmojiUsage] = useState<AISettingsEmojiUsage>(snapshot.emojiUsage);
  const [language, setLanguage] = useState(snapshot.language);
  // Custom mode is an explicit CHOICE (a card), not only a text-detection result — so opening the
  // custom card with preset-matching text still shows the editor.
  const [forcedCustom, setForcedCustom] = useState(
    () => snapshot.personality.trim().length > 0
      && !PERSONA_PRESETS.some((p) => p.text.trim() === snapshot.personality.trim())
  );
  const [enhanceMsg, setEnhanceMsg] = useState<string | null>(null);
  const [enhanceOk, setEnhanceOk] = useState(false);
  const [pending, startTransition] = useTransition();

  const off = !aiEnabled;
  const isDirty =
    aiEnabled !== snapshot.aiEnabled
    || assistantName !== snapshot.assistantName
    || gender !== snapshot.gender
    || personality !== snapshot.personality
    || avoid !== snapshot.avoid
    || responseLength !== snapshot.responseLength
    || emojiUsage !== snapshot.emojiUsage
    || language !== snapshot.language;

  // Which voice the RUNTIME would resolve for the current text (mirrors detectPreset's
  // exact-match rule) — drives the dims/sample truthfully, independent of the editing mode.
  const detectedId: PreviewPresetId =
    (PERSONA_PRESETS.find((p) => p.text.trim() === personality.trim())?.id as PreviewPresetId | undefined)
    ?? (personality.trim().length > 0 ? "custom" : "default");
  const customActive = forcedCustom || detectedId === "custom";
  const activePresetDims = customActive ? null : styleData.presets[detectedId] ?? null;

  // Advisory (non-blocking): does the free-text read like a business RULE/FACT rather than style?
  const personalityPolicyHits = flagsBusinessPolicy(personality);
  const avoidPolicyHits = flagsBusinessPolicy(avoid);

  /** A preset card applies the FULL PACKAGE: text + the preset's resolved length/emoji defaults.
   *  OVERWRITE SAFETY: existing different text is never silently replaced — explicit confirm. */
  function applyPresetPackage(preset: PersonaPreset) {
    const hasDifferentText = personality.trim().length > 0 && personality.trim() !== preset.text.trim();
    if (hasDifferentText && !window.confirm("יש כבר תיאור אישיות. להחליף אותו בחבילת הסגנון שנבחרה?")) return;
    const dims = styleData.presets[preset.id];
    setPersonality(preset.text);
    if (dims) {
      setResponseLength(dims.lengthDefault);
      setEmojiUsage(dims.emojiDefault);
    }
    setForcedCustom(false);
    setEnhanceMsg(null);
    setEnhanceOk(false);
  }

  function openCustomMode() {
    setForcedCustom(true);
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
    <div style={{ display: "flex", flexDirection: "column", gap: "22px" }}>
      {/* ── AREA 1: OPERATION — the ONE owner-facing switch. Always enabled. ── */}
      <AreaHeader
        eyebrow="אזור 1 · תפעול"
        title="העוזר החכם"
        explainer="מתג אחד קובע אם עוזר ה-AI פעיל. כשהוא פעיל, מענה על שאלות וזיהוי בקשות תור הם חלק מהתפקיד — אין מה להגדיר שם."
      />
      <fieldset style={fieldset}>
        <legend style={legend}>הפעלה</legend>
        <label style={{ display: "flex", alignItems: "flex-start", gap: "10px", fontSize: "14px", cursor: "pointer" }}>
          <input
            type="checkbox" name="ai_enabled" value="on" checked={aiEnabled}
            onChange={(e) => setAiEnabled(e.target.checked)}
            style={{ width: "18px", height: "18px", marginTop: "2px" }}
          />
          <span>
            <strong>העוזר פעיל</strong>
            <span style={{ ...hint, display: "block" }}>
              כשהעוזר פעיל הוא מנהל שיחה, עונה על שאלות ומזהה בקשות לקביעת תור. כשהוא כבוי, הבוט פועל במצב הבסיסי בלבד.
            </span>
          </span>
        </label>
      </fieldset>

      {/* ── AREA 2: STYLE & PERSONA — how the assistant SPEAKS (phrasing/tone only). ── */}
      <AreaHeader
        eyebrow="אזור 2 · סגנון"
        title="סגנון ואישיות — איך העוזר מדבר"
        explainer="כל ההגדרות מכאן ומטה משפיעות רק על הניסוח והטון. הן לעולם לא משנות מחירים, שירותים, כללי תורים, אמינות או עובדות עסקיות."
      />

      {off && (
        <div role="status" style={{
          background: "#f8fafc", border: "1px solid #cbd5e1", borderRadius: "10px",
          padding: "12px 16px", fontSize: "13px", color: "#475569", lineHeight: 1.6,
        }}>
          <strong style={{ color: "#334155" }}>העוזר כבוי כרגע — הבוט פועל במצב הבסיסי בלבד.</strong><br />
          הגדרות הסגנון והאישיות נשמרות אך חלות רק כשהעוזר פעיל. כדי לערוך אותן, הפעילו את העוזר תחילה.
        </div>
      )}

      {/* Everything below is DISABLED while the assistant is off (values visible, not editable). */}
      <div style={{ display: "flex", flexDirection: "column", gap: "22px", opacity: off ? 0.55 : 1 }}>
        {/* IDENTITY */}
        <fieldset style={fieldset}>
          <legend style={legend}>מי הוא</legend>
          <label style={fieldWrap}>
            <span style={fieldLabel}>שם העוזר</span>
            <input
              name="assistant_name" value={assistantName} disabled={off}
              onChange={(e) => setAssistantName(e.target.value)} style={inputStyle}
            />
            <span style={hint}>השם שהבוט משתמש בו כשהוא מציג את עצמו.</span>
          </label>
          <label style={fieldWrap}>
            <span style={fieldLabel}>מין הדמות</span>
            <select
              name="assistant_gender" value={gender} disabled={off}
              onChange={(e) => setGender(e.target.value as Gender)} style={inputStyle}
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

        {/* STYLE PACKAGES — the voice authority, chosen as a package or written custom. */}
        <fieldset style={fieldset}>
          <legend style={legend}>סגנון ואישיות</legend>
          <p style={{ ...hint, margin: 0 }}>
            בוחרים חבילת סגנון מוכנה — או מתארים את העוזר במילים שלכם, כמו עובד אמיתי: איך מדבר, איך מתייחס ללקוחות, מה האופי.
          </p>
          {/* The persisted personality text always travels via this hidden input (disabled while
              off → absent → preserved by the partial-payload action). The visible textarea below
              (custom mode only) edits the same state and carries NO name. */}
          <input type="hidden" name="custom_instructions" value={personality} disabled={off} />
          <PresetCards
            presets={PERSONA_PRESETS}
            styleData={styleData}
            activeId={detectedId}
            customActive={customActive}
            disabled={off}
            onPreset={applyPresetPackage}
            onCustom={openCustomMode}
          />
          {customActive ? (
            <label style={fieldWrap}>
              <span style={fieldLabel}>תיאור העוזר במילים שלך</span>
              {/* EMPTY-CUSTOM GUARD: saving an empty custom style is blocked with a clear Hebrew
                  message (native constraint validation — the textarea participates even without a
                  `name`; disabled fields are exempt, so AI-off saves are unaffected). */}
              <textarea
                value={personality} disabled={off} required
                onChange={(e) => { e.currentTarget.setCustomValidity(""); setPersonality(e.target.value); }}
                onInvalid={(e) => e.currentTarget.setCustomValidity("כתבו תיאור סגנון, או בחרו סגנון מוכן — אי אפשר לשמור התאמה אישית ריקה.")}
                rows={5} maxLength={2000}
                placeholder="לדוגמה: הסגנון צריך להיות חם, אישי ומקצועי, עם נגיעה של הומור — אנושי וזורם, אף פעם לא רובוטי."
                style={{ ...inputStyle, resize: "vertical" }}
              />
              {personality.trim().length === 0 && (
                <span style={{
                  fontSize: "12px", lineHeight: 1.4, color: "#9a3412",
                  background: "#fff7ed", border: "1px solid #fed7aa", borderRadius: "6px", padding: "8px 10px",
                }}>
                  אין עדיין תיאור — התאמה אישית ריקה לא נשמרת. כתבו תיאור במילים שלכם, או בחרו סגנון מוכן.
                </span>
              )}
              <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
                <button
                  type="button"
                  onClick={handleEnhance}
                  disabled={off || pending || personality.trim().length === 0}
                  style={{
                    padding: "7px 14px", borderRadius: "999px", fontSize: "13px",
                    border: "1px solid #0070f3", background: pending ? "#eef5ff" : "#fff",
                    color: "#0070f3", cursor: off || pending || !personality.trim() ? "default" : "pointer",
                    opacity: personality.trim().length === 0 ? 0.5 : 1, fontWeight: 600,
                  }}
                >
                  {pending ? "משפר…" : "✨ שפר עם AI"}
                </button>
                <span style={hint}>ה-AI ינסח מחדש את התיאור — תמיד אפשר לערוך לפני שמירה. הטקסט שלך משמש כפי שהוא.</span>
              </div>
              {enhanceMsg && (
                <span style={{ ...hint, color: enhanceOk ? "#0070f3" : "#9a3412" }}>{enhanceMsg}</span>
              )}
              <PolicyHint hits={personalityPolicyHits} />
            </label>
          ) : personality.trim().length > 0 ? (
            // PRESET MODE — the raw package text stays out of the way; readable on demand.
            <details style={{ fontSize: "13px", color: "#475569" }}>
              <summary style={{ cursor: "pointer", color: "#64748b" }}>נוסח הסגנון (לקריאה)</summary>
              <p style={{
                margin: "8px 0 0", background: "#f8fafc", border: "1px solid #e2e8f0",
                borderRadius: "8px", padding: "10px 12px", lineHeight: 1.6,
              }}>
                {personality}
              </p>
            </details>
          ) : null}
        </fieldset>

        {/* STYLE AT A GLANCE — resolved dimensions + the static sample (mock-framed). */}
        <fieldset style={fieldset}>
          <legend style={legend}>הסגנון שנבחר — במבט אחד</legend>
          <StylePanel
            activePresetId={detectedId}
            customActive={customActive}
            styleData={styleData}
            emojiUsage={emojiUsage}
            responseLength={responseLength}
            language={language}
          />
        </fieldset>

        {/* ADVANCED — overrides on top of the package. Collapsed by default. */}
        <details style={{ ...fieldset, gap: 0 }}>
          <summary style={{ ...legend, cursor: "pointer", padding: 0 }}>הגדרות מתקדמות</summary>
          <div style={{ display: "flex", flexDirection: "column", gap: "12px", marginTop: "12px" }}>
            <p style={{ ...hint, margin: 0 }}>
              {customActive
                ? "כוונון ידני. בהתאמה אישית הערכים כאן נקבעים ישירות — אין ברירות מחדל של חבילה."
                : "כוונון ידני מעל חבילת הסגנון. ברירות המחדל מגיעות מהחבילה שנבחרה — שינוי כאן גובר עליהן."}
            </p>
            <label style={fieldWrap}>
              <span style={fieldLabel}>
                אורך תשובות
                <OverrideTag show={!!activePresetDims && responseLength !== activePresetDims.lengthDefault} />
              </span>
              <select
                name="response_length" value={responseLength} disabled={off}
                onChange={(e) => setResponseLength(e.target.value as AISettingsResponseLength)} style={inputStyle}
              >
                <option value="short">קצר — משפט אחד</option>
                <option value="medium">בינוני — 1-3 משפטים</option>
                <option value="long">ארוך — 3-5 משפטים</option>
              </select>
            </label>
            <label style={fieldWrap}>
              <span style={fieldLabel}>
                שימוש באמוג&#39;י
                <OverrideTag show={!!activePresetDims && emojiUsage !== activePresetDims.emojiDefault} />
              </span>
              <select
                name="emoji_usage" value={emojiUsage} disabled={off}
                onChange={(e) => setEmojiUsage(e.target.value as AISettingsEmojiUsage)} style={inputStyle}
              >
                <option value="none">ללא</option>
                <option value="low">מועט</option>
                <option value="medium">בינוני</option>
              </select>
            </label>
            <label style={fieldWrap}>
              <span style={fieldLabel}>שפת תקשורת עם לקוחות</span>
              <select
                name="language" value={language} disabled={off}
                onChange={(e) => setLanguage(e.target.value)} style={inputStyle}
              >
                {LANGUAGES.map((l) => (
                  <option key={l.code} value={l.code}>{l.label}</option>
                ))}
              </select>
              <span style={hint}>
                קובע את שפת התשובות שה-AI מנסח בשיחה. הודעות מערכת קבועות (אישורי תור, תזכורות ותפריטים) נשלחות כרגע בעברית.
              </span>
            </label>
          </div>
        </details>

        {/* STYLE GUIDANCE — soft wording/topics to avoid; applied through the assistant, never a system override. */}
        <fieldset style={fieldset}>
          <legend style={legend}>הנחיות סגנון נוספות</legend>
          <label style={fieldWrap}>
            <span style={fieldLabel}>דברים שכדאי לעוזר להימנע מהם בניסוח</span>
            <textarea
              name="things_to_avoid" value={avoid} disabled={off}
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

      {/* TRUTHFUL SAVE STATUS — dirty always outranks any "saved" signal. */}
      <SaveStatusLine isDirty={isDirty} saved={saved} updatedAt={updatedAt} />
    </div>
  );
}

// Conceptual AREA header: operational capabilities vs. style/persona — pure typography
// (eyebrow + title + one-liner), so the split is obvious to an owner. Presentation only.
function AreaHeader({ eyebrow, title, explainer }: { eyebrow: string; title: string; explainer: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "3px", marginTop: "6px" }}>
      <span style={{ fontSize: "12px", fontWeight: 600, color: "#64748b", letterSpacing: "0.06em" }}>{eyebrow}</span>
      <span style={{ fontSize: "16px", fontWeight: 700, color: "#0f172a" }}>{title}</span>
      <span style={{ fontSize: "13px", color: "#64748b", lineHeight: 1.5 }}>{explainer}</span>
    </div>
  );
}

/** Small "differs from the package default" tag for advanced overrides. */
function OverrideTag({ show }: { show: boolean }) {
  if (!show) return null;
  return (
    <span style={{
      fontSize: "11px", fontWeight: 600, color: "#9a3412", background: "#fff7ed",
      border: "1px solid #fed7aa", borderRadius: "999px", padding: "1px 8px", marginInlineStart: "8px",
    }}>
      שונה מברירת המחדל של הסגנון
    </span>
  );
}

/** The truthful save-status line — the SINGLE source of truth for save state on this page:
 *  dirty → transient success → quiet last-saved. Rendered client-side so unsaved local edits can
 *  never show as persisted. Success is TRANSIENT (auto-dismisses after a few seconds into the
 *  last-saved line) and is checked AFTER dirty, so a new edit dismisses it instantly — the page
 *  can never say "נשמרו בהצלחה" and "שינויים שלא נשמרו" at once. Fixed timezone avoids SSR/CSR
 *  hydration mismatch. */
const SUCCESS_DISMISS_MS = 4000;

function SaveStatusLine({ isDirty, saved, updatedAt }: { isDirty: boolean; saved?: string; updatedAt: string | null }) {
  const [showSuccess, setShowSuccess] = useState(saved === "1");
  useEffect(() => {
    if (saved !== "1") return;
    const t = setTimeout(() => setShowSuccess(false), SUCCESS_DISMISS_MS);
    return () => clearTimeout(t);
  }, [saved]);

  if (isDirty) {
    return (
      <p role="status" style={{
        margin: 0, fontSize: "13px", fontWeight: 600, color: "#9a3412",
        background: "#fff7ed", border: "1px solid #fed7aa", borderRadius: "8px", padding: "8px 12px",
      }}>
        יש שינויים שלא נשמרו — לחצו &quot;שמור הגדרות&quot; כדי להחיל אותם.
      </p>
    );
  }
  if (showSuccess && saved === "1") {
    return (
      <p role="status" style={{
        margin: 0, fontSize: "13px", fontWeight: 600, color: "#15803d",
        background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: "8px", padding: "8px 12px",
      }}>
        ✅ ההגדרות נשמרו בהצלחה — עודכן עכשיו
      </p>
    );
  }
  if (updatedAt) {
    const hhmm = new Intl.DateTimeFormat("he-IL", {
      hour: "2-digit", minute: "2-digit", timeZone: "Asia/Jerusalem",
    }).format(new Date(updatedAt));
    return <p style={{ margin: 0, fontSize: "13px", color: "#94a3b8" }}>נשמר לאחרונה ב-{hhmm}</p>;
  }
  return null;
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
