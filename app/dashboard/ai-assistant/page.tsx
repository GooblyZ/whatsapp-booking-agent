export const dynamic = "force-dynamic";

import { getDefaultBusinessId } from "@/lib/config";
import { getAISettings } from "@/lib/services/ai-settings";
import { resolveStyleProfile } from "@/lib/ai/resolve-style-profile";
import { PERSONA_PRESETS } from "@/lib/ai/persona-presets";
import { saveAISettingsAction } from "./actions";
import { PersonaFields } from "./PersonaFields";
import { SaveBanner } from "@/app/dashboard/_components/SaveBanner";
import { SaveButton } from "./SaveButton";
import type { StyleDimsData } from "./voice-preview";

// Style-dimension data for the client panel, resolved ONCE on the server from the same
// resolveStyleProfile the runtime hash uses (that module imports node crypto → server-only, so the
// client receives plain JSON). UI v2 reads these vectors; nothing here changes what gets saved.
function buildStyleDimsData(): StyleDimsData {
  const presets: StyleDimsData["presets"] = {};
  for (const p of PERSONA_PRESETS) {
    // With no explicit emoji/length in the input, the resolver returns the preset's own package
    // defaults — exactly what a card click should apply alongside the text.
    const r = resolveStyleProfile({ custom_instructions: p.text });
    presets[p.id] = {
      formality: r.vector.formality, warmth: r.vector.warmth, energy: r.vector.energy, register: r.register,
      emojiDefault: r.emojiUsage, lengthDefault: r.responseLength,
    };
  }
  const n = resolveStyleProfile(null);
  return {
    presets,
    neutral: {
      formality: n.vector.formality, warmth: n.vector.warmth, energy: n.vector.energy, register: n.register,
      emojiDefault: n.emojiUsage, lengthDefault: n.responseLength,
    },
    brevityByLength: {
      short: resolveStyleProfile({ response_length: "short" }).vector.brevity,
      medium: resolveStyleProfile({ response_length: "medium" }).vector.brevity,
      long: resolveStyleProfile({ response_length: "long" }).vector.brevity,
    },
  };
}
const STYLE_DIMS_DATA = buildStyleDimsData();

// Read-only clarity panel (AI Settings Phase 2B): owner settings shape PRESENTATION only — they never
// change booking/routing/truth/reliability/deterministic behavior. Business-agnostic wording.
const infoCard: React.CSSProperties = {
  background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: "8px",
  padding: "12px 16px", marginBottom: "20px", maxWidth: "640px", fontSize: "13px", color: "#475569",
};
// Two-column scope panel (UI v2): the same style-only message, now scannable at a glance —
// a "changes" column vs. a "never changes" column. Copy change only; no behavior implication.
const scopeList: React.CSSProperties = { margin: 0, paddingInlineStart: "18px", lineHeight: 1.7 };
function SettingsScopeNote() {
  return (
    <aside style={infoCard} aria-label="מה ההגדרות האלו משנות">
      <strong style={{ display: "block", color: "#334155", marginBottom: "8px", fontSize: "14px" }}>
        מה ההגדרות האלו משנות — ומה לא?
      </strong>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "12px", marginBottom: "8px" }}>
        <div style={{ background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: "10px", padding: "10px 12px" }}>
          <span style={{ display: "block", fontWeight: 600, color: "#15803d", marginBottom: "4px" }}>✓ משנה — איך העוזר מדבר</span>
          <ul style={scopeList}>
            <li>טון, חום ואופי</li>
            <li>רמת רשמיות ותמציתיות</li>
            <li>אורך תשובות ואימוג׳ים</li>
            <li>סגנון פנייה ושפת התקשורת</li>
          </ul>
        </div>
        <div style={{ background: "#fef2f2", border: "1px solid #fecaca", borderRadius: "10px", padding: "10px 12px" }}>
          <span style={{ display: "block", fontWeight: 600, color: "#b91c1c", marginBottom: "4px" }}>✗ לא משנה — עובדות וכללים</span>
          <ul style={scopeList}>
            <li>מחירים, שירותים ושעות פעילות</li>
            <li>כללי קביעת תורים ומדיניות ביטול</li>
            <li>היכולת לקבוע, לבטל או להזיז תור — הכול דרך מערכת התורים, לא בצ׳אט</li>
            <li>בטיחות, אמינות ומצב הגיבוי — תמיד גוברים על סגנון הדיבור</li>
          </ul>
        </div>
      </div>
      <p style={{ margin: 0 }}>
        בעמוד שני אזורים — <strong>יכולות</strong> (אילו פעולות ה-AI מבצע) ו<strong>סגנון ואישיות</strong> (איך הוא מדבר).
        אף אחד מהם לא משנה עובדות עסקיות, כללים או אמינות: עובדות ומדיניות (מחירים, שירותים, שעות, ביטולים) מקומן ב
        <a href="/dashboard/knowledge-base" style={{ color: "#0070f3" }}>בסיס הידע</a> — ההגדרות כאן לא יכולות לשנות אותן.
      </p>
    </aside>
  );
}

export default async function AIAssistantPage({
  searchParams,
}: {
  searchParams: Promise<{ saved?: string; persona?: string; error?: string }>;
}) {
  const businessId = getDefaultBusinessId();
  const [aiSettings, params] = await Promise.all([getAISettings(businessId), searchParams]);

  return (
    <div>
      <h1>הגדרות העוזר</h1>
      <p style={{ color: "#666", marginTop: "4px", marginBottom: "20px", fontSize: "14px", maxWidth: "640px" }}>
        בוחרים איך עוזר ה-AI של העסק מתנהג ומדבר — חבילת סגנון מוכנה או התאמה אישית, בשפה רגילה.
        העובדות על העסק (חניה, FAQ, מדיניות) מנוהלות ב
        <a href="/dashboard/knowledge-base" style={{ color: "#0070f3" }}> בסיס הידע</a>.
      </p>

      <SettingsScopeNote />

      {/* Save SUCCESS is owned by the client SaveStatusLine (single source of truth — transient,
          and instantly outranked by unsaved edits). The top banner handles only ERRORS here, so
          the page can never show "נשמרו בהצלחה" and "שינויים שלא נשמרו" at the same time. */}
      <SaveBanner error={params.error} />

      {params.persona === "deferred" && (
        <div style={{
          background: "#fff7ed", border: "1px solid #fed7aa", color: "#9a3412",
          borderRadius: "8px", padding: "10px 14px", marginBottom: "16px", fontSize: "13px",
        }}>
          ההגדרות נשמרו, אך חלקן (למשל בחירת ערכת הסגנון או מין הדמות) ייכנסו לתוקף רק לאחר הרצת המיגרציה
          הרלוונטית ב-Supabase (למשל <code>013_ai_settings_persona_pack.sql</code> או{" "}
          <code>010_ai_settings_assistant_gender.sql</code>).
        </div>
      )}

      <form action={saveAISettingsAction} style={{ maxWidth: "640px" }}>
        {/* The save-status line (dirty / just-saved / last-saved) now lives INSIDE PersonaFields
            (client) so unsaved local edits can never masquerade as persisted state. */}
        <PersonaFields
          initial={aiSettings}
          styleData={STYLE_DIMS_DATA}
          updatedAt={aiSettings?.updated_at ?? null}
          saved={params.saved}
        />
        <SaveButton />
      </form>
    </div>
  );
}
