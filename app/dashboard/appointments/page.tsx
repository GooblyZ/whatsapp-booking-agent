export const dynamic = "force-dynamic";

import { supabaseServer } from "@/lib/supabase/server";
import { getDefaultBusinessId } from "@/lib/config";
import { businessTimeToUTC, todayInTZ, formatTimeInTZ } from "@/lib/booking/availability";
import { updateAppointmentStatusAction } from "./actions";

// ── Types ─────────────────────────────────────────────────────

type AppRow = {
  id: string;
  start_time: string;
  end_time: string | null;
  status: string;
  source: string | null;
  customers: { name: string | null; phone: string } | null;
  services:  { name: string } | null;
};

// ── Helpers ───────────────────────────────────────────────────

function getFilterRange(filter: string, timezone: string): { from?: Date; to?: Date } {
  if (filter === "all") return {};

  const today = todayInTZ(timezone);
  const from  = businessTimeToUTC(today, "00:00", timezone);

  if (filter === "today") {
    return { from, to: businessTimeToUTC(today, "23:59", timezone) };
  }

  // "week" = next 7 days from today
  const [y, m, d] = today.split("-").map(Number);
  const endDate   = new Date(Date.UTC(y, m - 1, d + 6));
  const endStr    = endDate.toISOString().split("T")[0];
  return { from, to: businessTimeToUTC(endStr, "23:59", timezone) };
}

