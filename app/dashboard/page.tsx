export const dynamic = "force-dynamic";

import { supabaseServer } from "@/lib/supabase/server";
import { getDefaultBusinessId } from "@/lib/config";
import { countAIEventsSince } from "@/lib/ai/events";
import { readPersistedWhatsAppHealth } from "@/lib/integration-health";

// ── Setup Checklist ─────────────────────────────────────────────

interface SetupItem {
  key:    string;
  label:  string;
  hint:   string;
  done:   boolean;
  link:   string | null;
  action: string;
}

function ChecklistItem({ item }: { item: SetupItem }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: "10px",
        fontSize: "14px",
        padding: "8px 0",
        borderBottom: "1px solid #e4efff",
        opacity: item.done ? 0.55 : 1,
      }}
    >
      <span style={{ fontSize: "17px", flexShrink: 0, marginTop: "1px" }}>
        {item.done ? "✅" : "⬜"}
      </span>

      <div style={{ flex: 1 }}>
        <div style={{ fontWeight: item.done ? "400" : "600", color: item.done ? "#666" : "#111" }}>
          {item.label}
        </div>
        {!item.done && (
          <div style={{ fontSize: "12px", color: "#666", marginTop: "2px" }}>{item.hint}</div>
        )}
      </div>

      {item.link ? (
        <a
          href={item.link}
          style={{
            flexShrink: 0,
            fontSize: "13px",
            color: item.done ? "#999" : "#0070f3",
            textDecoration: "none",
            padding: "3px 10px",
            border: `1px solid ${item.done ? "#ddd" : "#b3d4ff"}`,
            borderRadius: "4px",
            background: "#fff",
            whiteSpace: "nowrap",
          }}
        >
          {item.action}
        </a>
      ) : !item.done ? (
        <span style={{ flexShrink: 0, fontSize: "12px", color: "#888", padding: "3px 0" }}>
          {item.action}
        </span>
      ) : null}
    </div>
  );
}

function SetupChecklist({ items }: { items: SetupItem[] }) {
  const incomplete = items.filter((i) => !i.done);
  if (incomplete.length === 0) return null;

  return (
    <div
      style={{
        border: "1px solid #b3d4ff",
        background: "#f0f7ff",
        borderRadius: "8px",
        padding: "16px 20px",
        marginBottom: "28px",
      }}
    >
      <h2 style={{ margin: "0 0 12px 0", fontSize: "16px", fontWeight: "600", color: "#004080" }}>
        🚀 התחלה מהירה — {incomplete.length} צעד{incomplete.length > 1 ? "ים" : ""} נותר{incomplete.length > 1 ? "ו" : ""}
      </h2>
      <div>
        {items.map((item) => (
          <ChecklistItem key={item.key} item={item} />
        ))}
      </div>
    </div>
  );
}

// ── Page ────────────────────────────────────────────────────────

