export const dynamic = "force-dynamic";

import { getDefaultBusinessId } from "@/lib/config";
import { getAISettings } from "@/lib/services/ai-settings";
import { saveAISettingsAction } from "./actions";
import { SaveBanner } from "@/app/dashboard/_components/SaveBanner";

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "8px",
  borderRadius: "4px",
  border: "1px solid #ccc",
  boxSizing: "border-box",
  fontSize: "14px",
};

const btnPrimary: React.CSSProperties = {
  padding: "10px 20px",
  background: "#0070f3",
  color: "#fff",
  border: "none",
  borderRadius: "4px",
  cursor: "pointer",
  fontSize: "14px",
  fontWeight: "600",
};

const fieldWrap: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "4px",
};

const fieldLabel: React.CSSProperties = { fontWeight: "500", fontSize: "14px" };

const hint: React.CSSProperties = { fontSize: "12px", color: "#888", lineHeight: "1.4" };

const LANGUAGES = [
  { code: "he", label: "עברית" },
  { code: "en", label: "English" },
  { code: "ar", label: "العربية" },
  { code: "ru", label: "Русский" },
  { code: "es", label: "Español" },
  { code: "fr", label: "Français" },
] as const;

export default async function AIAssistantPage({
  searchParams,
}: {
  searchParams: Promise<{ saved?: string }>;
}) {
  const businessId = getDefaultBusinessId();
  const [aiSettings, params] = await Promise.all([getAISettings(businessId), searchParams]);

  return (
    <div>
      <h1>הגדרות AI</h1>
      <p style={{ color: "#666", marginTop: "4px", marginBottom: "20px", fontSize: "14px" }}>
        קבע כיצד הבוט מתקשר עם לקוחות.
        מידע על העסק (חניה, FAQ, מדיניות) מנוהל ב
        <a href="/dashboard/knowledge-base" style={{ color: "#0070f3" }}> בסיס הידע</a>.
      </p>

      <SaveBanner saved={params.saved} />

      <form
        action={saveAISettingsAction}
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "16px",
          maxWidth: "480px",
        }}
      >
        {/* Assistant name */}
        <label style={fieldWrap}>
          <span style={fieldLabel}>שם העוזר</span>
          <input
            name="assistant_name"
            defaultValue={aiSettings?.assistant_name ?? "עוזר"}
            style={inputStyle}
          />
          <span style={hint}>השם שהבוט משתמש בו כשהוא מציג את עצמו.</span>
        </label>

        {/* Customer communication language */}
        <label style={fieldWrap}>
          <span style={fieldLabel}>שפת תקשורת עם לקוחות</span>
          <select
            name="language"
            defaultValue={aiSettings?.language ?? "he"}
            style={inputStyle}
          >
            {LANGUAGES.map((l) => (
              <option key={l.code} value={l.code}>
                {l.label}
              </option>
            ))}
          </select>
          <span style={hint}>השפה בה הבוט כותב תשובות ללקוחות.</span>
        </label>

        {/* Tone */}
        <label style={fieldWrap}>
          <span style={fieldLabel}>טון דיבור</span>
          <select name="tone" defaultValue={aiSettings?.tone ?? "friendly"} style={inputStyle}>
            <option value="friendly">ידידותי</option>
            <option value="professional">מקצועי</option>
            <option value="luxury">יוקרתי</option>
            <option value="casual">קז&#39;ואל</option>
          </select>
        </label>

        {/* Response length */}
        <label style={fieldWrap}>
          <span style={fieldLabel}>אורך תשובות</span>
          <select
            name="response_length"
            defaultValue={aiSettings?.response_length ?? "medium"}
            style={inputStyle}
          >
            <option value="short">קצר</option>
            <option value="medium">בינוני</option>
            <option value="long">ארוך</option>
          </select>
        </label>

        {/* Emoji usage */}
        <label style={fieldWrap}>
          <span style={fieldLabel}>שימוש באמוג&#39;י</span>
          <select
            name="emoji_usage"
            defaultValue={aiSettings?.emoji_usage ?? "low"}
            style={inputStyle}
          >
            <option value="none">ללא</option>
            <option value="low">מועט</option>
            <option value="medium">בינוני</option>
          </select>
        </label>

        {/* Custom instructions */}
        <label style={fieldWrap}>
          <span style={fieldLabel}>הוראות מיוחדות</span>
          <textarea
            name="custom_instructions"
            defaultValue={aiSettings?.custom_instructions ?? ""}
            rows={4}
            placeholder="לדוגמה: תמיד פנה ללקוחות בגוף שני. אל תדון במחירים ללא בקשה."
            style={{ ...inputStyle, resize: "vertical" }}
          />
          <span style={hint}>הוראות נוספות שישפיעו על התנהגות הבוט.</span>
        </label>

        <button type="submit" style={{ ...btnPrimary, alignSelf: "flex-start" }}>
          שמור הגדרות
        </button>
      </form>
    </div>
  );
}
