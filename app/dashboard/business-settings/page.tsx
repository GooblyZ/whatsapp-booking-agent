export const dynamic = "force-dynamic";

import { getDefaultBusinessId } from "@/lib/config";
import { getBusinessWithSettings } from "@/lib/services/business";
import { saveBusinessSettingsAction } from "./actions";
import { SaveBanner } from "@/app/dashboard/_components/SaveBanner";

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
        {/* ── Section 1: Business Identity ───────────────────── */}
        <h2 style={sectionHead}>פרטי העסק</h2>

        <label style={fieldWrap}>
          <span style={fieldLabel}>שם העסק *</span>
          <input name="name" required minLength={2} defaultValue={business.name} style={inp} />
          <span style={hint}>שם זה מופיע ללקוחות ובממשק הניהול.</span>
        </label>

        <label style={fieldWrap}>
          <span style={fieldLabel}>טלפון ליצירת קשר</span>
          <input
            name="phone"
            defaultValue={business.phone ?? ""}
            placeholder="לדוגמה: 050-1234567"
            style={inp}
          />
          <span style={hint}>אופציונלי. לזיהוי העסק בלבד.</span>
        </label>

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

        <hr style={divider} />

        {/* ── Section 2: Booking System ────────────────────────── */}
        <h2 style={sectionHead}>הגדרות קביעת תורים</h2>

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
            קובע את השעון לפיו מחושבות שעות התורים.
            עסקים בישראל: <strong>Asia/Jerusalem</strong>.
          </span>
        </label>

        <label style={fieldWrap}>
          <span style={fieldLabel}>קבלת תורים מופעלת</span>
          <select
            name="booking_enabled"
            defaultValue={String(settings?.booking_enabled ?? true)}
            style={inp}
          >
            <option value="true">כן — ניתן לקבוע תורים</option>
            <option value="false">לא — תורים חסומים כרגע</option>
          </select>
          <span style={hint}>
            כאשר &quot;לא&quot;, לקוח שיכתוב &quot;תור&quot; בWhatsApp יקבל הודעה שקביעת תורים
            אינה זמינה.
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
            style={{ ...inp, maxWidth: "120px" }}
          />
          <span style={hint}>
            ברירת מחדל לפערים בין תורים. כל שירות יכול לדרוס ערך זה.
          </span>
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

      <div
        style={{
          marginTop: "32px",
          padding: "12px 16px",
          background: "#f8f8f8",
          border: "1px solid #e0e0e0",
          borderRadius: "6px",
          fontSize: "13px",
          color: "#666",
        }}
      >
        💡 <strong>מידע לבוט</strong> (חניה, הוראות הגעה, מדיניות ביטולים, FAQ) מנוהל
        ב<a href="/dashboard/knowledge-base" style={{ color: "#0070f3" }}>בסיס הידע</a>.
      </div>
    </div>
  );
}
