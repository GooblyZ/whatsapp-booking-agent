export const dynamic = "force-dynamic";

import { supabaseServer } from "@/lib/supabase/server";
import { getDefaultBusinessId } from "@/lib/config";
import { getRecentAIEvents } from "@/lib/ai/events";

// Maps an ai_events response_type to a human title for the feed.
const AI_EVENT_TITLES: Record<string, string> = {
  conversation:      "🤖 שיחה טבעית",
  faq_answer:        "🤖 מענה לשאלה",
  booking_intent:    "🤖 שיחה על קביעת תור",
  booking_handoff:   "🤖 מעבר לתהליך קביעת תור",
  cancel_reschedule: "🤖 בקשת ביטול / שינוי תור",
  irrelevant:        "🤖 הודעה לא רלוונטית — הופנתה חזרה",
  unknown:           "🤖 הודעה לא ברורה",
  noise:             "🤖 הודעה קצרה / לא תקינה",
  abuse:             "🤖 הודעה לא הולמת",
  grounding_failed:  "🤖 תשובה נחסמה (אימות עובדות)",
  ai_disabled:       "🤖 AI מושבת",
  not_configured:    "🤖 AI לא מוגדר",
  error:             "🤖 שגיאת AI",
  // legacy
  booking_confirm:   "🤖 זוהתה כוונת קביעת תור",
  booking_clarify:   "🤖 כוונת תור — נדרשת הבהרה",
  booking_disabled:  "🤖 בקשת תור — קביעת תורים מושבתת",
  greeting:          "🤖 ברכת שלום",
};

const STATUS_LABELS: Record<string, string> = {
  pending:   "ממתין",
  confirmed: "אושר",
  cancelled: "בוטל",
  completed: "הושלם",
  no_show:   "לא הגיע",
};

const STATUS_COLORS: Record<string, string> = {
  pending:   "#d97706",
  confirmed: "#198754",
  cancelled: "#dc3545",
  completed: "#555",
  no_show:   "#888",
};

