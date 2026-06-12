export const dynamic = "force-dynamic";

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { supabaseServer } from "@/lib/supabase/server";
import { getBusinessBySlug, listBookableServices } from "@/lib/booking/platform";
import { buildDayOptions } from "@/lib/booking/day-options";
import BookingWizard from "./BookingWizard";
import styles from "./booking.module.css";

interface PageProps {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ p?: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const db = supabaseServer();
  const business = await getBusinessBySlug(db, slug);
  return { title: business ? `קביעת תור — ${business.name}` : "קביעת תור" };
}

export default async function BookingPage({ params, searchParams }: PageProps) {
  const { slug } = await params;
  const { p } = await searchParams;
  const db = supabaseServer();

  const business = await getBusinessBySlug(db, slug);
  if (!business) notFound();

  const services = await listBookableServices(db, business.id);
  const days = buildDayOptions(business.timezone);

  return (
    <main className={styles.page} dir="rtl" lang="he">
      <div className={styles.card}>
        <header className={styles.header}>
          <h1 className={styles.businessName}>{business.name}</h1>
          <p className={styles.subtitle}>קביעת תור אונליין</p>
        </header>
        {services.length === 0 ? (
          <p className={styles.emptyState}>
            אין כרגע שירותים זמינים לקביעת תור. אפשר ליצור קשר ישירות עם העסק.
          </p>
        ) : (
          <BookingWizard
            slug={business.slug}
            services={services}
            days={days}
            initialPhone={typeof p === "string" ? p : ""}
          />
        )}
      </div>
      <footer className={styles.footer}>מופעל על ידי המערכת של {business.name}</footer>
    </main>
  );
}
