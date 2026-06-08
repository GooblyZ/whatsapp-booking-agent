export const dynamic = "force-dynamic";

import { getDefaultBusinessId } from "@/lib/config";
import { getBusinessHours, DAY_NAMES, ALL_DAYS } from "@/lib/services/business-hours";
import { saveBusinessHoursAction } from "./actions";
import { SaveBanner } from "@/app/dashboard/_components/SaveBanner";
import { HoursToggle } from "./HoursToggle";
import type { BusinessHour } from "@/types/database";

// ── Styles ──────────────────────────────────────────────────────

const timeInput: React.CSSProperties = {
  padding: "6px 8px",
  borderRadius: "4px",
  border: "1px solid #ccc",
  fontSize: "14px",
  width: "90px",
};

const btnPrimary: React.CSSProperties = {
  padding: "10px 24px",
  background: "#0070f3",
  color: "#fff",
  border: "none",
  borderRadius: "4px",
  cursor: "pointer",
  fontWeight: "600",
  fontSize: "14px",
};

const noticeBanner: React.CSSProperties = {
  background: "#fff8e1",
  border: "1px solid #ffe082",
  borderRadius: "6px",
  padding: "10px 14px",
  fontSize: "13px",
  color: "#5f4200",
  marginBottom: "20px",
};

// ── Component ───────────────────────────────────────────────────

export default async function BusinessHoursPage({
  searchParams,
}: {
  searchParams: Promise<{ saved?: string }>;
}) {
  const businessId = getDefaultBusinessId();
  const [existingHours, params] = await Promise.all([
    getBusinessHours(businessId),
    searchParams,
  ]);

  // Map existing rows by day_of_week for easy lookup
  const byDay: Record<number, BusinessHour> = {};
  for (const row of existingHours) {
    byDay[row.day_of_week] = row;
  }

  const isFirstSetup = existingHours.length === 0;

  return (
    <div>
      <h1>שעות פעילות</h1>
      <p style={{ color: "#666", marginBottom: "16px" }}>
        הגדר את ימי ושעות הפעילות של העסק. שעות אלו קובעות אילו זמנים יוצעו ללקוחות בעת קביעת תור.
      </p>

      <SaveBanner saved={params.saved} />

      {isFirstSetup && (
        <div style={noticeBanner}>
          ⚠️ שעות פעילות טרם הוגדרו. כרגע המערכת משתמשת בברירת מחדל:{" "}
          <strong>09:00–18:00 בכל הימים</strong>. הגדר שעות כדי לשלוט על הזמינות האמיתית של העסק.
        </div>
      )}

      <form action={saveBusinessHoursAction}>
        <div
          style={{
            border: "1px solid #e0e0e0",
            borderRadius: "8px",
            overflow: "hidden",
            marginBottom: "20px",
          }}
        >
          {/* Header row */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "90px 80px 100px 24px 100px",
              gap: "12px",
              padding: "10px 16px",
              background: "#fafafa",
              borderBottom: "1px solid #e0e0e0",
              fontWeight: "600",
              fontSize: "13px",
              color: "#555",
              alignItems: "center",
            }}
          >
            <span>יום</span>
            <span>סגור</span>
            <span>פתיחה</span>
            <span />
            <span>סגירה</span>
          </div>

          {ALL_DAYS.map((day, idx) => {
            const row      = byDay[day];
            const isClosed = row?.is_closed ?? false;
            const opensAt  = row?.opens_at  ?? "09:00";
            const closesAt = row?.closes_at ?? "18:00";
            const isLast   = idx === ALL_DAYS.length - 1;

            return (
              <div
                key={day}
                data-day={day}
                style={{
                  display: "grid",
                  gridTemplateColumns: "90px 80px 100px 24px 100px",
                  gap: "12px",
                  padding: "12px 16px",
                  alignItems: "center",
                  borderBottom: isLast ? "none" : "1px solid #f0f0f0",
                  background: isClosed ? "#fafafa" : "#fff",
                }}
              >
                <span style={{ fontWeight: "500", fontSize: "14px" }}>{DAY_NAMES[day]}</span>

                <label style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "14px" }}>
                  <input
                    type="checkbox"
                    name={`day_${day}_closed`}
                    defaultChecked={isClosed}
                    data-day-toggle={day}
                  />
                  סגור
                </label>

                <input
                  type="time"
                  name={`day_${day}_opens`}
                  defaultValue={opensAt ?? "09:00"}
                  disabled={isClosed}
                  data-day-time={day}
                  style={{ ...timeInput, opacity: isClosed ? 0.35 : 1 }}
                />

                <span style={{ textAlign: "center", color: "#999", fontSize: "13px" }}>—</span>

                <input
                  type="time"
                  name={`day_${day}_closes`}
                  defaultValue={closesAt ?? "18:00"}
                  disabled={isClosed}
                  data-day-time={day}
                  style={{ ...timeInput, opacity: isClosed ? 0.35 : 1 }}
                />
              </div>
            );
          })}
        </div>

        <p style={{ fontSize: "12px", color: "#999", marginBottom: "12px" }}>
          שינויים נכנסים לתוקף מיד ומשפיעים על תורים חדשים בלבד.
        </p>

        <button type="submit" style={btnPrimary}>שמור שעות פעילות</button>
      </form>

      {/* Client component handles checkbox → time-input toggle with no inline scripts */}
      <HoursToggle />
    </div>
  );
}
