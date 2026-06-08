export const dynamic = "force-dynamic";

import { getDefaultBusinessId } from "@/lib/config";
import { getBusinessWithSettings } from "@/lib/services/business";
import { saveBusinessSettingsAction } from "./actions";
import { SaveBanner } from "@/app/dashboard/_components/SaveBanner";

// ── Shared styles ────────────────────────────────────────────────

const inp: React.CSSProperties = {
  width: "100%",
  padding: "8px",
  borderRadius: "4px",
  border: "1px solid #ccc",
  boxSizing: "border-box",
  fontSize: "14px",
};

const fieldWrap: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "4px",
};

const fieldLabel: React.CSSProperties = { fontWeight: "500", fontSize: "14px" };

const hint: React.CSSProperties = { fontSize: "12px", color: "#888", lineHeight: "1.4" };

const sectionHead: React.CSSProperties = {
  fontSize: "16px",
  fontWeight: "600",
  margin: "0 0 4px 0",
  paddingBottom: "8px",
  borderBottom: "1px solid #e8e8e8",
};

const divider: React.CSSProperties = {
  border: "none",
  borderTop: "1px solid #e8e8e8",
  margin: "28px 0 24px",
};

// ── Page ─────────────────────────────────────────────────────────

export default async function BusinessSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ saved?: string; error?: string }>;
}) {
  const businessId = getDefaultBusinessId();
  const [{ business, settings }, params] = await Promise.all([
    getBusinessWithSettings(businessId),
    searchParams,
  ]);

  return (
    <div>
      <h1>הגדרות עסק</h1>
      <SaveBanner saved={params.saved} error={params.error} />

      <form
        action={saveBusinessSettingsAction}
        style={{ display: "flex", flexDirection: "column", gap: "16px", maxWidth: "500px", marginTop: "20px" }}
      >
        {/* ── Section 1: Business Profile ──────────────────────── */}
        <h2 style={sectionHead}>פרופיל העסק</h2>

        <label style={fieldWrap}>
          <span style={fieldLabel}>שם העסק *</span>
          <input name="name" required defaultValue={business.name} style={inp} />
          <span style={hint}>שם זה מופיע ללקוחות ובממשק הניהול.</span>
        </label>

        <label style={fieldWrap}>
          <span style={fieldLabel}>טלפון ליצירת קשר</span>
          <input name="phone" defaultValue={business.phone ?? ""} placeholder="לדוגמה: 050-1234567" style={inp} />
          <span style={hint}>אופציונלי. משמש לזיהוי העסק בלבד — אינו נשלח ללקוחות אוטומטית.</span>
        </label>

        <label style={fieldWrap}>
          <span style={fieldLabel}>אזור זמן</span>
          <input
            name="timezone"
            defaultValue={business.timezone}
            list="tz-options"
            placeholder="Asia/Jerusalem"
            style={inp}
          />
          <datalist id="tz-options">
            <option value="Asia/Jerusalem" />
            <option value="Europe/London" />
            <option value="Europe/Paris" />
            <option value="America/New_York" />
            <option value="America/Chicago" />
            <option value="America/Los_Angeles" />
            <option value="Asia/Dubai" />
            <option value="Asia/Tokyo" />
            <option value="Australia/Sydney" />
            <option value="UTC" />
          </datalist>
          <span style={hint}>
            קובע את השעון לפיו מחושבות שעות התורים. עסקים בישראל: <strong>Asia/Jerusalem</strong>.
            ערך שגוי יגרום לתורים להוצע בשעה הלא נכונה.
          </span>
        </label>

        <hr style={divider} />

        {/* ── Section 2: Location ───────────────────────────────── */}
        <h2 style={sectionHead}>מיקום והגעה</h2>
        <p style={{ ...hint, marginTop: 0, marginBottom: "12px" }}>
          פרטים אלו יוצגו ללקוחות על ידי העוזר החכם כאשר ישאלו על מיקום, חניה או הגעה.
        </p>

        <label style={fieldWrap}>
          <span style={fieldLabel}>כתובת</span>
          <input
            name="address"
            defaultValue={settings?.address ?? ""}
            placeholder="לדוגמה: רחוב הרצל 15"
            style={inp}
          />
        </label>

        <label style={fieldWrap}>
          <span style={fieldLabel}>עיר</span>
          <input
            name="city"
            defaultValue={settings?.city ?? ""}
            placeholder="לדוגמה: תל אביב"
            style={{ ...inp, maxWidth: "220px" }}
          />
        </label>

        <label style={fieldWrap}>
          <span style={fieldLabel}>הוראות חניה</span>
          <textarea
            name="parking_instructions"
            defaultValue={settings?.parking_instructions ?? ""}
            rows={2}
            placeholder="לדוגמה: חניה חינם מאחורי הבניין, כניסה מרחוב הנביאים."
            style={{ ...inp, resize: "vertical" }}
          />
        </label>

        <label style={fieldWrap}>
          <span style={fieldLabel}>הוראות כניסה / הגעה</span>
          <textarea
            name="entrance_instructions"
            defaultValue={settings?.entrance_instructions ?? ""}
            rows={2}
            placeholder="לדוגמה: קומה 3, דלת שמאלית. לחץ על הפעמון בכניסה."
            style={{ ...inp, resize: "vertical" }}
          />
        </label>

        <hr style={divider} />

        {/* ── Section 3: Booking Behaviour ─────────────────────── */}
        <h2 style={sectionHead}>הגדרות קביעת תורים</h2>

        <label style={fieldWrap}>
          <span style={fieldLabel}>קבלת תורים מופעלת</span>
          <select name="booking_enabled" defaultValue={String(settings?.booking_enabled ?? true)} style={inp}>
            <option value="true">כן — ניתן לקבוע תורים</option>
            <option value="false">לא — תורים חסומים כרגע</option>
          </select>
          <span style={hint}>
            כאשר &quot;לא&quot;, לקוח שיכתוב &quot;תור&quot; בWhatsApp יקבל הודעה שקביעת תורים אינה זמינה
            ולא יוכל להמשיך.
          </span>
        </label>

        <label style={fieldWrap}>
          <span style={fieldLabel}>משך תור ברירת מחדל (דקות)</span>
          <input
            name="default_slot_duration_minutes"
            type="number"
            min="5"
            step="5"
            defaultValue={settings?.default_slot_duration_minutes ?? 30}
            style={inp}
          />
          <span style={hint}>
            משמש כברירת מחדל לחישוב פערים בין תורים. כל שירות יכול לדרוס ערך זה.
          </span>
        </label>

        <label style={fieldWrap}>
          <span style={fieldLabel}>מדיניות ביטולים</span>
          <textarea
            name="cancellation_policy_text"
            defaultValue={settings?.cancellation_policy_text ?? ""}
            rows={3}
            placeholder="לדוגמה: ביטול עד 24 שעות לפני התור — ללא חיוב."
            style={{ ...inp, resize: "vertical" }}
          />
          <span style={hint}>
            אופציונלי. טקסט חופשי שיועמד לרשות העוזר החכם בעתיד. אינו נשלח אוטומטית ללקוחות כרגע.
          </span>
        </label>

        <hr style={divider} />

        {/* ── Section 4: Language (advanced) ───────────────────── */}
        <h2 style={sectionHead}>שפה</h2>

        <label style={fieldWrap}>
          <span style={fieldLabel}>שפת ממשק ברירת מחדל</span>
          <input
            name="language"
            defaultValue={settings?.language ?? "he"}
            placeholder="he"
            style={{ ...inp, maxWidth: "100px" }}
          />
          <span style={hint}>קוד שפה: he (עברית), en (אנגלית), ar (ערבית). משמש את העוזר החכם בעתיד.</span>
        </label>

        <button
          type="submit"
          style={{
            marginTop: "8px",
            padding: "10px 24px",
            background: "#0070f3",
            color: "#fff",
            border: "none",
            borderRadius: "4px",
            cursor: "pointer",
            fontWeight: "600",
            fontSize: "14px",
            alignSelf: "flex-start",
          }}
        >
          שמור הגדרות
        </button>
      </form>
    </div>
  );
}