export default async function DashboardPage() {
  const db         = supabaseServer();
  const businessId = getDefaultBusinessId();

  const [c, a, s, m, h, bizResult, settingsResult, pendingResult] = await Promise.all([
    db.from("customers").select("*", { count: "exact", head: true }).eq("business_id", businessId),
    db.from("appointments").select("*", { count: "exact", head: true }).eq("business_id", businessId),
    db.from("services").select("*", { count: "exact", head: true }).eq("business_id", businessId).eq("active", true),
    db.from("messages").select("*", { count: "exact", head: true }).eq("business_id", businessId),
    db.from("business_hours").select("*", { count: "exact", head: true }).eq("business_id", businessId),
    db.from("businesses").select("name, timezone, phone").eq("id", businessId).single(),
    db.from("business_settings").select("booking_enabled, language").eq("business_id", businessId).maybeSingle(),
    db.from("appointments").select("*", { count: "exact", head: true })
      .eq("business_id", businessId)
      .eq("status", "pending"),
  ]);

  const biz      = bizResult.data as { name: string; timezone: string; phone: string | null } | null;
  const settings = settingsResult.data as { booking_enabled: boolean; language: string } | null;

  // ── AI usage counters (PART 6). Approximate — counts billable Gemini calls. ──
  // Day/month boundaries use UTC; "approximate counts are enough".
  const now          = new Date();
  const startOfToday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
  const startOfMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  const [aiCallsToday, aiCallsMonth] = await Promise.all([
    countAIEventsSince(businessId, startOfToday),
    countAIEventsSince(businessId, startOfMonth),
  ]);

  // "Business profile done" = owner has set a real timezone (not the schema default "UTC").
  const profileDone =
    Boolean(biz?.name?.trim()) && Boolean(biz?.timezone) && biz?.timezone !== "UTC";

  const whatsappConnected = Boolean(process.env.META_PHONE_NUMBER_ID);
  const bookingEnabled    = settings?.booking_enabled !== false;

  // Persisted WhatsApp delivery health (null until migration 006 is applied).
  const waHealth = await readPersistedWhatsAppHealth(db, businessId);
  const waAuthFailed = waHealth?.status === "auth_failed";
  const waDegraded = waHealth?.status === "degraded";

  const setupItems: SetupItem[] = [
    {
      key:    "profile",
      label:  "הגדרות עסק — שם, אזור זמן",
      hint:   "הגדר את שם העסק ואזור הזמן כדי שתורים יוצגו בשעה הנכונה.",
      done:   profileDone,
      link:   "/dashboard/business-settings",
      action: "הגדר עכשיו",
    },
    {
      key:    "hours",
      label:  "שעות פעילות — מתי העסק פתוח?",
      hint:   "ללא שעות פעילות, המערכת תציע 09:00–18:00 בכל הימים. הגדר שעות אמיתיות.",
      done:   (h.count ?? 0) > 0,
      link:   "/dashboard/business-hours",
      action: "הגדר שעות",
    },
    {
      key:    "services",
      label:  "שירות אחד לפחות — מה הלקוחות יזמינו?",
      hint:   "ללא שירותים, לקוחות לא יוכלו לקבוע תור ב‑WhatsApp.",
      done:   (s.count ?? 0) > 0,
      link:   "/dashboard/services",
      action: "הוסף שירות",
    },
    {
      key:    "whatsapp",
      label:  "WhatsApp — מחובר ופעיל",
      hint:   "הגדר META_PHONE_NUMBER_ID ו‑META_ACCESS_TOKEN בקובץ .env.local ואתחל את השרת.",
      done:   whatsappConnected,
      link:   null,
      action: "נדרשת הגדרה ב‑.env.local",
    },
  ];

  const stats = [
    { label: "לקוחות",  value: c.count ?? 0, link: null },
    { label: "תורים",   value: a.count ?? 0, link: "/dashboard/appointments" },
    { label: "שירותים", value: s.count ?? 0, link: "/dashboard/services" },
    { label: "הודעות",  value: m.count ?? 0, link: "/dashboard/activity" },
  ];

  const pendingCount = pendingResult.count ?? 0;

  const statCard = (label: string, value: number | string, link: string | null) => {
    const inner = (
      <div
        style={{
          border: "1px solid #e0e0e0",
          borderRadius: "8px",
          padding: "20px 16px",
          textAlign: "center",
          background: "#fff",
        }}
      >
        <div style={{ fontSize: "32px", fontWeight: "700" }}>{value}</div>
        <div style={{ color: "#666", marginTop: "6px", fontSize: "14px" }}>{label}</div>
      </div>
    );
    return link ? (
      <a key={label} href={link} style={{ textDecoration: "none", color: "inherit" }}>{inner}</a>
    ) : (
      <div key={label}>{inner}</div>
    );
  };

  return (
    <div>
      <h1 style={{ marginBottom: "20px" }}>לוח בקרה</h1>

      {/* ── WhatsApp delivery alert ─────────────────────────── */}
      {(waAuthFailed || waDegraded) && (
        <div
          style={{
            background: waAuthFailed ? "#fdecea" : "#fff3cd",
            border: `1px solid ${waAuthFailed ? "#f5c2c0" : "#ffc107"}`,
            color: waAuthFailed ? "#b71c1c" : "#856404",
            borderRadius: "8px",
            padding: "14px 18px",
            marginBottom: "20px",
            fontSize: "14px",
          }}
        >
          <strong>
            {waAuthFailed
              ? "⛔ תקלת חיבור ל-WhatsApp: האימות מול Meta נכשל."
              : "⚠️ תקלות בשליחת הודעות WhatsApp."}
          </strong>
          <div style={{ marginTop: "4px" }}>
            {waAuthFailed
              ? "הודעות מלקוחות נשמרות, אך הבוט לא יכול לענות עד לחידוש הטוקן. חדש/י את META_ACCESS_TOKEN ואתחל/י את השרת."
              : "בדוק/י את חיבור ה-API של Meta."}
            {waHealth?.lastErrorAt && (
              <span style={{ color: "#888" }}>
                {" "}(כשלים רצופים: {waHealth.consecutiveFailures}, אחרון: {new Date(waHealth.lastErrorAt).toLocaleString("he-IL")})
              </span>
            )}
          </div>
        </div>
      )}

      <SetupChecklist items={setupItems} />

      {/* ── Business Summary Card ─────────────────────────────── */}
      <div
        style={{
          border: "1px solid #e0e0e0",
          borderRadius: "8px",
          padding: "16px 20px",
          marginBottom: "24px",
          background: "#fafafa",
          display: "flex",
          flexWrap: "wrap",
          gap: "12px 32px",
          alignItems: "flex-start",
        }}
      >
        <div>
          <div style={{ fontSize: "11px", color: "#888", textTransform: "uppercase", marginBottom: "2px" }}>עסק</div>
          <div style={{ fontWeight: "600", fontSize: "15px" }}>{biz?.name ?? "—"}</div>
        </div>
        <div>
          <div style={{ fontSize: "11px", color: "#888", textTransform: "uppercase", marginBottom: "2px" }}>אזור זמן</div>
          <div style={{ fontSize: "14px" }}>{biz?.timezone ?? "—"}</div>
        </div>
        <div>
          <div style={{ fontSize: "11px", color: "#888", textTransform: "uppercase", marginBottom: "2px" }}>WhatsApp</div>
          <div style={{ fontSize: "14px", color: whatsappConnected ? "#198754" : "#dc3545", fontWeight: "500" }}>
            {whatsappConnected ? "מחובר ✓" : "לא מחובר"}
          </div>
        </div>
        <div>
          <div style={{ fontSize: "11px", color: "#888", textTransform: "uppercase", marginBottom: "2px" }}>קבלת תורים</div>
          <div style={{ fontSize: "14px", color: bookingEnabled ? "#198754" : "#dc3545", fontWeight: "500" }}>
            {bookingEnabled ? "פעיל ✓" : "מושבת"}
          </div>
        </div>
        {pendingCount > 0 && (
          <div>
            <div style={{ fontSize: "11px", color: "#888", textTransform: "uppercase", marginBottom: "2px" }}>תורים ממתינים</div>
            <a
              href="/dashboard/appointments"
              style={{
                fontSize: "14px",
                fontWeight: "700",
                color: "#d97706",
                textDecoration: "none",
              }}
            >
              {pendingCount} ממתינים לאישור →
            </a>
          </div>
        )}

        <a
          href="/dashboard/business-settings"
          style={{
            marginRight: "auto",
            fontSize: "13px",
            color: "#0070f3",
            textDecoration: "none",
            alignSelf: "center",
            padding: "4px 10px",
            border: "1px solid #b3d4ff",
            borderRadius: "4px",
            background: "#fff",
            whiteSpace: "nowrap",
          }}
        >
          ערוך הגדרות
        </a>
      </div>

      {/* ── Stats Grid ────────────────────────────────────────── */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
          gap: "12px",
          marginBottom: "24px",
        }}
      >
        {stats.map((stat) => statCard(stat.label, stat.value, stat.link))}
      </div>

      {/* ── AI Usage ──────────────────────────────────────────── */}
      <div
        style={{
          border: "1px solid #e0e0e0",
          borderRadius: "8px",
          padding: "14px 20px",
          marginBottom: "24px",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "10px" }}>
          <div style={{ fontWeight: "600", fontSize: "14px" }}>🤖 שימוש AI</div>
          <a
            href="/dashboard/ai-debug"
            style={{ fontSize: "12px", color: "#0070f3", textDecoration: "none" }}
          >
            בדיקת AI →
          </a>
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "12px 40px" }}>
          <div>
            <div style={{ fontSize: "26px", fontWeight: "700" }}>≈ {aiCallsToday}</div>
            <div style={{ color: "#666", fontSize: "13px" }}>קריאות Gemini היום</div>
          </div>
          <div>
            <div style={{ fontSize: "26px", fontWeight: "700" }}>≈ {aiCallsMonth}</div>
            <div style={{ color: "#666", fontSize: "13px" }}>קריאות Gemini החודש</div>
          </div>
        </div>
        <div style={{ fontSize: "11px", color: "#aaa", marginTop: "8px" }}>
          ספירה מקורבת של קריאות בפועל ל‑Gemini (לא כולל הודעות שסוננו לפני קריאה). בדיקות מעמוד &quot;בדיקת AI&quot; אינן נספרות.
        </div>
      </div>

      {/* ── System Health ─────────────────────────────────────── */}
      <div
        style={{
          border: "1px solid #e0e0e0",
          borderRadius: "8px",
          padding: "14px 20px",
          marginBottom: "24px",
        }}
      >
        <div style={{ fontWeight: "600", fontSize: "14px", marginBottom: "10px" }}>מצב מערכת</div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "12px 24px" }}>
          <HealthItem
            label="שירותים פעילים"
            ok={(s.count ?? 0) > 0}
            okText={`${s.count ?? 0} שירות${(s.count ?? 0) !== 1 ? "ים" : ""}`}
            badText="אין שירותים — לקוחות לא יוכלו לקבוע תור"
            link="/dashboard/services"
          />
          <HealthItem
            label="שעות פעילות"
            ok={(h.count ?? 0) > 0}
            okText="מוגדרות"
            badText="לא מוגדרות — ברירת מחדל 09:00–18:00"
            link="/dashboard/business-hours"
          />
          <HealthItem
            label="אזור זמן"
            ok={profileDone}
            okText={biz?.timezone ?? ""}
            badText="לא הוגדר — שגיאות בשעת תורים אפשריות"
            link="/dashboard/business-settings"
          />
          <HealthItem
            label="WhatsApp"
            ok={whatsappConnected && !waAuthFailed}
            okText={waDegraded ? "מחובר (תקלות שליחה)" : "מחובר"}
            badText={waAuthFailed ? "אימות נכשל — חדש את טוקן Meta" : "לא מוגדר — ה‑bot לא פעיל"}
            link={null}
          />
        </div>
      </div>

      {/* ── Activity shortcut ────────────────────────────────── */}
      <a
        href="/dashboard/activity"
        style={{
          display: "inline-block",
          fontSize: "14px",
          color: "#0070f3",
          textDecoration: "none",
          padding: "8px 16px",
          border: "1px solid #b3d4ff",
          borderRadius: "6px",
          background: "#fff",
        }}
      >
        צפה בפעילות אחרונה →
      </a>
    </div>
  );
}

function HealthItem({
  label,
  ok,
  okText,
  badText,
  link,
}: {
  label: string;
  ok: boolean;
  okText: string;
  badText: string;
  link: string | null;
}) {
  const content = (
    <div style={{ minWidth: "180px" }}>
      <div style={{ fontSize: "11px", color: "#888", marginBottom: "2px" }}>{label}</div>
      <div
        style={{
          fontSize: "13px",
          fontWeight: "500",
          color: ok ? "#198754" : "#dc3545",
          display: "flex",
          alignItems: "center",
          gap: "4px",
        }}
      >
        {ok ? "✓" : "⚠"} {ok ? okText : badText}
      </div>
    </div>
  );

  return link && !ok ? (
    <a href={link} style={{ textDecoration: "none" }}>{content}</a>
  ) : (
    content
  );
}
