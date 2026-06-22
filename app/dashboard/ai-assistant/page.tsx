export const dynamic = "force-dynamic";

import { getDefaultBusinessId } from "@/lib/config";
import { getAISettings } from "@/lib/services/ai-settings";
import { saveAISettingsAction } from "./actions";
import { PersonaFields } from "./PersonaFields";
import { SaveBanner } from "@/app/dashboard/_components/SaveBanner";

const btnPrimary: React.CSSProperties = {
  padding: "10px 20px", background: "#0070f3", color: "#fff", border: "none",
  borderRadius: "4px", cursor: "pointer", fontSize: "14px", fontWeight: 600,
};

// Read-only clarity panel (AI Settings Phase 2B): owner settings shape PRESENTATION only — they never
// change booking/routing/truth/reliability/deterministic behavior. Business-agnostic wording.
const infoCard: React.CSSProperties = {
  background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: "8px",
  padding: "12px 16px", marginBottom: "20px", maxWidth: "640px", fontSize: "13px", color: "#475569",
};
function SettingsScopeNote() {
  return (
    <aside style={infoCard} aria-label="מה ההגדרות האלו משנות">
      <strong style={{ display: "block", color: "#334155", marginBottom: "6px", fontSize: "14px" }}>
        מה ההגדרות האלו משנות?
      </strong>
      <p style={{ margin: "0 0 6px" }}>
        ההגדרות כאן משפיעות על איך העוזר מדבר — שם, סגנון, אורך תשובה, אימוג׳ים, אופי והנחיות ניסוח.
      </p>
      <p style={{ margin: "0 0 8px" }}>
        הן לא משנות את כללי קביעת התורים, אמיתות המידע, ניהול תורים קיימים או מנגנוני הבטיחות והזמינות של המערכת.
      </p>
      <ul style={{ margin: 0, paddingInlineStart: "18px", lineHeight: 1.6 }}>
        <li>תורים נקבעים דרך הקישור / מערכת התורים — העוזר לא מאשר תור ישירות בצ׳אט.</li>
        <li>מידע מהעסק ומבסיס הידע גובר על סגנון הדיבור.</li>
        <li>ניהול, ביטול והזזת תורים נשארים באחריות המערכת.</li>
        <li>אמינות, בטיחות והמצב הדטרמיניסטי (גיבוי) מנוהלים על ידי המערכת — לא דרך סגנון הדיבור.</li>
      </ul>
    </aside>
  );
}

export default async function AIAssistantPage({
  searchParams,
}: {
  searchParams: Promise<{ saved?: string; persona?: string }>;
}) {
  const businessId = getDefaultBusinessId();
  const [aiSettings, params] = await Promise.all([getAISettings(businessId), searchParams]);

  return (
    <div>
      <h1>הגדרת הקבלן/ית</h1>
      <p style={{ color: "#666", marginTop: "4px", marginBottom: "20px", fontSize: "14px", maxWidth: "640px" }}>
        תאר/י איך הקבלן/ית הווירטואלי של העסק צריך/ה להתנהג — בשפה רגילה, לא בהגדרות טכניות.
        העובדות על העסק (חניה, FAQ, מדיניות) מנוהלות ב
        <a href="/dashboard/knowledge-base" style={{ color: "#0070f3" }}> בסיס הידע</a>.
      </p>

      <SettingsScopeNote />

      <SaveBanner saved={params.saved} />

      {params.persona === "deferred" && (
        <div style={{
          background: "#fff7ed", border: "1px solid #fed7aa", color: "#9a3412",
          borderRadius: "8px", padding: "10px 14px", marginBottom: "16px", fontSize: "13px",
        }}>
          ההגדרות נשמרו, אך חלקן (למשל מין הדמות) ייכנסו לתוקף רק לאחר הרצת מיגרציה{" "}
          <code>010_ai_settings_assistant_gender.sql</code> ב-Supabase.
        </div>
      )}

      <form action={saveAISettingsAction} style={{ maxWidth: "520px" }}>
        <PersonaFields initial={aiSettings} />
        <button type="submit" style={{ ...btnPrimary, marginTop: "18px" }}>
          שמור הגדרות
        </button>
      </form>
    </div>
  );
}
