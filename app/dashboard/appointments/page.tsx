export const dynamic = "force-dynamic";

import { supabaseServer } from "@/lib/supabase/server";
import { getDefaultBusinessId } from "@/lib/config";
import { businessTimeToUTC, todayInTZ, formatTimeInTZ } from "@/lib/booking/availability";
import {
  filterAppointmentsForView,
  isActiveAppointment,
  type AppointmentView,
} from "@/lib/booking/appointment-views";
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

function sourceLabel(s: string | null): string {
  return { whatsapp: "וואטסאפ", dashboard: "דשבורד", manual: "ידני", system: "מערכת" }[s ?? ""] ?? (s ?? "—");
}

function badgeStyle(bg: string, color: string): React.CSSProperties {
  return {
    display: "inline-block",
    padding: "2px 8px",
    borderRadius: "12px",
    fontSize: "12px",
    fontWeight: "600",
    background: bg,
    color,
    whiteSpace: "nowrap",
  };
}

/**
 * Status chip for a row. `מאושר` / `ממתין` are shown ONLY for currently-active appointments; a row
 * whose status is still open (pending/confirmed) but whose time has passed the active grace window
 * (the cron hasn't auto-completed it yet) is shown as the neutral `עבר` — never `מאושר` — so the badge
 * stays honest. Terminal statuses always show their own label.
 */
