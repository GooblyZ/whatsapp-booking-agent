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
