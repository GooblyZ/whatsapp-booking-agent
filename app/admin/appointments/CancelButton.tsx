"use client";

import { useActionState } from "react";
import { cancelAdminAppointment } from "./actions";

export default function CancelButton({ appointmentId }: { appointmentId: string }) {
  const [state, formAction, pending] = useActionState(cancelAdminAppointment, null);

  return (
    <div>
      <form action={formAction}>
        <input type="hidden" name="appointmentId" value={appointmentId} />
        <button
          type="submit"
          disabled={pending}
          className="text-xs text-red-600 hover:text-red-800 font-medium disabled:opacity-50"
        >
          {pending ? "Cancelling…" : "Cancel"}
        </button>
      </form>
      {state?.error && (
        <p className="text-xs text-red-500 mt-1 max-w-[180px] leading-tight">
          {state.error}
        </p>
      )}
    </div>
  );
}
