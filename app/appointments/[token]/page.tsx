export const dynamic = "force-dynamic";

import type { Metadata } from "next";
import Link from "next/link";
import { supabaseServer } from "@/lib/supabase/server";
import { verifyCustomerToken } from "@/lib/booking/appointment-token";
import { listUpcomingByCustomer } from "@/lib/booking/appointments";
import { buildBookingLink } from "@/lib/config";
import styles from "../../book/[slug]/booking.module.css";

export const metadata: Metadata = { title: "התורים שלי" };

const STATUS_HE: Record<string, string> = { confirmed: "מאושר", pending: "ממתין לאישור" };

interface PageProps {
  params: Promise<{ token: string }>;
}

export default async function MyAppointmentsPage({ params }: PageProps) {
  const { token } = await params;
  const customerId = verifyCustomerToken(token);

  const db = supabaseServer();
  const cust = customerId
    ? (
        await db
          .from("customers")
          .select("business_id, businesses(name, slug, timezone)")
          .eq("id", customerId)
          .maybeSingle()
      ).data as { business_id: string; businesses: { name: string; slug: string; timezone: string } | null } | null
    : null;

  if (!customerId || !cust?.businesses) {
    return (
      <main className={styles.page} dir="rtl" lang="he">
        <div className={styles.card}>
          <p className={styles.emptyState}>
            הקישור אינו תקין או שפג תוקפו. אפשר לבקש מאיתנו קישור חדש בוואטסאפ.
          </p>
        </div>
      </main>
    );
  }

  const business = cust.businesses;
  const tz = business.timezone || "Asia/Jerusalem";
  const appts = await listUpcomingByCustomer(db, cust.business_id, customerId, 20);

  const dateFmt = new Intl.DateTimeFormat("he-IL", { timeZone: tz, weekday: "short", day: "2-digit", month: "2-digit" });
  const timeFmt = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false });

  return (
    <main className={styles.page} dir="rtl" lang="he">
      <div className={styles.card}>
        <header className={styles.header}>
          <div className={styles.monogram} aria-hidden>
            {business.name.trim().charAt(0) || "✦"}
          </div>
          <h1 className={styles.businessName}>{business.name}</h1>
          <p className={styles.subtitle}>התורים שלי</p>
        </header>

        {appts.length === 0 ? (
          <div className={styles.emptyState}>
            <p>אין לך תורים קרובים כרגע.</p>
            <Link className={styles.secondaryBtn} href={buildBookingLink(business.slug)} style={{ marginTop: 12 }}>
              לקביעת תור חדש
            </Link>
          </div>
        ) : (
          <>
            <h2 className={styles.stepTitle}>התורים הקרובים שלך</h2>
            <ul className={styles.serviceList}>
              {appts.map((a) => {
                const d = new Date(a.startTime);
                return (
                  <li key={a.id}>
                    <Link className={styles.serviceCard} href={`/appointment/${a.id}`}>
                      <span className={styles.serviceMain}>
                        <span className={styles.serviceName}>{a.serviceName ?? "תור"}</span>
                        <span className={styles.serviceMeta}>
                          {dateFmt.format(d)} · {timeFmt.format(d)} · {STATUS_HE[a.status] ?? a.status}
                        </span>
                      </span>
                      <span className={styles.chevron} aria-hidden>‹</span>
                    </Link>
                  </li>
                );
              })}
            </ul>
            <p className={styles.footer}>בחרו תור כדי לצפות, לשנות מועד או לבטל.</p>
          </>
        )}
      </div>
    </main>
  );
}