function statusChip(row: AppRow, now: Date): React.CSSProperties & { _label: string } {
  let label: string, bg: string, color: string;
  switch (row.status) {
    case "completed": label = "בוצע";   bg = "#cce5ff"; color = "#004085"; break;
    case "cancelled": label = "בוטל";   bg = "#f8d7da"; color = "#721c24"; break;
    case "no_show":   label = "לא הגיע"; bg = "#e2e3e5"; color = "#41464b"; break;
    default:
      if (isActiveAppointment(row, now)) {
        if (row.status === "confirmed") { label = "מאושר"; bg = "#d4edda"; color = "#155724"; }
        else                            { label = "ממתין"; bg = "#fff3cd"; color = "#856404"; }
      } else {
        // open status but past the grace window — neutral "passed", not מאושר/ממתין.
        label = "עבר"; bg = "#e0e0e0"; color = "#555";
      }
  }
  return { ...badgeStyle(bg, color), _label: label };
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
  searchParams: Promise<{ filter?: string; view?: string }>;
}) {
  const sp     = await searchParams;
  const view: AppointmentView = sp.view === "history" ? "history" : "active";
  const filter = ["today", "week", "all"].includes(sp.filter ?? "") ? sp.filter! : "week";

  const db         = supabaseServer();
  const businessId = getDefaultBusinessId();

  // Fetch business timezone
  const { data: bizData } = await db
    .from("businesses")
    .select("timezone")
    .eq("id", businessId)
    .single();
  const timezone = (bizData?.timezone as string) || "Asia/Jerusalem";

  // ONE broad fetch (most-recent-first), then classify in code via the pure helpers. Future/active rows
  // sort to the TOP of a start_time-desc fetch, so the 500-row cap only ever truncates the OLDEST history
  // — never active or recent records. Nothing is deleted; history rows stay in the DB.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const query: any = db
    .from("appointments")
    .select("id, start_time, end_time, status, source, customers ( name, phone ), services ( name )")
    .eq("business_id", businessId)
    .order("start_time", { ascending: false })
    .limit(500);

  const { data } = await query;
  const all  = (data ?? []) as AppRow[];
  const now  = new Date();

  // Partition once (counts come from the full sets, independent of the active date sub-filter).
  const activeAll  = filterAppointmentsForView(all, "active",  now);
  const historyAll = filterAppointmentsForView(all, "history", now);

  let rows: AppRow[];
  if (view === "active") {
    // Active is soonest-first and scoped by the date sub-filter (today / week / all).
    const { from, to } = getFilterRange(filter, timezone);
    rows = activeAll
      .filter((r) => {
        const t = new Date(r.start_time).getTime();
        if (from && t < from.getTime()) return false;
        if (to   && t > to.getTime())   return false;
        return true;
      })
      .sort((a, b) => new Date(a.start_time).getTime() - new Date(b.start_time).getTime());
  } else {
    // History is newest-first (already descending from the fetch).
    rows = historyAll;
  }

  const VIEWS = [
    { key: "active",  label: "פעילים",   count: activeAll.length  },
    { key: "history", label: "היסטוריה", count: historyAll.length },
  ];
  const FILTERS = [
    { key: "today", label: "היום" },
    { key: "week",  label: "השבוע" },
    { key: "all",   label: "הכל" },
  ];

  return (
    <div>
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
        <h1 style={{ margin: 0 }}>תורים</h1>

        {/* View tabs: פעילים / היסטוריה */}
        <div style={{ display: "flex", gap: "8px" }}>
          {VIEWS.map((v) => (
            <a
              key={v.key}
              href={`/dashboard/appointments?view=${v.key}`}
              style={{
                padding: "6px 16px",
                borderRadius: "4px",
                fontSize: "14px",
                textDecoration: "none",
                background: view === v.key ? "#0070f3" : "#fff",
                color:      view === v.key ? "#fff"    : "#333",
                border:     view === v.key ? "1px solid #0070f3" : "1px solid #ccc",
                fontWeight: view === v.key ? "600" : "400",
              }}
            >
              {v.label} ({v.count})
            </a>
          ))}
        </div>
      </div>

      {/* Date sub-filters — only inside the active view */}
      {view === "active" && (
        <div style={{ display: "flex", gap: "8px", marginBottom: "20px" }}>
          {FILTERS.map((f) => (
            <a
              key={f.key}
              href={`/dashboard/appointments?view=active&filter=${f.key}`}
              style={{
                padding: "4px 14px",
                borderRadius: "4px",
                fontSize: "13px",
                textDecoration: "none",
                background: filter === f.key ? "#eaf3ff" : "#fff",
                color:      filter === f.key ? "#0070f3" : "#666",
                border:     filter === f.key ? "1px solid #0070f3" : "1px solid #ddd",
                fontWeight: filter === f.key ? "600" : "400",
              }}
            >
              {f.label}
            </a>
          ))}
        </div>
      )}

      {/* Empty state */}
      {rows.length === 0 && (
        <p style={{ color: "#666", textAlign: "center", padding: "48px 0" }}>
          {view === "active"
            ? (filter === "all" ? "אין תורים פעילים כרגע." : "אין תורים פעילים בטווח הנבחר.")
            : "אין תורים בהיסטוריה."}
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
                {view === "active" && <th style={{ ...thStyle, textAlign: "left" }}>פעולות</th>}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const startDate = new Date(row.start_time);
                const chip      = statusChip(row, now);
                const { _label, ...chipStyle } = chip;
                // Operational actions only in the active view, and only for still-open rows.
                const canAct = view === "active" && (row.status === "pending" || row.status === "confirmed");
                const dim    = row.status === "cancelled" || row.status === "no_show";

                return (
                  <tr key={row.id} style={{ opacity: dim ? 0.55 : 1 }}>
                    <td style={tdStyle}>{formatDateInTZ(row.start_time, timezone)}</td>
                    <td style={{ ...tdStyle, fontWeight: "600" }}>{formatTimeInTZ(startDate, timezone)}</td>
                    <td style={tdStyle}>{row.customers?.name ?? "—"}</td>
                    <td style={{ ...tdStyle, direction: "ltr", textAlign: "right" }}>{row.customers?.phone ?? "—"}</td>
                    <td style={tdStyle}>{row.services?.name ?? "—"}</td>
                    <td style={tdStyle}>
                      <span style={chipStyle}>{_label}</span>
                    </td>
                    <td style={tdStyle}>{sourceLabel(row.source)}</td>
                    {view === "active" && (
                      <td style={{ ...tdStyle, textAlign: "left" }}>
                        {canAct && (
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
                    )}
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
