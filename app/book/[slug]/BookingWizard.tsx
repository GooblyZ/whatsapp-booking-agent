"use client";

import { useCallback, useState, useTransition } from "react";
import type { PlatformService } from "@/lib/booking/platform";
import type { DayOption } from "@/lib/booking/day-options";
import { fetchDaySlotsAction, createBookingAction } from "./actions";
import styles from "./booking.module.css";

interface Props {
  slug: string;
  services: PlatformService[];
  days: DayOption[];
  initialPhone: string;
}

type Step = "service" | "time" | "details" | "done";

export default function BookingWizard({ slug, services, days, initialPhone }: Props) {
  const [step, setStep] = useState<Step>("service");
  const [service, setService] = useState<PlatformService | null>(services.length === 1 ? services[0] : null);
  const [dateISO, setDateISO] = useState(days[0]?.dateISO ?? "");
  const [slots, setSlots] = useState<string[] | null>(null);
  const [time, setTime] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState(initialPhone);
  const [error, setError] = useState<string | null>(null);
  const [manageUrl, setManageUrl] = useState<string | null>(null);
  const [loadingSlots, setLoadingSlots] = useState(false);
  const [submitting, startSubmit] = useTransition();

  const loadSlots = useCallback(
    async (svc: PlatformService, day: string) => {
      setLoadingSlots(true);
      setSlots(null);
      setTime(null);
      const res = await fetchDaySlotsAction(slug, svc.id, day);
      setSlots(res.ok ? res.slots : []);
      setLoadingSlots(false);
    },
    [slug]
  );

  const pickService = (svc: PlatformService) => {
    setService(svc);
    setError(null);
    setStep("time");
    void loadSlots(svc, dateISO);
  };

  const pickDay = (day: string) => {
    if (day === dateISO && slots !== null) return;
    setDateISO(day);
    if (service) void loadSlots(service, day);
  };

  const submit = () => {
    if (!service || !time) return;
    setError(null);
    startSubmit(async () => {
      const res = await createBookingAction({ slug, serviceId: service.id, dateISO, time, name, phone });
      if (res.ok) {
        setManageUrl(res.manageUrl);
        setStep("done");
        return;
      }
      switch (res.code) {
        case "invalid_name":
          setError("נראה שהשם לא תקין — אפשר לכתוב שם בעברית או באנגלית (2 תווים לפחות).");
          break;
        case "invalid_phone":
          setError("מספר הטלפון לא נראה תקין — אפשר לבדוק ולנסות שוב?");
          break;
        case "slot_taken":
          setError("השעה הזו בדיוק נתפסה. אפשר לבחור שעה אחרת:");
          setSlots(res.freshSlots ?? []);
          setTime(null);
          setStep("time");
          break;
        default:
          setError("משהו השתבש אצלנו. אפשר לנסות שוב בעוד רגע.");
      }
    });
  };

  const dayLabel = days.find((d) => d.dateISO === dateISO);
  const detailRows: Array<[string, string]> = service && time && dayLabel
    ? [
        ["שירות", service.name],
        ["מתי", `${dayLabel.label}, ${dayLabel.sub}`],
        ["שעה", time],
        ...(service.price != null ? [["מחיר", `₪${Number(service.price).toFixed(0)}`] as [string, string]] : []),
      ]
    : [];

  if (step === "done") {
    return (
      <div className={styles.success} role="status">
        <div className={styles.successIcon} aria-hidden>✓</div>
        <h2 className={styles.successTitle}>התור נקבע!</h2>
        <DetailCard rows={detailRows} />
        <p className={styles.successHint}>שלחנו אישור בוואטסאפ עם כל הפרטים.</p>
        {manageUrl && (
          <a className={styles.secondaryBtn} href={manageUrl}>
            צפייה, שינוי או ביטול
          </a>
        )}
      </div>
    );
  }

  return (
    <div>
      <Steps current={step} />

      {step === "service" && (
        <section aria-label="בחירת שירות">
          <h2 className={styles.stepTitle}>איזה שירות?</h2>
          <ul className={styles.serviceList}>
            {services.map((s) => (
              <li key={s.id}>
                <button type="button" className={styles.serviceCard} onClick={() => pickService(s)}>
                  <span className={styles.serviceMain}>
                    <span className={styles.serviceName}>{s.name}</span>
                    <span className={styles.serviceMeta}>
                      {s.duration_minutes} דק׳
                      {s.price != null && ` · ₪${Number(s.price).toFixed(0)}`}
                    </span>
                    {s.description && <span className={styles.serviceDesc}>{s.description}</span>}
                  </span>
                  <span className={styles.chevron} aria-hidden>‹</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {step === "time" && service && (
        <section aria-label="בחירת מועד">
          <button type="button" className={styles.backLink} onClick={() => setStep("service")}>
            ‹ {service.name}
          </button>
          <h2 className={styles.stepTitle}>מתי נוח?</h2>

          <div className={styles.dayScroller} role="tablist" aria-label="בחירת יום">
            {days.map((d) => (
              <button
                key={d.dateISO}
                type="button"
                role="tab"
                aria-selected={d.dateISO === dateISO}
                className={d.dateISO === dateISO ? styles.dayChipActive : styles.dayChip}
                onClick={() => pickDay(d.dateISO)}
              >
                <span className={styles.dayChipLabel}>{d.label}</span>
                <span className={styles.dayChipSub}>{d.sub}</span>
              </button>
            ))}
          </div>

          {error && <p className={styles.errorNote} role="alert">{error}</p>}

          <div aria-live="polite" aria-busy={loadingSlots}>
            <span className={styles.srOnly}>
              {loadingSlots ? "טוען שעות פנויות" : slots === null ? "" : slots.length === 0 ? "אין שעות פנויות ביום שנבחר" : `${slots.length} שעות פנויות`}
            </span>

            {loadingSlots && (
              <div className={styles.slotGrid} aria-hidden>
                {Array.from({ length: 8 }).map((_, i) => <span key={i} className={styles.slotSkeleton} />)}
              </div>
            )}

            {!loadingSlots && slots !== null && slots.length === 0 && (
              <p className={styles.emptyState}>
                אין שעות פנויות ביום הזה.<br />אפשר לבחור יום אחר מהרשימה למעלה.
              </p>
            )}

            {!loadingSlots && slots !== null && slots.length > 0 && (
              <div className={styles.slotGrid} role="group" aria-label="שעות פנויות">
                {slots.map((t) => (
                  <button
                    key={t}
                    type="button"
                    className={t === time ? styles.slotChipActive : styles.slotChip}
                    onClick={() => { setTime(t); setError(null); setStep("details"); }}
                  >
                    {t}
                  </button>
                ))}
              </div>
            )}
          </div>
        </section>
      )}

      {step === "details" && service && time && (
        <section aria-label="פרטים ואישור">
          <button type="button" className={styles.backLink} onClick={() => { setStep("time"); setError(null); }}>
            ‹ שינוי מועד
          </button>
          <h2 className={styles.stepTitle}>כמעט סיימנו</h2>

          <DetailCard rows={detailRows} />

          <form
            className={styles.form}
            onSubmit={(e) => { e.preventDefault(); submit(); }}
          >
            <label className={styles.label}>
              שם מלא
              <input
                className={styles.input}
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoComplete="name"
                required
                minLength={2}
                maxLength={50}
              />
            </label>
            <label className={styles.label}>
              טלפון נייד
              <input
                className={styles.input}
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                type="tel"
                inputMode="tel"
                autoComplete="tel"
                dir="ltr"
                placeholder="050-1234567"
                required
              />
            </label>

            {error && <p className={styles.errorNote} role="alert">{error}</p>}

            <button type="submit" className={styles.primaryBtn} disabled={submitting}>
              {submitting ? "קובעים את התור…" : "אישור וקביעת התור"}
            </button>
            <p className={styles.finePrint}>אישור והתזכורות יישלחו בוואטסאפ למספר הזה.</p>
          </form>
        </section>
      )}
    </div>
  );
}

/** Labeled, tabular detail rows — used in both the confirm step and success. */
function DetailCard({ rows }: { rows: Array<[string, string]> }) {
  if (rows.length === 0) return null;
  return (
    <dl className={styles.detailCard}>
      {rows.map(([k, v]) => (
        <div key={k} className={styles.detailRow}>
          <dt className={styles.detailKey}>{k}</dt>
          <dd className={styles.detailVal}>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function Steps({ current }: { current: Step }) {
  const items: Array<{ key: Step; label: string }> = [
    { key: "service", label: "שירות" },
    { key: "time", label: "מועד" },
    { key: "details", label: "אישור" },
  ];
  const order: Step[] = ["service", "time", "details"];
  const idx = order.indexOf(current);
  return (
    <ol className={styles.steps} aria-label="שלבי הקביעה">
      {items.map((it, i) => (
        <li
          key={it.key}
          className={i < idx ? styles.stepDone : i === idx ? styles.stepActive : styles.stepIdle}
          aria-current={i === idx ? "step" : undefined}
        >
          {it.label}
        </li>
      ))}
    </ol>
  );
}
