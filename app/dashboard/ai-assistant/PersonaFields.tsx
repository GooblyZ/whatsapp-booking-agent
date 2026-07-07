"use client";

// app/dashboard/ai-assistant/PersonaFields.tsx
// AI Settings Gate D — persona chooser with UNAMBIGUOUS authority. A business picks one of three:
//   • חם וקליל / מקצועי ואלגנטי (RICH packs) → the pack defines voice/style/emoji; advanced STYLE
//     fields are hidden (pack-defined). Identity (name/gender/language) + guardrails stay editable.
//   • מותאם אישית (Custom) → the free-text description + advanced settings define the voice.
// "Start from a pack" is an edit-time SEEDING action: it copies a pack's defaults into the Custom
// fields and sets persona_pack='custom' (custom_base_pack_id is UI/audit metadata only). There is NO
// blended runtime state — the STORED persona_pack alone decides authority, matching the runtime.
//
// The retired 5 lightweight presets are no longer exposed as the primary chooser.
//
// Mechanics preserved from v1: TRUTHFUL SAVE STATES (dirty snapshot), STRICT AI-OFF (disabled fields are
// absent from FormData → the partial-payload action never wipes columns), single-save form.

import { useEffect, useState, useTransition } from "react";
import type { AISettings, AISettingsEmojiUsage, AISettingsResponseLength } from "@/types/database";
import { PERSONA_PRESETS } from "@/lib/ai/persona-presets";
import { PERSONA_PACKS, getPersonaPack, type PersonaPackId, type PersonaSelection } from "@/lib/ai/persona-packs";
import { flagsBusinessPolicy } from "./policy-lint";
import { enhancePersonaAction } from "./actions";
import { type PreviewPresetId, type StyleDimsData } from "./voice-preview";
import { StylePanel } from "./StylePanel";
import { PersonaPackChooser } from "./PersonaPackChooser";

type Gender = "neutral" | "female" | "male";

const LANGUAGES = [
  { code: "he", label: "עברית" },
  { code: "en", label: "English" },
  { code: "ar", label: "العربية" },
  { code: "ru", label: "Русский" },
  { code: "es", label: "Español" },
  { code: "fr", label: "Français" },
] as const;

const LENGTH_HE: Record<AISettingsResponseLength, string> = { short: "קצר", medium: "בינוני", long: "ארוך" };
const EMOJI_HE: Record<AISettingsEmojiUsage, string> = { none: "ללא", low: "מועט", medium: "בינוני" };

const inputStyle: React.CSSProperties = {
  width: "100%", padding: "8px", borderRadius: "4px", border: "1px solid #ccc",
  boxSizing: "border-box", fontSize: "14px",
};
const fieldWrap: React.CSSProperties = { display: "flex", flexDirection: "column", gap: "4px" };
const fieldLabel: React.CSSProperties = { fontWeight: 500, fontSize: "14px" };
const hint: React.CSSProperties = { fontSize: "12px", color: "#888", lineHeight: "1.4" };
const fieldset: React.CSSProperties = {
  border: "1px solid #e2e8f0", borderRadius: "12px", padding: "18px 20px", margin: 0,
  display: "flex", flexDirection: "column", gap: "12px",
  background: "#fff", boxShadow: "0 1px 3px rgba(15,23,42,0.06)",
};
const legend: React.CSSProperties = { fontWeight: 700, fontSize: "15px", color: "#0f172a", padding: "0 8px" };

/** All owner-editable values, snapshotted once from the loaded row to drive the dirty flag. */
interface FieldsSnapshot {
  aiEnabled: boolean;
  personaPack: PersonaSelection;
  customBasePackId: PersonaPackId | null;
  assistantName: string;
  gender: Gender;
  personality: string;
  avoid: string;
  responseLength: AISettingsResponseLength;
  emojiUsage: AISettingsEmojiUsage;
  language: string;
}

function normPack(v: string | null | undefined): PersonaSelection {
  return v === "warm_casual" || v === "professional_elegant" || v === "custom" ? v : "custom";
}
function normBasePack(v: string | null | undefined): PersonaPackId | null {
  return v === "warm_casual" || v === "professional_elegant" ? v : null;
}