function formatDateInTZ(utcDateStr: string, timezone: string): string {
  return new Intl.DateTimeFormat("he-IL", {
    timeZone: timezone,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(new Date(utcDateStr));
}

function statusLabel(s: string): string {
  return { confirmed: "מאושר", pending: "ממתין", completed: "בוצע", cancelled: "בוטל" }[s] ?? s;
}

function sourceLabel(s: string | null): string {
  return { whatsapp: "וואטסאפ", dashboard: "דשבורד", manual: "ידני", system: "מערכת" }[s ?? ""] ?? (s ?? "—");
}

function statusBadgeStyle(s: string): React.CSSProperties {
  const map: Record<string, { bg: string; color: string }> = {
    confirmed: { bg: "#d4edda", color: "#155724" },
    pending:   { bg: "#fff3cd", color: "#856404" },
    completed: { bg: "#cce5ff", color: "#004085" },
    cancelled: { bg: "#f8d7da", color: "#721c24" },
  };
  const t = map[s] ?? { bg: "#e0e0e0", color: "#333" };
  return {
    display: "inline-block",
    padding: "2px 8px",
    borderRadius: "12px",
    fontSize: "12px",
    fontWeight: "600",
    background: t.bg,
    color: t.color,
    whiteSpace: "nowrap",
  };
}

// ── Styles ────────────────────────────────────────────────────

const btnSmall: React.CSSProperties = {
  padding: "4px 10px",
  border: "1px solid #ccc",
  borderRadius: "4px",
  cursor: "pointer",
  background: "#fff",
  fontSize: "12px",
};

const btnDanger: React.CSSProperties = {
  ...btnSmall,
  color: "#dc3545",
  borderColor: "#dc3545",
};

const thStyle: React.CSSProperties = {
  padding: "10px 12px",
  textAlign: "right",
  fontWeight: "600",
  fontSize: "13px",
  color: "#555",
  borderBottom: "2px solid #e0e0e0",
  whiteSpace: "nowrap",
};

const tdStyle: React.CSSProperties = {
  padding: "10px 12px",
  textAlign: "right",
  fontSize: "14px",
  borderBottom: "1px solid #f0f0f0",
  verticalAlign: "middle",
};

// ── Page ──────────────────────────────────────────────────────

export default async function AppointmentsPage({
  searchParams,
}: {
  searchParams: Promise<{ filter?: string }>;
}) {
  const { filter: raw } = await searchParams;
  const filter = ["today", "week", "all"].includes(raw ?? "") ? raw! : "week";

  const db         = supabaseServer();
  const businessId = getDefaultBusinessId();

  // Fetch business timezone
  const { data: bizData } = await db
    .from("businesses")
    .select("timezone")
    .eq("id", businessId)
    .single();
  const timezone = (bizData?.timezone as string) || "Asia/Jerusalem";

  // Date range for filter
  const { from, to } = getFilterRange(filter, timezone);

  // Build query
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let query: any = db
    .from("appointments")
    .select("id, start_time, end_time, status, source, customers ( name, phone ), services ( name )")
    .eq("business_id", businessId);

  if (from) query = query.gte("start_time", from.toISOString());
  if (to)   query = query.lte("start_time", to.toISOString());
  query = query.order("start_time", { ascending: filter !== "all" }).limit(500);

  const { data } = await query;
  const rows = (data ?? []) as AppRow[];

  // Filter label map
  const FILTERS = [
    { key: "today", label: "היום" },
    { key: "week",  label: "השבוע" },
    { key: "all",   label: "הכל" },
  ];

  return (
    <div>
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "20px" }}>
        <h1 style={{ margin: 0 }}>תורים</h1>

        {/* Filter tabs */}
        <div style={{ display: "flex", gap: "8px" }}>
          {FILTERS.map((f) => (
            <a
              key={f.key}
              href={`/dashboard/appointments?filter=${f.key}`}
              style={{
                padding: "6px 16px",
                borderRadius: "4px",
                fontSize: "14px",
                textDecoration: "none",
                background: filter === f.key ? "#0070f3" : "#fff",
                color:      filter === f.key ? "#fff"    : "#333",
                border:     filter === f.key ? "1px solid #0070f3" : "1px solid #ccc",
                fontWeight: filter === f.key ? "600" : "400",
              }}
            >
              {f.label}
            </a>
          ))}
        </div>
      </div>

      {/* Empty state */}
      {rows.length === 0 && (
        <p style={{ color: "#666", textAlign: "center", padding: "48px 0" }}>
          אין תורים להציג בטווח הנבחר.
        </p>
      )}

      {/* Table */}
      {rows.length > 0 && (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", direction: "rtl" }}>
            <thead>
              <tr style={{ background: "#fafafa" }}>
                <th style={thStyle}>תאריך</th>
                <th style={thStyle}>שעה</th>
                <th style={thStyle}>לקוח</th>
                <th style={thStyle}>טלפון</th>
                <th style={thStyle}>שירות</th>
                <th style={thStyle}>סטטוס</th>
                <th style={thStyle}>מקור</th>
                <th style={{ ...thStyle, textAlign: "left" }}>פעולות</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const startDate = new Date(row.start_time);
                const isActive  = !["completed", "cancelled"].includes(row.status);

                return (
                  <tr key={row.id} style={{ opacity: row.status === "cancelled" ? 0.55 : 1 }}>
                    <td style={tdStyle}>{formatDateInTZ(row.start_time, timezone)}</td>
                    <td style={{ ...tdStyle, fontWeight: "600" }}>{formatTimeInTZ(startDate, timezone)}</td>
                    <td style={tdStyle}>{row.customers?.name ?? "—"}</td>
                    <td style={{ ...tdStyle, direction: "ltr", textAlign: "right" }}>{row.customers?.phone ?? "—"}</td>
                    <td style={tdStyle}>{row.services?.name ?? "—"}</td>
                    <td style={tdStyle}>
                      <span style={statusBadgeStyle(row.status)}>{statusLabel(row.status)}</span>
                    </td>
                    <td style={tdStyle}>{sourceLabel(row.source)}</td>
                    <td style={{ ...tdStyle, textAlign: "left" }}>
                      {isActive && (
                        <div style={{ display: "flex", gap: "6px", justifyContent: "flex-start" }}>
                          <form action={updateAppointmentStatusAction}>
                            <input type="hidden" name="id"     value={row.id} />
                            <input type="hidden" name="status" value="completed" />
                            <button type="submit" style={btnSmall}>✓ בוצע</button>
                          </form>
                          <form action={updateAppointmentStatusAction}>
                            <input type="hidden" name="id"     value={row.id} />
                            <input type="hidden" name="status" value="cancelled" />
                            <button type="submit" style={btnDanger}>בטל</button>
                          </form>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Row count */}
      {rows.length > 0 && (
        <p style={{ color: "#999", fontSize: "13px", marginTop: "12px", textAlign: "left" }}>
          {rows.length} תורים
        </p>
      )}
    </div>
  );
}
