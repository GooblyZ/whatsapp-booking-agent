"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";

export async function loginAction(formData: FormData): Promise<void> {
  const submitted = (formData.get("password") as string | null)?.trim() ?? "";
  const password = process.env.DASHBOARD_ACCESS_PASSWORD;

  if (!password) {
    // No password configured — redirect to dashboard directly.
    redirect("/dashboard");
  }

  if (submitted !== password) {
    redirect("/login?error=1");
  }

  const cookieStore = await cookies();
  cookieStore.set("dashboard_session", btoa(password), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 7, // 7 days
  });

  redirect("/dashboard");
}

export async function logoutAction(): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.delete("dashboard_session");
  redirect("/login");
}