function snapshotFrom(initial: AISettings | null): FieldsSnapshot {
  return {
    aiEnabled: initial?.ai_enabled !== false,
    personaPack: normPack(initial?.persona_pack),
    customBasePackId: normBasePack(initial?.custom_base_pack_id),
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
  const [snapshot] = useState<FieldsSnapshot>(() => snapshotFrom(initial));

  const [aiEnabled, setAiEnabled] = useState(snapshot.aiEnabled);
  const [personaPack, setPersonaPack] = useState<PersonaSelection>(snapshot.personaPack);
  const [customBasePackId, setCustomBasePackId] = useState<PersonaPackId | null>(snapshot.customBasePackId);
  const [assistantName, setAssistantName] = useState(snapshot.assistantName);
  const [gender, setGender] = useState<Gender>(snapshot.gender);
  const [personality, setPersonality] = useState(snapshot.personality);
  const [avoid, setAvoid] = useState(snapshot.avoid);
  const [responseLength, setResponseLength] = useState<AISettingsResponseLength>(snapshot.responseLength);
  const [emojiUsage, setEmojiUsage] = useState<AISettingsEmojiUsage>(snapshot.emojiUsage);
  const [language, setLanguage] = useState(snapshot.language);
  const [enhanceMsg, setEnhanceMsg] = useState<string | null>(null);
  const [enhanceOk, setEnhanceOk] = useState(false);
  const [pending, startTransition] = useTransition();

  const off = !aiEnabled;
  const richPack = getPersonaPack(personaPack); // PersonaPack | null (null ⇒ Custom)
  const isCustom = richPack === null;

  const isDirty =
    aiEnabled !== snapshot.aiEnabled
    || personaPack !== snapshot.personaPack
    || customBasePackId !== snapshot.customBasePackId
    || assistantName !== snapshot.assistantName
    || gender !== snapshot.gender
    || (isCustom && personality !== snapshot.personality)
    || avoid !== snapshot.avoid
    || (isCustom && responseLength !== snapshot.responseLength)
    || (isCustom && emojiUsage !== snapshot.emojiUsage)
    || language !== snapshot.language;

  // For the Custom style-at-a-glance: which shipped-preset (if any) the text resolves to. Only the
  // free-text Custom path uses this; a rich pack renders its own read-only summary instead.
  const detectedId: PreviewPresetId =
    (PERSONA_PRESETS.find((p) => p.text.trim() === personality.trim())?.id as PreviewPresetId | undefined)
    ?? (personality.trim().length > 0 ? "custom" : "default");
  const activePresetDims = detectedId === "custom" || detectedId === "default" ? null : styleData.presets[detectedId] ?? null;

  const personalityPolicyHits = flagsBusinessPolicy(personality);
  const avoidPolicyHits = flagsBusinessPolicy(avoid);

  /** Chooser click: a rich pack becomes authoritative; Custom hands authority to the advanced fields. */
  function selectPersona(sel: PersonaSelection) {
    setPersonaPack(sel);
    if (sel !== "custom") setCustomBasePackId(null); // choosing a rich pack clears any "started-from" tag
    setEnhanceMsg(null);
    setEnhanceOk(false);
  }

  /** "Start from a pack" — edit-time SEEDING: copy the pack's voice + defaults into the Custom fields and
   *  switch authority to Custom. custom_base_pack_id is metadata only (never a runtime authority). */
  function startFromPack(packId: PersonaPackId) {
    const pack = PERSONA_PACKS[packId];
    const hasDifferentText = personality.trim().length > 0 && personality.trim() !== pack.voiceText.trim();
    if (hasDifferentText && !window.confirm("יש כבר תיאור אישיות. להחליף אותו בנוסח של הערכה שנבחרה?")) return;
    setPersonality(pack.voiceText);
    setResponseLength(pack.defaults.responseLength);
    setEmojiUsage(pack.defaults.emojiUsage);
    setPersonaPack("custom");
    setCustomBasePackId(packId);
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
        explainer="בוחרים ערכת סגנון מוכנה או התאמה אישית. כל ההגדרות כאן משפיעות רק על הניסוח והטון — לעולם לא על מחירים, שירותים, כללי תורים, אמינות או עובדות."
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
        {/* IDENTITY — editable regardless of the persona choice. */}
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

        {/* PERSONA CHOOSER — the voice authority: a rich pack OR Custom. */}
        <fieldset style={fieldset}>
          <legend style={legend}>ערכת סגנון</legend>
          <p style={{ ...hint, margin: 0 }}>
            בוחרים ערכה מוכנה — <strong>חם וקליל</strong> או <strong>מקצועי ואלגנטי</strong> — או <strong>מותאם אישית</strong> ומתארים את העוזר במילים שלכם.
          </p>

          {/* Authority is carried by these two hidden inputs — dashboard writes EXACTLY what the runtime
              reads. Disabled while off → absent from FormData → preserved (never wiped). */}
          <input type="hidden" name="persona_pack" value={personaPack} disabled={off} />
          <input type="hidden" name="custom_base_pack_id" value={customBasePackId ?? ""} disabled={off} />

          <PersonaPackChooser value={personaPack} disabled={off} onSelect={selectPersona} />

          {richPack ? (
            <RichPackSummary
              pack={richPack}
              disabled={off}
              onCustomize={() => startFromPack(richPack.id)}
            />
          ) : (
            <div style={fieldWrap}>
              {/* Custom text travels via this hidden input ONLY in Custom mode — a rich pack must not write
                  custom_instructions (the pack is authoritative). Disabled while off → preserved. */}
              <input type="hidden" name="custom_instructions" value={personality} disabled={off} />

              <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center" }}>
                <span style={{ ...hint, margin: 0 }}>התחלה מהירה:</span>
                {(Object.keys(PERSONA_PACKS) as PersonaPackId[]).map((id) => (
                  <button
                    key={id} type="button" disabled={off}
                    onClick={() => startFromPack(id)}
                    style={{
                      padding: "5px 12px", borderRadius: "999px", fontSize: "12px", fontWeight: 600,
                      border: "1px solid #cbd5e1", background: "#f8fafc", color: "#334155",
                      cursor: off ? "default" : "pointer",
                    }}
                  >
                    התחל מ&quot;{PERSONA_PACKS[id].label}&quot;
                  </button>
                ))}
              </div>

              <label style={fieldWrap}>
                <span style={fieldLabel}>תיאור העוזר במילים שלך</span>
                <textarea
                  value={personality} disabled={off} required
                  onChange={(e) => { e.currentTarget.setCustomValidity(""); setPersonality(e.target.value); }}
                  onInvalid={(e) => e.currentTarget.setCustomValidity("כתבו תיאור סגנון, או בחרו ערכה מוכנה — אי אפשר לשמור התאמה אישית ריקה.")}
                  rows={5} maxLength={2000}
                  placeholder="לדוגמה: הסגנון צריך להיות חם, אישי ומקצועי, עם נגיעה של הומור — אנושי וזורם, אף פעם לא רובוטי."
                  style={{ ...inputStyle, resize: "vertical" }}
                />
                {personality.trim().length === 0 && (
                  <span style={{
                    fontSize: "12px", lineHeight: 1.4, color: "#9a3412",
                    background: "#fff7ed", border: "1px solid #fed7aa", borderRadius: "6px", padding: "8px 10px",
                  }}>
                    אין עדיין תיאור — התאמה אישית ריקה לא נשמרת. כתבו תיאור במילים שלכם, או בחרו ערכה מוכנה.
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
            </div>
          )}
        </fieldset>

        {/* STYLE AT A GLANCE — Custom only; a rich pack's read-only summary already shows its style. */}
        {isCustom && (
          <fieldset style={fieldset}>
            <legend style={legend}>הסגנון שנבחר — במבט אחד</legend>
            <StylePanel
              activePresetId={detectedId}
              customActive={true}
              styleData={styleData}
              emojiUsage={emojiUsage}
              responseLength={responseLength}
              language={language}
            />
          </fieldset>
        )}

        {/* ADVANCED — language always; length/emoji are pack-defined for a rich pack (shown read-only). */}
        <details style={{ ...fieldset, gap: 0 }}>
          <summary style={{ ...legend, cursor: "pointer", padding: 0 }}>הגדרות מתקדמות</summary>
          <div style={{ display: "flex", flexDirection: "column", gap: "12px", marginTop: "12px" }}>
            {isCustom ? (
              <>
                <p style={{ ...hint, margin: 0 }}>כוונון ידני. בהתאמה אישית הערכים כאן נקבעים ישירות.</p>
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
              </>
            ) : (
              <PackDefinedStyleNote pack={richPack!} />
            )}
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

        {/* STYLE GUIDANCE — soft wording/topics to avoid; a guardrail applied through the assistant. */}
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

// ── Rich-pack read-only summary — shown when a rich pack is the authority. ──────────────────────────
function RichPackSummary({
  pack, disabled, onCustomize,
}: {
  pack: (typeof PERSONA_PACKS)[PersonaPackId];
  disabled: boolean;
  onCustomize: () => void;
}) {
  return (
    <div style={{
      background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: "10px", padding: "12px 14px",
      display: "flex", flexDirection: "column", gap: "8px",
    }}>
      <span style={{ fontSize: "14px", fontWeight: 700, color: "#0f172a" }}>{pack.label}</span>
      <span style={{ fontSize: "13px", color: "#475569", lineHeight: 1.5 }}>{pack.tagline}</span>
      <span style={{ fontSize: "12px", color: "#64748b" }}>
        הטון, האורך והאימוג׳ים מוגדרים על ידי הערכה (אימוג׳י: {EMOJI_HE[pack.defaults.emojiUsage]} · אורך: {LENGTH_HE[pack.defaults.responseLength]}).
        אפשר לשנות רק את השם, מין הדמות והשפה למעלה.
      </span>
      <div>
        <button
          type="button" disabled={disabled} onClick={onCustomize}
          style={{
            padding: "6px 14px", borderRadius: "999px", fontSize: "12px", fontWeight: 600,
            border: "1px solid #0070f3", background: "#fff", color: "#0070f3",
            cursor: disabled ? "default" : "pointer",
          }}
        >
          התחל מערכה זו והתאם אישית
        </button>
      </div>
    </div>
  );
}

/** Advanced-section note when a rich pack is authoritative (length/emoji are pack-defined, not editable). */
function PackDefinedStyleNote({ pack }: { pack: (typeof PERSONA_PACKS)[PersonaPackId] }) {
  return (
    <p style={{ ...hint, margin: 0 }}>
      אורך התשובות והאימוג׳י מוגדרים על ידי הערכה שנבחרה (אורך: {LENGTH_HE[pack.defaults.responseLength]} · אימוג׳י: {EMOJI_HE[pack.defaults.emojiUsage]}).
      כדי לכוונן אותם ידנית, בחרו &quot;מותאם אישית&quot; או &quot;התחל מערכה זו והתאם אישית&quot;.
    </p>
  );
}

// Conceptual AREA header — pure typography (eyebrow + title + one-liner). Presentation only.
function AreaHeader({ eyebrow, title, explainer }: { eyebrow: string; title: string; explainer: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "3px", marginTop: "6px" }}>
      <span style={{ fontSize: "12px", fontWeight: 600, color: "#64748b", letterSpacing: "0.06em" }}>{eyebrow}</span>
      <span style={{ fontSize: "16px", fontWeight: 700, color: "#0f172a" }}>{title}</span>
      <span style={{ fontSize: "13px", color: "#64748b", lineHeight: 1.5 }}>{explainer}</span>
    </div>
  );
}

/** Small "differs from the package default" tag for advanced overrides (Custom mode). */
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

/** The truthful save-status line — dirty → transient success → quiet last-saved. */
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

// Non-blocking advisory: shown when a STYLE field reads like a business rule/fact.
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
