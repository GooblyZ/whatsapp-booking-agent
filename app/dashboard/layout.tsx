import type { ReactNode } from "react";
import { logoutAction } from "@/app/login/actions";

export default function DashboardLayout({ children }: { children: ReactNode }) {
  const hasPassword = Boolean(process.env.DASHBOARD_ACCESS_PASSWORD);

  return (
    <div style={{ fontFamily: "system-ui, sans-serif" }}>
      {!hasPassword && (
        <div
          style={{
            background: "#fff3cd",
            borderBottom: "1px solid #ffc107",
            padding: "8px 24px",
            fontSize: "13px",
            color: "#856404",
            textAlign: "center",
          }}
        >
          ⚠️ אזהרה: ממשק הניהול אינו מוגן בסיסמה. הגדר{" "}
          <strong>DASHBOARD_ACCESS_PASSWORD</strong> בקובץ <strong>.env.local</strong> כדי להפעיל הגנה.
        </div>
      )}

      <nav
        style={{
          background: "#111",
          color: "#fff",
          padding: "12px 24px",
          display: "flex",
          gap: "24px",
          alignItems: "center",
          direction: "rtl",
        }}
      >
        <span style={{ fontWeight: "700", marginLeft: "8px" }}>מזכירה חכמה</span>
        <a href="/dashboard" style={{ color: "#ccc", textDecoration: "none" }}>ראשי</a>
        <a href="/dashboard/appointments" style={{ color: "#ccc", textDecoration: "none" }}>תורים</a>
        <a href="/dashboard/business-settings" style={{ color: "#ccc", textDecoration: "none" }}>הגדרות עסק</a>
        <a href="/dashboard/services" style={{ color: "#ccc", textDecoration: "none" }}>שירותים</a>
        <a href="/dashboard/business-hours" style={{ color: "#ccc", textDecoration: "none" }}>שעות פעילות</a>
        <a href="/dashboard/staff" style={{ color: "#ccc", textDecoration: "none" }}>צוות</a>
        <a href="/dashboard/ai-assistant" style={{ color: "#ccc", textDecoration: "none" }}>עוזר AI</a>
        <a href="/dashboard/activity" style={{ color: "#ccc", textDecoration: "none" }}>פעילות</a>

        {hasPassword && (
          <form action={logoutAction} style={{ marginRight: "auto" }}>
            <button
              type="submit"
              style={{
                background: "transparent",
                border: "1px solid #555",
                color: "#ccc",
                padding: "4px 12px",
                borderRadius: "4px",
                cursor: "pointer",
                fontSize: "13px",
              }}
            >
              יציאה
            </button>
          </form>
        )}
      </nav>

      <main style={{ padding: "24px", maxWidth: "900px", margin: "0 auto", direction: "rtl" }}>
        {children}
      </main>
    </div>
  );
}
