"use client";

// Client component that wires up checkbox → time-input toggle behaviour
// on the business-hours page. Returns no DOM — pure side-effect via useEffect.

import { useEffect } from "react";

export function HoursToggle() {
  useEffect(() => {
    function syncDay(day: string, closed: boolean) {
      document
        .querySelectorAll<HTMLInputElement>(`[data-day-time="${day}"]`)
        .forEach((inp) => {
          inp.disabled = closed;
          inp.style.opacity = closed ? "0.35" : "1";
        });
      const row = document.querySelector<HTMLElement>(`[data-day="${day}"]`);
      if (row) row.style.background = closed ? "#fafafa" : "#fff";
    }

    const cleanup: Array<() => void> = [];

    document
      .querySelectorAll<HTMLInputElement>("[data-day-toggle]")
      .forEach((cb) => {
        const day = cb.getAttribute("data-day-toggle") ?? "";
        const handler = () => syncDay(day, cb.checked);
        cb.addEventListener("change", handler);
        cleanup.push(() => cb.removeEventListener("change", handler));
      });

    return () => cleanup.forEach((fn) => fn());
  }, []);

  return null;
}
