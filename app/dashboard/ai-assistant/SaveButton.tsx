"use client";

import { useFormStatus } from "react-dom";

// Presentation-only submit button for the AI Settings form. It mirrors the plain server-rendered
// button's look and simply adds a pending state so the owner gets immediate feedback while the
// server action runs. useFormStatus() reads the enclosing <form>, so this MUST render inside it.
const btnPrimary: React.CSSProperties = {
  padding: "10px 20px", background: "#0070f3", color: "#fff", border: "none",
  borderRadius: "4px", fontSize: "14px", fontWeight: 600, marginTop: "18px",
};

export function SaveButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      aria-busy={pending}
      style={{ ...btnPrimary, opacity: pending ? 0.7 : 1, cursor: pending ? "wait" : "pointer" }}
    >
      {pending ? "שומר הגדרות..." : "שמור הגדרות"}
    </button>
  );
}
