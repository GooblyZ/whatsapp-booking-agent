export const dynamic = "force-dynamic";

import type { Metadata } from "next";
import { supabaseServer } from "@/lib/supabase/server";
import { getAppointmentView } from "@/lib/booking/platform";
import { buildDayOptions } from "@/lib/booking/day-options";
import { buildBookingLink } from "@/lib/config";
import ManagePanel from "./ManagePanel";
import styles from "../../book/[slug]/booking.module.css";

export const metadata: Metadata = { title: "התור שלי" };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function AppointmentPage({ params }: PageProps) {
  const { id } = await params;
  const db = supabaseServer();
  const view = UUID_RE.test(id) ? await getAppointmentView(db, id) : null;

  if (!view) {
    return (
      <main className={styles.page} dir="rtl" lang="he">
        <div className={styles.card}>
          <p className={styles.emptyState}>לא מצאנו את התור הזה. ייתכן שהקישור שגוי או שהתור הוסר.</p>
        </div>
      </main>
    );
  }

  const days = buildDayOptions(view.business.timezone);
  const [, m, d] = view.dateISO.split("-");

  return (
    <main className={styles.page} dir="rtl" lang="he">
      <div className={styles.card}>
        <header className={styles.header}>
          <div className={styles.monogram} aria-hidden>
            {view.business.name.trim().charAt(0) || "✦"}
          </div>
          <h1 className={styles.businessName}>{view.business.name}</h1>
          <p className={styles.subtitle}>פרטי התור שלך</p>
        </header>

        <p className={styles.summaryBox}>
          {view.serviceName ?? "תור"} · {parseInt(d, 10)}/{parseInt(m, 10)} · {view.time}
          {view.customerName ? ` · ${view.customerName}` : ""}
        </p>

        <ManagePanel
          id={view.id}
          status={view.status}
          isFuture={view.isFuture}
          days={days}
          bookAgainUrl={buildBookingLink(view.business.slug)}
        />
      </div>
    </main>
  );
}
