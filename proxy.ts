import { NextRequest, NextResponse } from "next/server";

// Dashboard password gate.
// If DASHBOARD_ACCESS_PASSWORD is set, all /dashboard routes (except /dashboard/login)
// require a valid session cookie. If the env var is not set, all requests pass through
// and the dashboard layout shows a warning banner instead.

export function proxy(req: NextRequest) {
  const password = process.env.DASHBOARD_ACCESS_PASSWORD;
  if (!password) return NextResponse.next(); // Dev mode: no password configured.

  const expected = btoa(password);
  const session = req.cookies.get("dashboard_session");

  if (session?.value === expected) return NextResponse.next();

  const loginUrl = req.nextUrl.clone();
  loginUrl.pathname = "/login";
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: ["/dashboard", "/dashboard/:path*"],
};