function maskPhone(phone: string | null | undefined): string {
  if (!phone) return "—";
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 4) return "****";
  return "*".repeat(Math.max(0, digits.length - 4)) + digits.slice(-4);
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60_000);
  if (m < 2)   return "לפני רגע";
  if (m < 60)  return `לפני ${m} דקות`;
  const h = Math.floor(m / 60);
  if (h < 24)  return `לפני ${h} שעות`;
  const d = Math.floor(h / 24);
  return `לפני ${d} ימים`;
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString("he-IL", {
    day: "2-digit",
    month: "2-digit",
    year: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

interface FeedEvent {
  id:        string;
  type:      "message" | "appointment" | "ai";
  createdAt: string;
  title:     string;
  subtitle:  string;
  badge?:    string;
  badgeColor?: string;
}

export default async function ActivityPage() {
  const db         = supabaseServer();
  const businessId = getDefaultBusinessId();

  const [messagesResult, appointmentsResult, aiEvents] = await Promise.all([
    db
      .from("messages")
      .select("id, direction, body, from_phone, created_at")
      .eq("business_id", businessId)
      .order("created_at", { ascending: false })
      .limit(30),
    db
      .from("appointments")
      .select("id, status, start_time, created_at, services(name), customers(phone)")
      .eq("business_id", businessId)
      .order("created_at", { ascending: false })
      .limit(20),
    getRecentAIEvents(businessId, 30),
  ]);

  const msgEvents: FeedEvent[] = (messagesResult.data ?? []).map((msg) => {
    const masked   = maskPhone(msg.from_phone as string | null);
    const dir      = (msg.direction as string) === "inbound" ? "נכנסת" : "יוצאת";
    const preview  = ((msg.body as string) ?? "").slice(0, 60);
    return {
      id:        `msg-${msg.id as string}`,
      type:      "message",
      createdAt: msg.created_at as string,
      title:     `הודעה ${dir} — ${masked}`,
      subtitle:  preview ? `"${preview}${preview.length === 60 ? "…" : ""}"` : "(ללא טקסט)",
      badge:     dir,
      badgeColor: (msg.direction as string) === "inbound" ? "#0070f3" : "#6c757d",
    };
  });

  const apptEvents: FeedEvent[] = (appointmentsResult.data ?? []).map((appt) => {
    const svc    = (appt.services as { name?: string } | null)?.name ?? "שירות לא ידוע";
    const phone  = maskPhone((appt.customers as { phone?: string } | null)?.phone);
    const status = appt.status as string;
    const slot   = appt.start_time ? formatDateTime(appt.start_time as string) : "—";
    return {
      id:         `appt-${appt.id as string}`,
      type:       "appointment",
      createdAt:  appt.created_at as string,
      title:      `תור — ${svc} — ${phone}`,
      subtitle:   `מועד: ${slot}`,
      badge:      STATUS_LABELS[status] ?? status,
      badgeColor: STATUS_COLORS[status] ?? "#555",
    };
  });

  const aiFeedEvents: FeedEvent[] = aiEvents.map((ev) => {
    const rt = ev.response_type ?? "unknown";
    const conf = ev.confidence != null ? ` · confidence=${Number(ev.confidence).toFixed(2)}` : "";
    const calledNote = ev.called ? "" : " · ללא קריאת AI";
    return {
      id:         `ai-${ev.id}`,
      type:       "ai",
      createdAt:  ev.created_at,
      title:      AI_EVENT_TITLES[rt] ?? `🤖 ${rt}`,
      subtitle:   `intent=${ev.intent ?? "—"}${conf}${calledNote}`,
      badge:      ev.success ? (ev.intent ?? "AI") : "שגיאה",
      badgeColor: ev.success ? "#7c3aed" : "#dc3545",
    };
  });

  const feed: FeedEvent[] = [...msgEvents, ...apptEvents, ...aiFeedEvents]
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    .slice(0, 50);

  return (
    <div>
      <h1 style={{ marginBottom: "6px" }}>פעילות אחרונה</h1>
      <p style={{ color: "#666", marginTop: 0, marginBottom: "20px", fontSize: "14px" }}>
        הודעות WhatsApp, תורים ופעילות AI — 50 האחרונים.
      </p>

      {feed.length === 0 && (
        <p style={{ color: "#888" }}>אין פעילות עדיין. שלח הודעת WhatsApp לבדיקה.</p>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: "0" }}>
        {feed.map((event, idx) => (
          <div
            key={event.id}
            style={{
              display: "flex",
              gap: "12px",
              alignItems: "flex-start",
              padding: "12px 0",
              borderBottom: idx < feed.length - 1 ? "1px solid #f0f0f0" : "none",
            }}
          >
            {/* Icon */}
            <div
              style={{
                flexShrink: 0,
                width: "32px",
                height: "32px",
                borderRadius: "50%",
                background:
                  event.type === "message" ? "#e8f0fe"
                  : event.type === "ai" ? "#f3e8ff"
                  : "#e8f5e9",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: "14px",
              }}
            >
              {event.type === "message" ? "💬" : event.type === "ai" ? "🤖" : "📅"}
            </div>

            {/* Content */}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div
                style={{
                  fontSize: "14px",
                  fontWeight: "500",
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                {event.title}
              </div>
              <div style={{ fontSize: "13px", color: "#666", marginTop: "2px" }}>
                {event.subtitle}
              </div>
            </div>

            {/* Badge + time */}
            <div
              style={{
                flexShrink: 0,
                display: "flex",
                flexDirection: "column",
                alignItems: "flex-end",
                gap: "4px",
              }}
            >
              {event.badge && (
                <span
                  style={{
                    fontSize: "11px",
                    padding: "2px 7px",
                    borderRadius: "4px",
                    background: `${event.badgeColor}18`,
                    color: event.badgeColor,
                    fontWeight: "600",
                    whiteSpace: "nowrap",
                  }}
                >
                  {event.badge}
                </span>
              )}
              <span style={{ fontSize: "11px", color: "#aaa", whiteSpace: "nowrap" }}>
                {relativeTime(event.createdAt)}
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
