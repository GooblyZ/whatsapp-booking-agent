"use client";

import { useState, useTransition } from "react";
import type { DayOption } from "@/lib/booking/day-options";
import { cancelAppointmentAction, rescheduleAppointmentAction, fetchManageSlotsAction } from "./actions";
import styles from "../../book/[slug]/booking.module.css";

interface Props {
  id: string;
  status: string;
  isFuture: boolean;
  days: DayOption[];
  bookAgainUrl: string;
}

const STATUS_HE: Record<string, string> = {
  confirmed: "מאושר",
  pending: "ממתין לאישור",
  cancelled: "בוטל",
  completed: "הסתיים",
  no_show: "לא הגיע",
};

type Mode = "view" | "reschedule" | "confirm_cancel" | "cancelled" | "rescheduled";

export default function ManagePanel({ id, status, isFuture, days, bookAgainUrl }: Props) {
  const [mode, setMode] = useState<Mode>("view");
  const [dateISO, setDateISO] = useState<string | null>(null);
  const [slots, setSlots] = useState<string[] | null>(null);
  const [loadingSlots, setLoadingSlots] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, startTransition] = useTransition();

  const changeable = isFuture && (status === "confirmed" || status === "pending");

  const pickDay = async (day: string) => {
    setDateISO(day);
    setLoadingSlots(true);
    setSlots(null);
    const res = await fetchManageSlotsAction(id, day);
    setSlots(res.ok ? res.slots : []);
    setLoadingSlots(false);
  };

  const doCancel = () => {
    setError(null);
    startTransition(async () => {
      const res = await cancelAppointmentAction(id);
      if (res.ok) setMode("cancelled");
      else setError("לא הצלחנו לבטל את התור. אפשר לנסות שוב או לפנות לעסק.");
    });
  };

  const doReschedule = (time: string) => {
    if (!dateISO) return;
    setError(null);
    startTransition(async () => {
      const res = await rescheduleAppointmentAction(id, dateISO, time);
      if (res.ok) {
        setMode("rescheduled");
      } else if (res.code === "slot_taken") {
        setError("השעה הזו בדיוק נתפסה — אפשר לבחור שעה אחרת.");
        setSlots(res.freshSlots ?? []);
      } else {
        setError("לא הצלחנו לעדכן את התור. אפשר לנסות שוב או לפנות לעסק.");
      }
    });
  };

  if (mode === "cancelled") {
    return (
      <div className={styles.success} role="status">
        <h2 className={styles.successTitle}>התור בוטל</h2>
        <p className={styles.successHint}>נשמח לראות אותך בפעם אחרת.</p>
        <a className={styles.secondaryBtn} href={bookAgainUrl}>קביעת תור חדש</a>
      </div>
    );
  }

  if (mode === "rescheduled") {
    return (
      <div className={styles.success} role="status">
        <div className={styles.successIcon} aria-hidden>✓</div>
        <h2 className={styles.successTitle}>התור עודכן!</h2>
        <p className={styles.successHint}>שלחנו לך אישור בוואטסאפ עם המועד החדש.</p>
        <button type="button" className={styles.secondaryBtn} onClick={() => window.location.reload()}>
          הצגת הפרטים המעודכנים
        </button>
      </div>
    );
  }

  return (
    <div>
      <p className={styles.finePrint}>סטטוס: {STATUS_HE[status] ?? status}</p>

      {error && <p className={styles.errorNote} role="alert">{error}</p>}

      {!changeable && (
        <p className={styles.emptyState}>
          {status === "cancelled" ? "התור הזה בוטל." : "התור הזה כבר אינו ניתן לשינוי."}
          {" "}
          <a href={bookAgainUrl}>אפשר לקבוע תור חדש כאן.</a>
        </p>
      )}

      {changeable && mode === "view" && (
        <div className={styles.form}>
          <button type="button" className={styles.primaryBtn} onClick={() => setMode("reschedule")}>
            שינוי מועד
          </button>
          <button type="button" className={styles.secondaryBtn} onClick={() => setMode("confirm_cancel")}>
            ביטול התור
          </button>
        </div>
      )}

      {changeable && mode === "confirm_cancel" && (
        <div className={styles.form}>
          <p className={styles.summaryBox}>לבטל את התור?</p>
          <button type="button" className={styles.primaryBtn} onClick={doCancel} disabled={busy}>
            {busy ? "מבטלים…" : "כן, לבטל את התור"}
          </button>
          <button type="button" className={styles.secondaryBtn} onClick={() => setMode("view")}>
            חזרה
          </button>
        </div>
      )}

      {changeable && mode === "reschedule" && (
        <section className={styles.pane} aria-label="בחירת מועד חדש">
          <button type="button" className={styles.backLink} onClick={() => { setMode("view"); setError(null); }}>
            › חזרה
          </button>
          <h2 className={styles.stepTitle}>לאיזה מועד לעבור?</h2>

          <div className={styles.dayScroller} role="tablist" aria-label="בחירת יום">
            {days.map((d) => (
              <button
                key={d.dateISO}
                type="button"
                role="tab"
                aria-selected={d.dateISO === dateISO}
                className={d.dateISO === dateISO ? styles.dayChipActive : styles.dayChip}
                onClick={() => void pickDay(d.dateISO)}
              >
                <span className={styles.dayChipLabel}>{d.label}</span>
                <span className={styles.dayChipSub}>{d.sub}</span>
              </button>
            ))}
          </div>

          {loadingSlots && (
            <div className={styles.slotGrid} aria-hidden>
              {Array.from({ length: 8 }).map((_, i) => <span key={i} className={styles.slotSkeleton} />)}
            </div>
          )}

          {!loadingSlots && slots !== null && slots.length === 0 && (
            <p className={styles.emptyState}>אין שעות פנויות ביום הזה — אפשר לבחור יום אחר.</p>
          )}

          {!loadingSlots && slots !== null && slots.length > 0 && (
            <div className={styles.slotGrid}>
              {slots.map((t) => (
                <button
                  key={t}
                  type="button"
                  className={styles.slotChip}
                  onClick={() => doReschedule(t)}
                  disabled={busy}
                >
                  {t}
                </button>
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
