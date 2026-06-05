"use client";

import { useActionState } from "react";
import { deleteAdminBlockedTime } from "./actions";

export default function DeleteBlockedTimeButton({
  blockedTimeId,
}: {
  blockedTimeId: string;
}) {
  const [state, formAction, pending] = useActionState(deleteAdminBlockedTime, null);

  return (
    <div>
      <form action={formAction}>
        <input type="hidden" name="blockedTimeId" value={blockedTimeId} />
        <button
          type="submit"
          disabled={pending}
          className="text-xs text-red-600 hover:text-red-800 font-medium disabled:opacity-50"
        >
          {pending ? "Removing…" : "Remove"}
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
