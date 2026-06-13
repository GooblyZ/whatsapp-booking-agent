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
  searchParams: Promise<{ saved?: string; persona?: string }>;
}) {
  const businessId = getDefaultBusinessId();
  const [aiSettings, params] = await Promise.all([getAISettings(businessId), searchParams]);

  return (
    <div>
      <h1>הגדרות AI</h1>
      <p style={{ color: "#666", marginTop: "4px", marginBottom: "20px", fontSize: "14px" }}>
        כאן מעצבים את הדמות של הקבלן הווירטואלי של העסק — איך הוא מדבר, מה האישיות שלו, ומה מותר ואסור לו.
        מידע עובדתי (חניה, FAQ, מדיניות) מנוהל ב
        <a href="/dashboard/knowledge-base" style={{ color: "#0070f3" }}> בסיס הידע</a>.
      </p>

      <SaveBanner saved={params.saved} />

      {params.persona === "deferred" && (
        <div style={{
          background: "#fff7ed", border: "1px solid #fed7aa", color: "#9a3412",
          borderRadius: "8px", padding: "10px 14px", marginBottom: "16px", fontSize: "13px",
        }}>
          ההגדרות הבסיסיות נשמרו. שדות האישיות המתקדמים (סוג העסק, אופי, מה להימנע) יישמרו לאחר
          הרצת מיגרציה <code>008_ai_settings_persona_depth.sql</code> ב-Supabase.
        </div>
      )}

      <form
        action={saveAISettingsAction}
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "16px",
          maxWidth: "480px",
        }}
      >
        {/* AI control toggles */}
        <fieldset
          style={{
            border: "1px solid #e0e0e0",
            borderRadius: "8px",
            padding: "12px 16px",
            margin: 0,
            display: "flex",
            flexDirection: "column",
            gap: "10px",
          }}
        >
          <legend style={{ fontWeight: "600", fontSize: "14px", padding: "0 6px" }}>מצב AI</legend>

          <label style={{ display: "flex", alignItems: "flex-start", gap: "8px", fontSize: "14px" }}>
            <input
              type="checkbox"
              name="ai_enabled"
              value="on"
              defaultChecked={aiSettings?.ai_enabled !== false}
              style={{ marginTop: "3px" }}
            />
            <span>
              <strong>AI פעיל</strong>
              <span style={{ ...hint, display: "block" }}>
                כשמכובה — הבוט עדיין מקבל תורים (&apos;תור&apos;), אך לא עונה על שאלות חופשיות.
              </span>
            </span>
          </label>

          <label style={{ display: "flex", alignItems: "flex-start", gap: "8px", fontSize: "14px" }}>
            <input
              type="checkbox"
              name="faq_enabled"
              value="on"
              defaultChecked={aiSettings?.faq_enabled !== false}
              style={{ marginTop: "3px" }}
            />
            <span>
              <strong>מענה לשאלות (FAQ)</strong>
              <span style={{ ...hint, display: "block" }}>
                מענה אוטומטי לשאלות על שעות, מחירים, מיקום ועוד — מבוסס בסיס הידע.
              </span>
            </span>
          </label>

          <label style={{ display: "flex", alignItems: "flex-start", gap: "8px", fontSize: "14px" }}>
            <input
              type="checkbox"
              name="intent_detection_enabled"
              value="on"
              defaultChecked={aiSettings?.intent_detection_enabled !== false}
              style={{ marginTop: "3px" }}
            />
            <span>
              <strong>זיהוי כוונת קביעת תור</strong>
              <span style={{ ...hint, display: "block" }}>
                זיהוי משפטים כמו &quot;אני רוצה תספורת מחר&quot; והצעה לפתוח תהליך קביעת תור.
              </span>
            </span>
          </label>
        </fieldset>

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

        {/* Business personality (migration 008) */}
        <fieldset
          style={{
            border: "1px solid #e0e0e0", borderRadius: "8px", padding: "12px 16px",
            margin: 0, display: "flex", flexDirection: "column", gap: "12px",
          }}
        >
          <legend style={{ fontWeight: "600", fontSize: "14px", padding: "0 6px" }}>אישיות העסק</legend>
          <p style={{ ...hint, margin: 0 }}>
            ככל שתמלא יותר, כך הבוט ירגיש פחות כמו צ&apos;אטבוט גנרי ויותר כמו הקבלן/ית של העסק שלך.
          </p>

          <label style={fieldWrap}>
            <span style={fieldLabel}>סוג העסק</span>
            <input
              name="business_type"
              defaultValue={aiSettings?.business_type ?? ""}
              placeholder="לדוגמה: מספרה, מרפאת שיניים, סטודיו לפילאטיס"
              maxLength={120}
              style={inputStyle}
            />
            <span style={hint}>ממסגר את כל אופי השיחה — קבלן של מרפאה מדבר אחרת מקבלן של מספרה.</span>
          </label>

          <label style={fieldWrap}>
            <span style={fieldLabel}>אופי ודמות</span>
            <textarea
              name="persona_voice"
              defaultValue={aiSettings?.persona_voice ?? ""}
              rows={3}
              placeholder="לדוגמה: חם ואישי, זוכר לקוחות קבועים, אוהב לפרגן, מדבר בגובה העיניים בלי רשמיות."
              maxLength={1000}
              style={{ ...inputStyle, resize: "vertical" }}
            />
            <span style={hint}>תיאור חופשי של האישיות — גובר על הטון הכללי שנבחר למטה.</span>
          </label>

          <label style={fieldWrap}>
            <span style={fieldLabel}>דברים שאסור לעשות</span>
            <textarea
              name="things_to_avoid"
              defaultValue={aiSettings?.things_to_avoid ?? ""}
              rows={2}
              placeholder="לדוגמה: אל תבטיח תור באותו היום; אל תדון במחירי מתחרים."
              maxLength={1000}
              style={{ ...inputStyle, resize: "vertical" }}
            />
            <span style={hint}>גבולות נוקשים שהבוט לעולם לא יחצה.</span>
          </label>
        </fieldset>

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
